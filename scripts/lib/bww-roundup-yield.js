/**
 * BWW Review Roundup yield provenance (card #1729).
 *
 * The 2026-07-31 cheap-tier fix (bww-rr-discover.js) is cost-proven but was
 * never yield-proven: a `bwwRoundupUrl` landing in shows.json only means the
 * roundup page was FETCHED and validated, not that it actually contributed a
 * review nothing else would have found. reviews.json carries no
 * discoverySource field, so the only place that answer lives is each
 * review-text file's `source`/`sources` fields (scripts/lib/review-file-writer.js
 * accumulates every distinct discovery mechanism that has ever matched a
 * review into `sources`, write-once per mechanism — see its `sources.add`
 * call). A review whose `sources` array is `['bww-roundup']` and nothing else
 * was NEVER independently corroborated by another discovery path — that is
 * the roundup's true unique yield. A review touched by bww-roundup but ALSO
 * corroborated by e.g. show-score-playwright or playbill-verdict would very
 * likely have been found anyway; the roundup just got there first (or
 * re-confirmed an existing find).
 */

'use strict';

/**
 * Classify one review-text record's relationship to the BWW roundup.
 * @param {object} review - a review-text file's parsed JSON (or an
 *   equivalent object exposing `source`/`sources`).
 * @returns {{ touchedByRoundup: boolean, exclusiveToRoundup: boolean, sources: string[] }}
 */
function classifyReviewProvenance(review) {
  const sources = Array.isArray(review && review.sources) && review.sources.length
    ? review.sources
    : (review && review.source ? [review.source] : []);
  const touchedByRoundup = sources.includes('bww-roundup');
  const exclusiveToRoundup = touchedByRoundup && sources.length === 1;
  return { touchedByRoundup, exclusiveToRoundup, sources };
}

/**
 * Compute the BWW roundup's yield for one show: how many of its reviews the
 * roundup ever touched, and how many it is the SOLE recorded source for
 * (never independently corroborated by any other discovery mechanism).
 *
 * @param {string} showId
 * @param {Array<object>} reviews - review-text records for ALL shows; this
 *   filters to `showId` internally so callers can pass one big array.
 * @returns {{
 *   showId: string,
 *   totalReviews: number,
 *   roundupTouchedCount: number,
 *   roundupExclusiveCount: number,
 *   roundupTouched: Array<{outletId: string, criticName: string, exclusive: boolean, sources: string[]}>,
 *   roundupExclusive: Array<{outletId: string, criticName: string}>,
 * }}
 */
function computeRoundupYield(showId, reviews) {
  const showReviews = (reviews || []).filter(r => r && r.showId === showId);
  const touched = [];
  const exclusive = [];
  for (const r of showReviews) {
    const c = classifyReviewProvenance(r);
    if (!c.touchedByRoundup) continue;
    touched.push({ outletId: r.outletId, criticName: r.criticName, exclusive: c.exclusiveToRoundup, sources: c.sources });
    if (c.exclusiveToRoundup) exclusive.push({ outletId: r.outletId, criticName: r.criticName });
  }
  return {
    showId,
    totalReviews: showReviews.length,
    roundupTouchedCount: touched.length,
    roundupExclusiveCount: exclusive.length,
    roundupTouched: touched,
    roundupExclusive: exclusive,
  };
}

module.exports = {
  classifyReviewProvenance,
  computeRoundupYield,
};
