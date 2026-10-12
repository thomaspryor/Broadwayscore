/**
 * JS twin of scripts/llm-scoring/is-scoreable.ts.
 * Both files MUST stay in lockstep — see Notion 34f637c5-416f-810d.
 *
 * Delegates to isIncludableForRebuild and layers LLM-only extras. See the
 * .ts file's docstring for why.
 */
const { hasExcerpt } = require('./excerpt-fields');
const { isIncludableForRebuild } = require('./review-guards');
const { laneBypasses } = require('./opening-night-lane/trust-model');

function isScoreable(data, show, filePath) {
  if (!isIncludableForRebuild(data, show, filePath)) return false;
  // BRO-4806: scraper_garbage is a lane-bypassed guard (a lane review is production-verified by an aggregator).
  if (data.incompleteReason === 'scraper_garbage' && !laneBypasses(data, 'scraperGarbage', { openingDate: show && show.openingDate })) return false;
  // headlineBackstop: the show-name-not-in-text check (rebuild's skippedShowNotMentioned gate) also stands down.
  if (data.showNotMentioned && !hasExcerpt(data) && !laneBypasses(data, 'headlineBackstop', { openingDate: show && show.openingDate })) return false;
  return true;
}

/**
 * BRO-4189: opt-in scoring of CV-promoted non-review files so the corroboration
 * path can run. isNonReviewDemotedByFreshCV (review-guards.js) demotes a
 * CV-promoted isNonReview flag only when hasHighConfidenceLlmScore(data) is
 * true, but isScoreable() refuses every isNonReview file, so the ensemble never
 * scored one and that demotion could never fire: the 106 opening-night
 * reviews the CV mislabelled "preview" stayed excluded for good.
 *
 * Eligible = CV-promoted isNonReview (not human-adjudicated, per the BRO-4552
 * selector), fullText of at least 1500 chars, and scoreable once the fields
 * written by that ONE CV not-a-review verdict are masked: isNonReview, the
 * rejectionReason='not_a_review' the promotion stamps alongside it, and the
 * verdict's own wrongArticle (only when the CV did not also say
 * wrongProduction/film-TV). Every other exclusion (wrongShow, wrongProduction,
 * duplicateOf, roundup, contentTier...) still applies.
 *
 * Read-only: the mask is a shallow copy and nothing here writes to disk. The
 * scorer only uses this under --nonreview-corroboration, so default/cron runs
 * are unchanged and spend nothing new.
 */
const NONREVIEW_CORROBORATION_MIN_CHARS = 1500;

function maskCvNonReviewVerdict(data) {
  const masked = { ...data };
  delete masked.isNonReview;
  if (masked.rejectionReason === 'not_a_review') delete masked.rejectionReason;
  const cv = masked.contentVerification;
  if (cv && cv.wrongArticle === true && cv.wrongProduction !== true && cv.isFilmTv !== true) {
    masked.contentVerification = { ...cv, wrongArticle: false };
  }
  return masked;
}

function isNonReviewCorroborationCandidate(data, show, filePath) {
  // Lazy require: keeps this module's load graph unchanged for its many callers.
  const { isCvPromotedNonReviewCandidate } = require('./cv-promoted-nonreview-selector');
  if (!isCvPromotedNonReviewCandidate(data)) return false;
  // isNonReviewDemotedByFreshCV never demotes a human-set flag, so a score
  // there could corroborate nothing; don't spend on it.
  if (data.manualReviewedBy || data.manualNonReviewSet === true || data.manualNonReviewBy) return false;
  if (data.fullText.length < NONREVIEW_CORROBORATION_MIN_CHARS) return false;
  return isScoreable(maskCvNonReviewVerdict(data), show, filePath);
}

module.exports = {
  isScoreable,
  isNonReviewCorroborationCandidate,
  maskCvNonReviewVerdict,
  NONREVIEW_CORROBORATION_MIN_CHARS,
};
