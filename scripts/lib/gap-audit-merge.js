/**
 * Per-show merge for data/audit/show-review-gap.json (task #893, Coverage
 * Verdict S0).
 *
 * The bug: audit-show-review-gap.js wrote the whole file from just the shows it
 * audited this run. A `--show=X` run — exactly what the newsletter send-day
 * runbook and every "collect the missing reviews" command tell you to run —
 * replaced 24 shows' audited state with 1. newsletter-preflight.js then read
 * that file for review-completeness and saw "no data" for every other featured
 * show, and the checkpoint-driven hourly cron re-audited from scratch.
 *
 * The fix: results are keyed by showId and merged. This run's entries win for
 * the shows it audited; everything else is carried forward with the
 * `computedAt` stamp from the run that produced it. Counts are recomputed over
 * the MERGED set so the summary describes the file, not the run.
 *
 * Retention: carried-forward entries older than `retentionDays` are dropped, so
 * the file converges on the shows still being audited instead of growing
 * forever. Entries this run produced are never dropped.
 *
 * Concurrency, honestly: the audit is the only writer, and the GitHub workflow
 * serializes ITS runs via a concurrency group — but a local terminal run can
 * still overlap a cron run, and last-writer-wins would drop the other run's
 * per-show results. Mitigations live at the call site: the previous file is
 * read at the END of the run — after all fetching, with no await between the
 * read and the write — so the lost-update window is the merge itself rather
 * than the whole multi-minute audit; and the write is a tmp+rename so a reader
 * never sees a torn file.
 * A real cross-process lock is out of S0 scope; if overlapping runs ever
 * become routine this needs the #784/#809 reconciler treatment.
 */

'use strict';

// Retention must OUTLAST the longest re-audit skip a show can earn, or the file
// evicts shows that are simply not due yet. Closed-and-clean shows skip for 365
// days (gap-audit-freshness MAX_FRESHNESS_SKIP_MS) and most of the back-catalogue
// backlog sits on that cycle — a 45-day retention (the first cut of this) would
// have dropped them ~320 days before their next audit, and gapStateFor would
// then read them as `no-census-yet`. Derived, not guessed, so the two can't
// drift apart silently.
const { MAX_FRESHNESS_SKIP_MS } = require('./gap-audit-freshness');
const RETENTION_GRACE_DAYS = 30;
const DEFAULT_RETENTION_DAYS = Math.ceil(MAX_FRESHNESS_SKIP_MS / (24 * 3600 * 1000)) + RETENTION_GRACE_DAYS;

/**
 * Coverage state for one audited show, in the plan's vocabulary.
 *
 * S0 SCOPE — this exists to give the blast-radius guard something to diff, and
 * it derives state from the gap-audit result the audit already computes. It
 * deliberately reuses censusVerdict()'s vocabulary (complete | incomplete |
 * no-census-yet, scripts/lib/review-census.js) rather than inventing new words,
 * but it is a SECOND place that computes a verdict, which the plan's rule 3
 * ("no new parallel machinery") does not want long-term. S2 owns the merge:
 * when censusVerdict() grows per-show candidate states, this should call it
 * instead of re-deriving. Tracked on the S2 card.
 */
function gapStateFor(result) {
  if (!result || typeof result !== 'object') return 'no-census-yet';
  const missing = Array.isArray(result.missing) ? result.missing.length : 0;
  const flagged = Array.isArray(result.flaggedMisses) ? result.flaggedMisses.length : 0;
  const citedNoUrl = Array.isArray(result.citedNoUrl) ? result.citedNoUrl.length : 0;
  const sawReference = (Array.isArray(result.aggregatorArticles) && result.aggregatorArticles.length > 0)
    || (Array.isArray(result.aggregatorListedUrls) && result.aggregatorListedUrls.length > 0);
  // Empty census is never "complete" (the rule censusVerdict already enforces):
  // finding no aggregator reference at all is ignorance, not proof of coverage.
  if (!sawReference) return 'no-census-yet';
  return (missing + flagged + citedNoUrl) > 0 ? 'incomplete' : 'complete';
}

/** { showId -> state } for a results array — the blast-radius guard's input. */
function stateMap(results) {
  const out = {};
  for (const r of results || []) {
    if (r && r.showId) out[r.showId] = gapStateFor(r);
  }
  return out;
}

/**
 * Merge this run's results into the previously-persisted audit.
 *
 * @param {Object|null} prevAudit  parsed previous show-review-gap.json (or null)
 * @param {Object} runAudit        this run's audit object ({generatedAt, windowDays, targets, results})
 * @param {Object} [opts]
 * @param {number} [opts.retentionDays=45]
 * @param {string} [opts.now=runAudit.generatedAt]  ISO stamp for this run
 * @returns {Object} merged audit — same shape, plus per-result `computedAt`
 */
