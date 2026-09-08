/**
 * Merge-aware read-modify-write for data/audit/gap-audit-checkpoint.json
 * (task #923 — the #893 race class, one file over).
 *
 * audit-show-review-gap.js used to call saveCheckpoint(wholeCheckpointObject)
 * from three places (per-show stamp, WE-alert hash update, blast-radius
 * rollback), unlocked except for the rollback call. Two overlapping runs —
 * the hourly cron and a local `--show=X` run, the exact scenario #893 already
 * burned once on the sibling show-review-gap.json — both read the same prior
 * checkpoint, both stamp their own show in their in-memory copy, and the
 * later whole-object write erases the other run's stamps for every show it
 * didn't touch. A lock alone does not fix this: a locked writer holding a
 * stale in-memory copy still overwrites the other run's fresh entries with
 * its own stale ones.
 *
 * The fix: never write more than the ids this call actually touched.
 * saveCheckpointEntries re-reads current state from disk under a lock, folds
 * in just those ids, and writes the result — so a concurrent run's stamps for
 * shows this call never looked at survive.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./file-lock');

function loadCheckpoint(checkpointPath) {
  try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) || {}; } catch { return {}; }
}

// Write-then-rename. A plain writeFileSync is not atomic: a concurrent reader
// (newsletter-preflight, another audit run) can observe a truncated file.
function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Pure merge: fold `entries` ({showId: entryObject | undefined}) into
 * `current` ({showId: entryObject}). A value of `undefined` deletes that id
 * (used by rollback for "never audited before this run — leave no stamp").
 * No I/O — the caller supplies `current`, already read under the lock.
 */
function mergeCheckpointEntries(current, entries) {
  const merged = { ...(current || {}) };
  for (const [id, value] of Object.entries(entries || {})) {
    if (value === undefined) delete merged[id];
    else merged[id] = value;
  }
  return merged;
}

/**
 * Merge-aware checkpoint write. Re-reads current state from disk under a lock
 * on `${checkpointPath}.lock`, applies only `entries` (this call's touched
 * show ids), and writes the merged result. Replaces the old
 * saveCheckpoint(wholeObject) call sites.
 *
 * @param {string} checkpointPath
 * @param {Object} entries  {showId: entryObject | undefined}
 */
function saveCheckpointEntries(checkpointPath, entries) {
  withFileLock(`${checkpointPath}.lock`, (held) => {
    if (!held) {
      console.error(`::warning::gap-audit-checkpoint save lock could not be acquired for ${checkpointPath} (assumed stale and broken, or lock dir unwritable) — the read-modify-write ran unprotected. A concurrent run could have lost data.`);
    }
    const current = loadCheckpoint(checkpointPath);
    const merged = mergeCheckpointEntries(current, entries);
    writeJsonAtomic(checkpointPath, merged);
  });
}

// BRO-392: a rollback always restores the PRE-quarantine (arbitrarily old)
// timestamp, so a chronically-risky show's checkpoint entry never advances —
// it permanently reads as "most overdue" (compareAuditPriority sorts oldest
// `at` first) and gets re-selected into nearly every subsequent hourly
// batch, re-tripping the blast-radius guard and reddening the workflow every
// single run it's picked (observed: the same ~9-10 off-broadway shows,
// frozen at an early-August computedAt, recurred in nearly every run from
// 2026-09-07 onward). This cap breaks that starvation loop: after
// `DEFAULT_QUARANTINE_STREAK_CAP` consecutive rollbacks, the show's re-audit
// CADENCE is allowed to advance so it falls back to its normal freshness
// window (freshnessMsFor) instead of front-running the least-recently-
// audited queue forever. It stays visibly quarantined in
// show-review-gap.json (a separate file/lock) and keeps alerting via
// routeAlert's own cooldown — only the checkpoint's scheduling stops
// starving.
//
// Adversarial review finding (Codex, BRO-392): the FIRST version of this fix
// let the show's entire refused-run stamp stand once the cap tripped —
// including `gaps`/`uncollected`, THIS run's numbers, which the blast-radius
// guard just finished declaring too risky to trust. newsletter-preflight.js
// reads exactly those two fields off this file as a HARD completeness gate
// (classifyGapEntry: fresh `at` + `uncollected === 0` reads 'ok' and clears a
// show to send) — so escaping quarantine could have silently blessed a send
// on the very lie the guard exists to catch. The breaker below advances ONLY
// the timestamp; `gaps`/`uncollected` keep whatever was last genuinely
// trusted (or are dropped entirely if nothing ever was, which
// classifyGapEntry/newsletter-preflight already read as 'no-data' — a soft
// warn, never a false 'ok').
const DEFAULT_QUARANTINE_STREAK_CAP = 3;

