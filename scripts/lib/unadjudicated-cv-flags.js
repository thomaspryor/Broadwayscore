'use strict';
/**
 * unadjudicated-cv-flags.js (BRO-6237)
 *
 * The collector content verifier stamps needsReviewReason "Collector LLM: not a
 * review (preview|feature|news|interview, high conf) but already scored - needs
 * human verification" on a file that already has a score. The verdict is
 * advisory, so the review stays in the published score until a human reads the
 * text. A file is adjudicated once it carries isNonReview (excluded) or
 * nonReviewManualClear (a human called it a real review).
 */

const { cvNonReviewHumanCleared } = require('./review-guards');

const CV_NOT_A_REVIEW_RE = /not a review \((preview|feature|news|interview)/i;

/** True when the file carries the CV not-a-review verdict and no human adjudication. */
function isUnadjudicatedCvFlag(record) {
  if (!record || typeof record.needsReviewReason !== 'string') return false;
  if (!CV_NOT_A_REVIEW_RE.test(record.needsReviewReason)) return false;
  // Same human-clear test the rebuild honours (nonReviewManualClear or a wrong-article clear).
  if (record.isNonReview === true || cvNonReviewHumanCleared(record)) return false;
  // A duplicate pointer shares its twin's url but is not itself counted.
  return !record.duplicateOf;
}

/**
 * @param {Array<{showId:string,file:string,record:object}>} files review-text files
 * @param {Array<{showId:string,url:string}>} counted data/reviews.json reviews
 * @returns flagged files whose showId+url is in the counted set
 */
function findUnadjudicatedCounted(files, counted) {
  const live = new Set(counted.map((r) => `${r.showId}|${r.url}`));
  return files.filter((f) => isUnadjudicatedCvFlag(f.record) && live.has(`${f.showId}|${f.record.url}`));
}

module.exports = { CV_NOT_A_REVIEW_RE, isUnadjudicatedCvFlag, findUnadjudicatedCounted };
