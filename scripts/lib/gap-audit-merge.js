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
 * The audit is the only writer and its runs are serialized (hourly cron + a
 * human at a terminal), so a read-modify-write is sufficient here — this is not
 * the concurrent-CI-writer class that needed the #784/#809 ledger reconciler.
 */

'use strict';

const DEFAULT_RETENTION_DAYS = 45;

/** Coverage state for one audited show, in the plan's vocabulary (S2 extends this). */
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

  const merged = [];
  // 1. carry forward prior entries this run did NOT re-audit, subject to retention
  const prevResults = Array.isArray(prevAudit && prevAudit.results) ? prevAudit.results : [];
  let carried = 0, dropped = 0;
  for (const r of prevResults) {
    if (!r || !r.showId || freshIds.has(r.showId)) continue;
    // No computedAt (pre-#893 file) → stamp it with the previous run's
    // generatedAt so it ages out normally instead of living forever.
    const stamp = r.computedAt || (prevAudit && prevAudit.generatedAt) || null;
    const stampMs = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(stampMs) && Number.isFinite(cutoffMs) && stampMs < cutoffMs) { dropped++; continue; }
    merged.push(stamp ? { ...r, computedAt: stamp } : { ...r });
    carried++;
  }
  // 2. this run's entries win, stamped now
  for (const r of runResults) {
    if (!r || !r.showId) continue;
    merged.push({ ...r, computedAt: now });
  }

  merged.sort((a, b) => String(a.showId).localeCompare(String(b.showId)));

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

module.exports = { mergeGapAudit, countsFor, gapStateFor, stateMap, DEFAULT_RETENTION_DAYS };
