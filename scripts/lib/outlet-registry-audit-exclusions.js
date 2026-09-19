/**
 * The 5 exclusion branches audit-outlet-registry.js uses to decide a review
 * file never needs a registry entry (BRO-3804). Extracted to a pure function
 * so scripts/outlet-registry.test.mjs can exercise each branch against
 * synthetic fixtures without real review-texts (memory: Test Extraction
 * Pattern — never re-copy this logic into the test file).
 *
 * Each comment mirrors the rationale inline in audit-outlet-registry.js;
 * see that file for the full incident history behind each branch.
 */
const { isNonReviewDemotedByFreshCV, isRejectedNonReview, wrongShowCleared } = require('./review-guards');
const { isBlockedReviewUrl } = require('./domain-filters');
const { WRONG_URL_INCOMPLETE } = require('./t1-silent-gap');

const WRONG_PRODUCTION_REJECTION_REASONS = new Set(['wrong_production', 'wrong_show']);

/**
 * @param {object} review parsed review-text JSON
 * @returns {boolean} true when this review file never needs a registry entry
 */
function isExcludedFromOutletRegistryAudit(review) {
  // 1. Content-quality pipeline already flagged this as not a review at all.
  if (review.isNonReview === true && !isNonReviewDemotedByFreshCV(review)) return true;

  // 2. ensemble-scoreability-check rejected ingest-time junk.
  if (isRejectedNonReview(review)) return true;

  // 3. URL on a known non-review domain.
  if (review.url && isBlockedReviewUrl(review.url)) return true;

  // 4. Confidently rejected as wrong_production/wrong_show, never manually cleared.
  if (
    WRONG_PRODUCTION_REJECTION_REASONS.has(review.rejectionReason) &&
    review.rejectedAt &&
    !wrongShowCleared(review)
  ) return true;

  // 5. Content-quality pipeline flagged the file's URL as pointing at the
  // wrong content at write time (BRO-3794) — a re-fetch of the same URL can
  // only re-ingest more garbage, so this outletId never needs a registry
  // entry either. Reuses the SAME narrow set t1-silent-gap.js's
  // hasWrongUrlSignal checks first, not the full signal (which also covers
  // isBlockedReviewUrl/bwwAggregatorAmbiguous — already handled by branch 3
  // above, or out of scope here) and NOT isIncludableForRebuild wholesale
  // (tried before here per branch 4's comment: pulled in duplicateOf/
  // temporal-window/roundup exclusions unrelated to this audit's question).
  if (WRONG_URL_INCOMPLETE.has(review.incompleteReason)) return true;

  return false;
}

module.exports = {
  isExcludedFromOutletRegistryAudit,
  WRONG_PRODUCTION_REJECTION_REASONS,
};
