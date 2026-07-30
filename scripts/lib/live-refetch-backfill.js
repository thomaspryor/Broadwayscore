'use strict';

/**
 * live-refetch-backfill.js — B5 of the v2 reconciler Sprint B plan
 * (~/Documents/claude-outputs/review-pipeline-from-scratch-design-2026-07-29.md,
 * REVISED PLAN v2 point 7):
 *
 *   "Backfill validation must LIVE-refetch roundups for the last 90 days; the
 *    aggregator archive only contains pages for shows the old pipeline selected,
 *    so it structurally cannot contain the failure class being tested."
 *
 * That sentence is the whole reason this file is not just another pass over
 * data/aggregator-archive. Two distinct blind spots the archive cannot see:
 *
 *   1. SHOW-LEVEL. No archive file exists at all, because the old pipeline never
 *      selected the show (the Broad Strokes class: null openingDate → never
 *      polled → never archived). An archive-based census reports `no-census-yet`
 *      and every downstream audit reads that as "still collecting", forever.
 *   2. PAGE-LEVEL. An archive exists but is a SNAPSHOT. Roundups keep growing —
 *      BWW/Playbill add links for days after first publication. Whatever the
 *      roundup gained after we saved it is invisible to us permanently.
 *
 * Re-fetching the roundup LIVE is the only way either class shows up, which is
 * why this is the acceptance test for Sprints A+B rather than a nicety.
 *
 * This module is the PURE half: window selection, the three-way diff, and
 * checkpoint bookkeeping. All fetching lives in
 * scripts/backfill-live-roundup-census.js.
 */

/**
 * Shows whose openings fall in the backfill window.
 *
 * Deliberately NOT `status === 'open'`: this is a historical backfill over a
 * fixed date window, and including every long-running open show would drag
 * Chicago/Wicked/Lion King into a 90-day audit and swamp it (the same
 * evergreen-revival noise B1's isRecentOpening gate exists to keep out).
 *
 * Shows with NO openingDate are INCLUDED when they are not closed: a null date
 * is the Broad Strokes signature, and excluding them would reproduce the exact
 * selector blind spot this backfill exists to test.
 *
 * @param {Array} shows shows.json entries
 * @param {object} opts { days, nowMs, markets?: string[] (category values), includeUndated? }
 * @returns {Array} the selected shows, oldest opening first (deterministic order
 *   so a checkpointed resume walks the same list)
 */
function selectBackfillWindow(shows, opts = {}) {
  const days = opts.days != null ? opts.days : 90;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const includeUndated = opts.includeUndated !== false;
  const cutoff = new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
  const markets = opts.markets && opts.markets.length ? new Set(opts.markets) : null;

  const picked = (shows || []).filter((s) => {
    if (!s) return false;
    if (markets && !markets.has(s.category || 'broadway')) return false;
    if (s.openingDate) return s.openingDate >= cutoff;
    return includeundatedOk(s, includeUndated);
  });
  // Undated shows sort last (empty string would sort first and starve the dated
  // ones under a time budget, which is backwards — dated shows are cheaper and
  // higher-confidence).
  return picked.sort((a, b) => (a.openingDate || '9999').localeCompare(b.openingDate || '9999'));
}

function includeundatedOk(show, includeUndated) {
  return includeUndated && show.status !== 'closed';
}

/**
 * The three-way diff that makes the backfill meaningful. Pure.
 *
 * @param {object} p
 * @param {string[]} p.liveOutletIds     outletIds the FRESHLY FETCHED roundups name
 * @param {string[]} p.archiveOutletIds  outletIds the ARCHIVED roundups name (may be [])
 * @param {Set<string>|string[]} p.scoredOutletIds  outletIds live on the site (scored)
 * @param {(outletId:string)=>boolean} [p.isTierOutlet]  restrict to dispatch-tier outlets
 * @returns {{ newlyExpected, stillMissing, drained, liveCount, archiveCount }}
 *   newlyExpected — named live but NOT by the archive: the coverage the old
 *                   archive-based census structurally could not know to want.
 *                   This number IS the answer to "was the archive enough?".
 *   stillMissing  — named live and NOT scored on the site: the actionable backlog.
 *   drained       — named live AND already scored: the part already healthy
 *                   (reported so a run that finds nothing is distinguishable
 *                   from a run that fetched nothing — silence vs success).
 */
