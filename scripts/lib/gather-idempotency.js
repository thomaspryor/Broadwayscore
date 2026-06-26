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
 * gather-reviews serializes on concurrency group `review-texts-backfill-write`
 * (cancel-in-progress:false) it is almost always busy, so opening-night shows
 * were starved of their gather pass entirely (Sinatra 2026-06-25: the guard
 * fired on every run). Per-show dedup lets each opening show queue exactly one
 * gather while the concurrency group handles serialization.
 *
 * Pure logic here so it can be unit-tested; the thin gh-CLI wrapper lives in
 * opening-night-reviews.yml.
 */

const { isActiveRun, RUN_NAME_SEPARATOR } = require('./poller-idempotency');

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

module.exports = { gatherRunShowIds, gatherCoversShow, showsNeedingGather };
