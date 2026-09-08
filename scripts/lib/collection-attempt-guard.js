/**
 * Single source of truth for "has this review already been attempted in the
 * current collect-review-texts.js session?" (BRO-3024).
 *
 * Before this existed, only the review-selection loop in
 * findReviewsToProcess() checked state.processed/state.failed before adding
 * a review to the work queue. The per-attempt loop in main() that actually
 * calls processReview() and pushes to state.failed had no equivalent check,
 * so a review already recorded as failed/processed earlier in the same
 * session could still be re-attempted, burning a paid fetch (Browserbase/
 * Bright Data/ScrapingBee) for nothing.
 */
function shouldSkipAlreadyAttempted(state, reviewId, retryFailed = false) {
  if (state.processed.includes(reviewId)) return true;
  if (!retryFailed && state.failed.includes(reviewId)) return true;
  return false;
}

module.exports = { shouldSkipAlreadyAttempted };
