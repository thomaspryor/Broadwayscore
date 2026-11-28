/**
 * merge-date-guard.js (BRO-3503)
 *
 * createReviewFile() runs its URL-date wrongProduction guards
 * (getWrongProductionReasonForUnknownCritic, getWrongProductionReasonForBww)
 * only on the NEW-FILE path. The merge/replace branches above it (an existing
 * file for the same outlet+critic slot) returned first, so a cross-production
 * URL that matched an existing slot merged straight in: the guard never ran,
 * and the existing file took the wrong production's URL (and, after
 * collect-review-texts refetched it, its text).
 *
 * The new-file path FLAGS a guarded review (wrongProduction + note) and keeps
 * the record. A merge can't do that without condemning the existing file,
 * which may be a good review of this production, so the merge path REFUSES the
 * incoming write instead and leaves the existing file untouched.
 *
 * Pure decision; gather-reviews.js does the I/O.
 */

const { getWrongProductionReasonForUnknownCritic, getWrongProductionReasonForBww } = require('./review-guards');
const { laneBypasses } = require('./opening-night-lane/trust-model');

/**
 * The reason the incoming review's URL belongs to another production, or null.
 * Same guards, same order and same lane exemption as the new-file path.
 */
function incomingCrossProductionReason(reviewData, show) {
  if (!reviewData || !show || !reviewData.url) return null;
  if (laneBypasses(reviewData, 'wrongProduction', { openingDate: show.openingDate })) return null;
  return getWrongProductionReasonForUnknownCritic(reviewData, show)
    || getWrongProductionReasonForBww(reviewData, show)
    || null;
}

/**
 * Whether merging `reviewData` into `existingReview` must be refused.
 * Re-gathering the SAME url is not a new claim (the file already went through
 * the guard when it was created), so only a different incoming url is refused.
 *
 * @param {object} existingReview
 * @param {object} reviewData
 * @param {string|null} reason from incomingCrossProductionReason
 * @param {(u: string) => string} normalizeUrl
 * @returns {string|null} the reason to log, or null to let the merge proceed
 */
function crossProductionMergeRefusal(existingReview, reviewData, reason, normalizeUrl) {
  if (!reason) return null;
  if (existingReview && existingReview.url && normalizeUrl(existingReview.url) === normalizeUrl(reviewData.url)) return null;
  return reason;
}

module.exports = { incomingCrossProductionReason, crossProductionMergeRefusal };
