/**
 * Wrong-Production Auto-Clear Decision
 *
 * Pure decision functions for deciding whether the rebuild's auto-clear
 * paths should strip wrongProduction / wrongShow flags from a review file.
 *
 * Background: rebuild-all-reviews.js has auto-clear paths that strip
 * wrongProduction when allowEarlyDate or allowCrossMarket is true.
 * Without guards, these paths strip flags even when the user/audit/CV
 * explicitly set wrongProduction with a reason — re-introducing
 * cross-market contamination on every rebuild.
 *
 * Used by:
 * - scripts/rebuild-all-reviews.js (main rebuild loop, allowEarlyDate auto-clear)
 * - tests/unit/wrong-production-autoclear.test.mjs
 */

/**
 * Decide whether the allowEarlyDate/allowCrossMarket auto-clear should
 * strip wrongProduction from a review file.
 *
 * Returns true ONLY if both conditions hold:
 *   - One of allowEarlyDate / allowCrossMarket is true (user explicit override)
 *   - There is NO explicit wrongProductionReason and NO high-confidence CV signal
 *     (so the flag is safe to clear)
 *
 * @param {object} data - The review JSON object
 * @returns {boolean} - true if it's safe to delete wrongProduction
 */
function shouldAutoClearWrongProduction(data) {
  if (data.wrongProduction !== true) return false;
  if (!data.allowEarlyDate && !data.allowCrossMarket) return false;
  const hasManualReason = !!data.wrongProductionReason;
  const cvConfirmedWrong = data.contentVerification?.wrongProduction === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrong;
}

/**
 * Same logic for wrongShow flag (parallel auto-clear path).
 *
 * @param {object} data
 * @returns {boolean}
 */
function shouldAutoClearWrongShow(data) {
  if (data.wrongShow !== true) return false;
  if (!data.allowEarlyDate && !data.allowCrossMarket) return false;
  const hasManualReason = !!data.wrongShowReason;
  const cvConfirmedWrong = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrong;
}

module.exports = {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
};
