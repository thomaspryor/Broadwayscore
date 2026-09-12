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
 * `current` ({showId: entryObject}). A value of `undefined` deletes that id.
 * Used by saveCheckpointEntries (the per-show stamp / WE-alert hash update
 * paths) — rollback has its own branching in applyCheckpointRollback below,
 * not this function. No I/O — the caller supplies `current`, already read
 * under the lock.
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

// BRO-392: a rollback used to restore the PRE-quarantine (arbitrarily old)
// `at` wholesale, and `at` was the ONLY timestamp compareAuditPriority had to
// sort on — so a chronically-risky show's scheduling priority never
// advanced, it permanently read as "most overdue", and it got re-selected
// into nearly every subsequent hourly batch, re-tripping the blast-radius
// guard and reddening the workflow run after run (observed: the same ~9-10
// off-broadway shows, frozen at an early-August `at`, recurred in nearly
// every run from 2026-09-07 onward).
//
// Two earlier attempts at this fix (a per-show rollback streak cap that let
// the timestamp advance after N strikes) each introduced a new way to leak
// untrusted or stale data into newsletter-preflight.js's hard completeness
// gate (classifyGapEntry reads `at` + `uncollected` off this exact file — a
// fresh `at` next to a zero or stale `uncollected` reads 'ok' and clears a
// show to send). The actual fix is simpler: SEPARATE the two concerns that
// were sharing one field. `checkedAt` (gap-audit-freshness.js's
// checkpointTs) is scheduling-only — stamped unconditionally by the per-show
// audit loop every run, refused or not — and rollback here never touches it.
// `at`/`gaps`/`uncollected` stay exactly what they always were: the last
// genuinely TRUSTED snapshot, fully restored (or left absent) on a refused
// run, exactly like the original #923/#893 design, with zero new leak
// surface. A chronically-risky show's `checkedAt` still advances every run
// it's examined, so it ages out of "most overdue" on its own — no cap, no
// streak, no extra state to get wrong.

/**
 * Pure restore-vs-delete branching for a refused (blast-radius) run's
 * checkpoint rollback. For each id in `auditedIds`: if `checkpointAtStart`
 * had a pre-run entry for it, restore that entry (the show WAS audited
 * before, this run's TRUSTED fields — `at`/`gaps`/`uncollected` — just
 * aren't trustworthy this time); otherwise delete it entirely (the show was
 * never trusted before this run, so leaving trusted-looking fields behind
 * would be inventing history). Either way, `checkedAt` — this run's real
 * audit-attempt timestamp, already stamped in `current` before the guard
 * ever ran — is always preserved, so scheduling keeps moving even though the
 * trusted snapshot doesn't. Extracted per CLAUDE.md §15 so the branching is
 * unit-testable without spinning up the whole audit script.
 *
 * @param {Object} current            checkpoint re-read fresh under the lock
 * @param {string[]} auditedIds       ids THIS run touched
 * @param {Object} checkpointAtStart  pre-run snapshot (may be null/{})
 */
function applyCheckpointRollback(current, auditedIds, checkpointAtStart) {
  const merged = { ...(current || {}) };
  const snapshot = checkpointAtStart || {};
  for (const id of auditedIds || []) {
    const checkedAt = merged[id] && merged[id].checkedAt;
    if (Object.prototype.hasOwnProperty.call(snapshot, id)) {
      // Null-safety: a persisted `null` entry is a valid (if odd) prior
      // value — `{...null}` is a safe no-op spread (adversarial review
      // finding: guards against a future reader adding a property access
      // here without re-deriving this).
      merged[id] = { ...snapshot[id], ...(checkedAt ? { checkedAt } : {}) };
    } else if (checkedAt) {
      // Never trusted before, but this run's scheduling stamp must still
      // survive so the show doesn't look perpetually never-audited.
      merged[id] = { checkedAt };
    } else {
      delete merged[id];
    }
  }
  return merged;
}

/**
 * Lock + re-read + applyCheckpointRollback + write, in one call — the
 * rollback call site's counterpart to saveCheckpointEntries.
 */
function rollbackCheckpointEntries(checkpointPath, auditedIds, checkpointAtStart) {
  withFileLock(`${checkpointPath}.lock`, (held) => {
    if (!held) {
      console.error(`::warning::gap-audit-checkpoint rollback lock could not be acquired for ${checkpointPath} (assumed stale and broken, or lock dir unwritable) — the read-modify-write ran unprotected. A concurrent run could have lost data.`);
    }
    const current = loadCheckpoint(checkpointPath);
    const merged = applyCheckpointRollback(current, auditedIds, checkpointAtStart);
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
};