function mergeGapAudit(prevAudit, runAudit, opts = {}) {
  const now = opts.now || (runAudit && runAudit.generatedAt) || new Date().toISOString();
  const retentionDays = opts.retentionDays == null ? DEFAULT_RETENTION_DAYS : opts.retentionDays;
  const cutoffMs = Date.parse(now) - retentionDays * 24 * 3600 * 1000;

  const runResults = Array.isArray(runAudit && runAudit.results) ? runAudit.results : [];
  const freshIds = new Set(runResults.map(r => r && r.showId).filter(Boolean));

  // Keyed by showId, NOT an append list. A duplicate showId — from either side
  // — must collapse to one row, or every merge appends another copy and the
  // counts inflate silently forever.
  const byId = new Map();
  // 1. carry forward prior entries this run did NOT re-audit, subject to retention
  const prevResults = Array.isArray(prevAudit && prevAudit.results) ? prevAudit.results : [];
  let carried = 0, dropped = 0;
  for (const r of prevResults) {
    if (!r || !r.showId || freshIds.has(r.showId)) continue;
    // No computedAt (pre-#893 file) → stamp it with the previous run's
    // generatedAt so it ages out normally instead of living forever.
    const stamp = r.computedAt || (prevAudit && prevAudit.generatedAt) || null;
    const stampMs = stamp ? Date.parse(stamp) : NaN;
    // Unparseable/absent stamp → KEEP. Dropping real audited state because a
    // timestamp didn't parse is the wrong direction to fail on this file.
    if (Number.isFinite(stampMs) && Number.isFinite(cutoffMs) && stampMs < cutoffMs) { dropped++; continue; }
    if (!byId.has(r.showId)) carried++;
    byId.set(r.showId, stamp ? { ...r, computedAt: stamp } : { ...r });
  }
  // 2. this run's entries win, stamped now (last write per showId wins)
  for (const r of runResults) {
    if (!r || !r.showId) continue;
    byId.set(r.showId, { ...r, computedAt: now });
  }

  const merged = [...byId.values()].sort((a, b) => String(a.showId).localeCompare(String(b.showId)));

  return {
    generatedAt: now,
    windowDays: runAudit && runAudit.windowDays,
    // `targets` describes THIS run; `results` describes the whole file.
    targets: runAudit && runAudit.targets,
    auditedThisRun: runResults.length,
    carriedForward: carried,
    prunedStale: dropped,
    retentionDays,
    counts: countsFor(merged),
    results: merged,
  };
}

/** Recompute the summary counts over an arbitrary results array. */
function countsFor(results) {
  const rs = results || [];
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    withGap: rs.filter(r => len(r.missing) + len(r.flaggedMisses) + len(r.citedNoUrl) > 0).length,
    totalMissing: rs.reduce((a, r) => a + len(r.missing), 0),
    totalCitedNoUrl: rs.reduce((a, r) => a + len(r.citedNoUrl), 0),
    totalFlaggedMisses: rs.reduce((a, r) => a + len(r.flaggedMisses), 0),
    totalRecoverable: rs.reduce((a, r) => a + (Array.isArray(r.flaggedMisses) ? r.flaggedMisses.filter(m => m && m.recoverable).length : 0), 0),
    totalRecovered: rs.reduce((a, r) => a + (Array.isArray(r.recoveryResults) ? r.recoveryResults.filter(x => x && x.recovered).length : 0), 0),
  };
}

/**
 * Run `fn` while holding an exclusive lock on `lockPath`.
 *
 * The plan's S0 acceptance is "`--show=X` twice CONCURRENTLY → no lost data".
 * Merging alone doesn't give that: two overlapping runs (the hourly cron and a
 * human at a terminal, which the GitHub concurrency group does not serialize)
 * both read the same prior file and the later write drops the earlier run's
 * per-show update — #893's data loss from a different cause. `wx` open is
 * atomic on POSIX, so exactly one process wins the create.
 *
 * Fail-open on every uncertainty: a lock we cannot create after the timeout is
 * broken (assumed stale from a killed process) and the work proceeds. Blocking
 * the audit forever on a leftover lockfile would be a worse failure than the
 * race it prevents.
 *
 * PRECONDITION: staleMs must comfortably exceed how long `fn` runs. The lock's
 * mtime is stamped once at acquire and never refreshed, so a critical section
 * longer than staleMs lets a waiter classify a LIVE lock as abandoned and steal
 * it. Here `fn` is a synchronous merge + two file writes (milliseconds) against
 * a 5-minute default, so the margin is ~5 orders of magnitude — but anyone
 * reusing this helper for slower work must raise staleMs to match.
 *
 * @param {string} lockPath
 * @param {() => any} fn                 executed while holding the lock
 * @param {{timeoutMs?: number, staleMs?: number, waitMs?: number}} [opts]
 */
function withFileLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 30000, staleMs = 5 * 60 * 1000, waitMs = 100 } = opts;
  const fs = require('fs');
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { held = false; break; } // unwritable dir etc — proceed unlocked
      // Break a lock left behind by a killed process.
      //
      // NOT unlinkSync: between judging the lock stale and deleting it, the
      // original owner can release and a NEW process can take a fresh lock at
      // the same path — the blind unlink would then delete a LIVE lock and two
      // writers would run concurrently, which is the exact failure this
      // function exists to prevent. rename(2) is atomic, so when several
      // processes race to steal the same stale lock exactly one rename
      // succeeds; the losers get ENOENT and simply retry. The steal only ever
      // moves the file we actually judged stale.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          const stealPath = `${lockPath}.stale-${process.pid}-${st.mtimeMs}`;
          fs.renameSync(lockPath, stealPath); // throws ENOENT if someone else won
          try { fs.unlinkSync(stealPath); } catch { /* best-effort */ }
          continue; // retry the wx create immediately
        }
      } catch { /* vanished or lost the steal race — fall through and retry */ }
      // Busy-wait: this runs once at the very end of a multi-minute audit, so a
      // short synchronous spin is simpler than making the whole write path async.
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn(held);
  } finally {
    // Only ever released when THIS process won the `wx` create above, so this
    // can't remove a lock belonging to someone else.
    if (held) { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } }
  }
}

module.exports = { mergeGapAudit, countsFor, gapStateFor, stateMap, withFileLock, DEFAULT_RETENTION_DAYS };