function diffLiveVsArchive(p) {
  const isTier = p.isTierOutlet || (() => true);
  const uniqTier = (ids) => [...new Set(ids || [])].filter(isTier).sort();
  const live = uniqTier(p.liveOutletIds);
  const archive = new Set(uniqTier(p.archiveOutletIds));
  const scored = new Set(p.scoredOutletIds || []);
  return {
    newlyExpected: live.filter((id) => !archive.has(id)),
    stillMissing: live.filter((id) => !scored.has(id)),
    drained: live.filter((id) => scored.has(id)),
    liveCount: live.length,
    archiveCount: archive.size,
  };
}

/**
 * Roll per-show results into the run summary. The counts the plan's acceptance
 * criterion asks for ("drained vs still-missing") come straight off this.
 */
function summarizeBackfill(results) {
  const rows = (results || []).filter(Boolean);
  const withLiveCensus = rows.filter((r) => r.liveCount > 0);
  const sum = (f) => rows.reduce((n, r) => n + (f(r) || 0), 0);
  return {
    showsProcessed: rows.length,
    showsWithLiveCensus: withLiveCensus.length,
    // A show we could not fetch a roundup for is NOT evidence of completeness —
    // counted separately so an all-failed run can never read as "all clean".
    showsWithNoLiveCensus: rows.length - withLiveCensus.length,
    drained: sum((r) => (r.drained || []).length),
    stillMissing: sum((r) => (r.stillMissing || []).length),
    newlyExpected: sum((r) => (r.newlyExpected || []).length),
    // Shows the ARCHIVE knew nothing about but a live fetch did: blind spot #1.
    showsInvisibleToArchive: rows.filter((r) => r.archiveCount === 0 && r.liveCount > 0).length,
    // Shows whose live roundup names MORE than the archive did: blind spot #2.
    showsWithGrownRoundup: rows.filter((r) => r.archiveCount > 0 && (r.newlyExpected || []).length > 0).length,
    shows: rows.filter((r) => (r.stillMissing || []).length > 0 || (r.newlyExpected || []).length > 0),
  };
}

// --- checkpointing ---------------------------------------------------------
// Mandatory per CLAUDE.md rule 8 ("batch scripts must checkpoint"): this job is
// network-heavy and time-budgeted, so it WILL stop mid-list. Progress is keyed by
// showId so a resume skips completed shows instead of re-spending fetches.

function emptyCheckpoint() {
  return { startedAt: null, done: {} };
}

function isDone(checkpoint, showId) {
  return !!(checkpoint && checkpoint.done && checkpoint.done[showId]);
}

/** Returns a NEW checkpoint with `result` recorded for showId. Never mutates. */
function recordDone(checkpoint, showId, result, nowIso) {
  const base = checkpoint && typeof checkpoint === 'object' ? checkpoint : emptyCheckpoint();
  return {
    startedAt: base.startedAt || nowIso,
    done: { ...(base.done || {}), [showId]: { at: nowIso, ...result } },
  };
}

/** Every recorded result, oldest-key-first, for the final summary after a resume. */
function completedResults(checkpoint) {
  const done = (checkpoint && checkpoint.done) || {};
  return Object.keys(done).sort().map((showId) => ({ showId, ...done[showId] }));
}

module.exports = {
  selectBackfillWindow, diffLiveVsArchive, summarizeBackfill,
  emptyCheckpoint, isDone, recordDone, completedResults,
};
