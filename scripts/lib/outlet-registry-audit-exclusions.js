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
const { isNonReviewDemotedByFreshCV, isRejectedNonReview, wrongShowCleared, hasValidScore } = require('./review-guards');
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
  // only re-ingest more garbage, so this file supplies no registry
  // requirement either (its outletId may still be covered by other files —
  // see the hasValidScore/wrongShowCleared guards below). Reuses the SAME
  // narrow set t1-silent-gap.js's
  // hasWrongUrlSignal checks first, not the full signal (which also covers
  // isBlockedReviewUrl/bwwAggregatorAmbiguous — already handled by branch 3
  // above, or out of scope here) and NOT isIncludableForRebuild wholesale
  // (tried before here per branch 4's comment: pulled in duplicateOf/
  // temporal-window/roundup exclusions unrelated to this audit's question).
  //
  // hasValidScore() gate is load-bearing, not optional: incompleteReason is
  // informational metadata that clearFailureFlags() is supposed to null out
  // once a file is scored, but a real-corpus check while building this fix
  // found ~16,000 of 19,534 WRONG_URL_INCOMPLETE-flagged files already carry
  // a valid score (older files a clearFailureFlags call never touched).
  // classifySilentGap gates hasWrongUrlSignal behind the exact same
  // "not already scored" precondition (t1-silent-gap.js:117:
  // `isIncludableForRebuild(file, show) && hasValidScore(file)` short-
  // circuits first) — without mirroring that here, this branch would treat
  // thousands of real, already-scored outlets' reviews as junk and hide a
  // genuine registry gap for any of them (ship-check/Codex adversarial
  // review finding, round 1).
  //
  // wrongShowCleared() exception mirrors branch 4: a second adversarial pass
  // found 28 real files (the-komisar-scoop, nydailynews, etc.) where a human
  // explicitly cleared wrongProduction/wrongShow (wrongProductionManualClear
  // / wrongShowManualClear / humanReviewedWrongProduction:false) — overruling
  // the automated url_content_mismatch verdict — but scoring hadn't happened
  // yet, so hasValidScore() alone still excluded them. A human's "this IS a
  // real review" verdict must win regardless of score-presence, same as it
  // does for branch 4's wrong_production/wrong_show rejections.
  if (
    WRONG_URL_INCOMPLETE.has(review.incompleteReason) &&
    !hasValidScore(review) &&
    !wrongShowCleared(review)
  ) return true;

  return false;
}

module.exports = {
  isExcludedFromOutletRegistryAudit,
  WRONG_PRODUCTION_REJECTION_REASONS,
};
