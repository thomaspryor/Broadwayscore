'use strict';

/**
 * Reviews of a retired show (BRO-7192). Pure, no IO.
 *
 * A retired show's `manualEntry` review rows never left reviews.json: the push merge
 * (merge-reviews-json.js) never drops a manual row and the rebuild copies every manual row
 * forward, so validate-data reported them as orphan showIds. A show can be retired with
 * reviews only after a plan removed them; this drops what the merge brings back.
 *
 * A row goes only when its show id is in the retired registry AND not a live show (a
 * retired id can be re-minted, retire-show-action.js `reMinted`; its rows are then real).
 */

/**
 * @param {object[]} reviews
 * @param {Iterable<string>} retiredIds ids from retired-show-ids.json
 * @param {Iterable<string>} liveShowIds ids in shows.json (merged-time copy)
 * @returns {{kept: object[], dropped: object[]}}
 */
function dropRetiredShowReviews(reviews, retiredIds, liveShowIds) {
  const retired = new Set(retiredIds);
  const live = new Set(liveShowIds);
  // An unreadable shows.json makes every retired id look not-live: refuse to filter on no evidence.
  if (retired.size === 0 || live.size === 0) return { kept: reviews, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const r of reviews) {
    if (r && retired.has(r.showId) && !live.has(r.showId)) dropped.push(r);
    else kept.push(r);
  }
  return { kept, dropped };
}

module.exports = { dropRetiredShowReviews };
