'use strict';

/**
 * Per-show dispatch dedup for gather-reviews.yml, the sibling of
 * poller-idempotency.js. Same "is an active run already covering this show?"
 * question, but gather-reviews fans out over a COMMA LIST of shows, so the
 * run-name carries a list and coverage is a list-contains match (not the
 * poller's single-slug endsWith suffix).
 *
 * Detection contract: gather-reviews.yml sets
 *   run-name: Gather Review Data — ${{ inputs.shows }}
 * which surfaces as `displayTitle` on the gh run list JSON, e.g.
 *   "Gather Review Data — sinatra-the-musical-west-end-2026,cyrano-...-2026"
 *
 * Why this exists: opening-night-reviews.yml's old guard skipped dispatch
 * whenever ANY gather run was in_progress (a blanket global lock). Because
 * gather-reviews was serialized (shared concurrency group until BRO-4859; now a
 * FIFO slot gate, scripts/lib/gather-slot.js) it is almost always busy, so
 * opening-night shows were starved of their gather pass entirely (Sinatra
 * 2026-06-25: the guard fired on every run). Per-show dedup lets each opening
 * show queue exactly one gather while the slot gate handles throttling.
 *
 * Pure logic here so it can be unit-tested; the thin gh-CLI wrapper lives in
 * opening-night-reviews.yml.
 */

const { isActiveRun, RUN_NAME_SEPARATOR, findInFlightTargetedPollerForShow } = require('./poller-idempotency');

/**
 * Parse the show-id list out of a gather-reviews run's displayTitle.
 * Returns [] when the title has no run-name separator (older runs predating
 * the run-name addition surface only "Gather Review Data" → treated as
 * covering no specific show, so dedup is conservative and re-dispatches).
 *
 * @param {string} displayTitle
 * @returns {string[]}
 */
function gatherRunShowIds(displayTitle) {
  if (typeof displayTitle !== 'string') return [];
  const i = displayTitle.lastIndexOf(RUN_NAME_SEPARATOR);
  if (i < 0) return [];
  return displayTitle
    .slice(i + RUN_NAME_SEPARATOR.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this gather run cover the given show?
 * @param {string} displayTitle
 * @param {string} showId
 * @returns {boolean}
 */
function gatherCoversShow(displayTitle, showId) {
  if (!showId) return false;
  return gatherRunShowIds(displayTitle).includes(showId);
}

/**
 * Given the gh run list JSON and the shows we WANT to dispatch, return only
 * the shows that are NOT already covered by an active (in_progress/queued/...)
 * gather run. Preserves input order and de-dups the input list.
 *
 * @param {Array<{status:string, displayTitle:string}>} runs
 * @param {string[]} showIds
 * @returns {string[]}
 */
function showsNeedingGather(runs, showIds) {
  const active = Array.isArray(runs) ? runs.filter(isActiveRun) : [];
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(showIds) ? showIds : []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!active.some((r) => gatherCoversShow(r.displayTitle, id))) out.push(id);
  }
  return out;
}

// gh's createdAt includes time spent queued behind the per-show concurrency
// group, so the cap must cover queue wait (<= one 100-min run) + the poller's own
// 100-min job timeout (opening-night-poller.yml timeout-minutes). A "targeted
// poller" older than this is stuck/orphaned and must not suppress gather forever.
const POLLER_MAX_AGE_MS = 200 * 60 * 1000;

/**
 * Aggregators-only variant of showsNeedingGather (BRO-2269). Additionally drops
 * shows that have an active TARGETED opening-night-poller run, because that
 * poller already runs the same aggregator layer inline and commits to the same
 * review-texts/core-data repos: a concurrent aggregators-only gather for the
 * same show is pure duplicate work and a git-rebase race (BRO-735 issues
 * #5/#9/#15-17).
 *
 * Deliberately NOT applied to FULL gathers: the poller does not run the
 * per-outlet SERP pass, so skipping a full gather would lose coverage. Auto
 * pollers are ignored too (they cover every show and run ~60-90 min, which
 * would starve gather, see opening-night-poller.yml concurrency note, BRO-4273).
 * Poller runs older than POLLER_MAX_AGE_MS (by createdAt) are treated as stuck
 * and don't block; a run with no parseable createdAt is treated as fresh.
 * This is best-effort dedup (check-then-dispatch is not atomic), not mutual
 * exclusion; push-with-retry.sh remains the safety net for true collisions.
 *
 * @param {Array} gatherRuns  gh run list --workflow=gather-reviews.yml JSON
 * @param {Array} pollerRuns  gh run list --workflow=opening-night-poller.yml JSON
 * @param {string[]} showIds
 * @param {{now?: number}} [opts]
 * @returns {string[]}
 */
function showsNeedingAggregatorGather(gatherRuns, pollerRuns, showIds, opts = {}) {
  const now = opts.now ?? Date.now();
  const fresh = (Array.isArray(pollerRuns) ? pollerRuns : []).filter((r) => {
    const created = r && r.createdAt ? Date.parse(r.createdAt) : NaN;
    return Number.isNaN(created) || now - created <= POLLER_MAX_AGE_MS;
  });
  return showsNeedingGather(gatherRuns, showIds).filter(
    (id) => !findInFlightTargetedPollerForShow(fresh, id),
  );
}

module.exports = { gatherRunShowIds, gatherCoversShow, showsNeedingGather, showsNeedingAggregatorGather, POLLER_MAX_AGE_MS };