/**
 * Pure branching for a refused (blast-radius) run's checkpoint rollback. For
 * each id in `auditedIds`, restore whatever was last genuinely trusted about
 * it (or nothing, if it's never been trusted) and bump its
 * `quarantineStreak`. Once the streak exceeds `streakCap` (BRO-392), the
 * show's `at` timestamp is advanced to THIS run's fresh stamp — breaking the
 * starvation loop — but `gaps`/`uncollected` are NEVER taken from the
 * refused run; only the last-trusted values (or none) ever persist, so a
 * quarantined show can never look more complete than it last verifiably was.
 * Extracted per CLAUDE.md §15 so the branching is unit-testable without
 * spinning up the whole audit script.
 *
 * @param {Object} current            checkpoint re-read fresh under the lock
 * @param {string[]} auditedIds       ids THIS run touched
 * @param {Object} checkpointAtStart  pre-run snapshot (may be null/{})
 * @param {Object} [opts]
 * @param {number} [opts.streakCap=DEFAULT_QUARANTINE_STREAK_CAP]
 */
function applyCheckpointRollback(current, auditedIds, checkpointAtStart, opts = {}) {
  const streakCap = opts.streakCap == null ? DEFAULT_QUARANTINE_STREAK_CAP : opts.streakCap;
  const merged = { ...(current || {}) };
  const snapshot = checkpointAtStart || {};
  for (const id of auditedIds || []) {
    const hadTrustedEntry = Object.prototype.hasOwnProperty.call(snapshot, id);
    // Null-safety: a persisted `null` entry is a valid (if odd) prior value —
    // `{...null}` is a safe no-op spread, but reading `.quarantineStreak` off
    // it would throw, so guard the property access itself (adversarial
    // review finding).
    const priorEntry = hadTrustedEntry ? snapshot[id] : null;
    const priorStreak = Number.isFinite(priorEntry && priorEntry.quarantineStreak) ? priorEntry.quarantineStreak : 0;
    const nextStreak = priorStreak + 1;
    if (nextStreak > streakCap) {
      // Circuit breaker tripped: advance the timestamp only (already in
      // `current`/`merged` from this run's per-show stamp) — never adopt
      // this run's untrusted gaps/uncollected. See the module comment above.
      //
      // Residual same-show concurrency gap (2nd Codex adversarial pass): if a
      // DIFFERENT, non-refused run legitimately re-stamped this exact id
      // between our lock's re-read and now, `merged[id].at` is that run's
      // real, trustworthy timestamp, but we still pair it with OUR OWN stale
      // `priorEntry` gaps/uncollected — a fresh timestamp next to stale
      // counts. This requires two runs auditing the identical show
      // concurrently, which the workflow's own concurrency group already
      // prevents for the normal hourly cron; only a manual `--show=X` run
      // racing the cron could trigger it. Same class of risk the module's
      // top-of-file docstring already accepts for the whole rollback
      // mechanism ("a real cross-process lock is out of S0 scope") — not
      // resolved here, since disambiguating "our own untrusted stamp" from
      // "a different run's trustworthy one" needs cross-run bookkeeping this
      // file doesn't have.
      const freshAt = (merged[id] && merged[id].at) || new Date().toISOString();
      merged[id] = hadTrustedEntry
        ? { ...priorEntry, at: freshAt, quarantineStreak: 0 }
        : { at: freshAt, quarantineStreak: 0 };
      continue;
    }
    // Below the cap: restore whatever was last trusted (bumping the streak).
    // A show with NO trusted history yet still needs its streak tracked
    // across runs (adversarial review finding: without this, a show that's
    // risky from its very first audit would hit the "no prior entry" branch
    // every single run forever and never reach the cap at all) — persist a
    // streak-only marker with no `at`/`gaps`/`uncollected` fields.
    // checkpointTs() and classifyGapEntry() both already treat a missing
    // `at`/`uncollected` as "never audited" / "no-data", so this is
    // observationally identical to today's full delete for every existing
    // reader, just durable enough to count.
    merged[id] = hadTrustedEntry
      ? { ...priorEntry, quarantineStreak: nextStreak }
      : { quarantineStreak: nextStreak };
  }
  return merged;
}

/**
 * Lock + re-read + applyCheckpointRollback + write, in one call — the
 * rollback call site's counterpart to saveCheckpointEntries.
 */
function rollbackCheckpointEntries(checkpointPath, auditedIds, checkpointAtStart, opts = {}) {
  withFileLock(`${checkpointPath}.lock`, (held) => {
    if (!held) {
      console.error(`::warning::gap-audit-checkpoint rollback lock could not be acquired for ${checkpointPath} (assumed stale and broken, or lock dir unwritable) — the read-modify-write ran unprotected. A concurrent run could have lost data.`);
    }
    const current = loadCheckpoint(checkpointPath);
    const merged = applyCheckpointRollback(current, auditedIds, checkpointAtStart, opts);
    writeJsonAtomic(checkpointPath, merged);
  });
}

module.exports = {
  loadCheckpoint,
  writeJsonAtomic,
  mergeCheckpointEntries,
  saveCheckpointEntries,
  applyCheckpointRollback,
  rollbackCheckpointEntries,
  DEFAULT_QUARANTINE_STREAK_CAP,
};
