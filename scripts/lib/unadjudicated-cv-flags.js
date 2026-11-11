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

/**
 * BRO-7344: the stuck CV-promoted exclusion. rebuild-all-reviews.js promotes a
 * contentVerification "not a review" verdict to isNonReview=true; a later or
 * differently-read CV may say articleType=review (high) with no other exclusion,
 * yet nothing releases it: the scorer skips flagged files, and the read-time
 * release (isNonReviewDemotedByFreshCV) wants an ensemble score that can never
 * come. 19 such files sat unread until a scan found them. This names the class so
 * an audit can list it for a human read. A file is NOT stuck when it carries any
 * adjudication: a human clear/override, an ensemble rejection, a duplicate pointer,
 * a manual reason, or an existing score (the rescore path owns it).
 */
function isStuckCvPromotedNonReview(record) {
  if (!record || record.isNonReview !== true || !record.contentVerificationPromoted) return false;
  const cv = record.contentVerification;
  if (!cv || cv.articleType !== 'review' || (cv.articleTypeConfidence || cv.confidence) !== 'high') return false;
  if (cv.wrongProduction === true || cv.isFilmTv === true || cv.wrongArticle === true || cv.clearRefusal) return false;
  if (require('./approved-fix-flag').hasApprovedFlag(record, 'isNonReview')) return false;
  if (record.llmScore || record.humanReviewScore != null) return false;
  if (record.wrongProduction === true || record.wrongShow === true || record.isRoundupArticle === true) return false;
  if (record.duplicateOf || record.rejectedAt || record._locked === true) return false;
  if (record.manualReviewedBy || record.manualNonReviewSet === true || record.manualNonReviewBy
    || record.nonReviewOverride || record.wrongShowOverride === true || cvNonReviewHumanCleared(record)) return false;
  if (typeof record.isNonReviewReason === 'string' && /^manual \(not a review\)/i.test(record.isNonReviewReason)) return false;
  const body = typeof record.fullText === 'string' ? record.fullText : '';
  return body.length >= 300;
}

/** @returns the files whose record is a stuck CV-promoted isNonReview (see above). */
function findStuckCvPromotedNonReview(files) {
  return files.filter((f) => isStuckCvPromotedNonReview(f.record));
}

module.exports = { CV_NOT_A_REVIEW_RE, isUnadjudicatedCvFlag, findUnadjudicatedCounted, isStuckCvPromotedNonReview, findStuckCvPromotedNonReview };
