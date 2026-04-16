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

/**
 * Decide whether the WE/OB URL-year auto-clear path should strip wrongProduction.
 *
 * The URL-year guard sets wrongProduction=true when a review URL contains a year
 * that doesn't match the show's season. For West End and off-Broadway shows this
 * is a known false-positive source (transfers, unconventional year tags) and the
 * rebuild exempts them — but only if the flag wasn't set for some OTHER explicit
 * reason (manual audit, high-confidence CV).
 *
 * Callers pass `isLondonOrOffBroadway` so this lib stays decoupled from
 * isLondonMarket() / show-category imports.
 *
 * @param {object} data
 * @param {object} ctx
 * @param {boolean} ctx.isLondonOrOffBroadway - true if showCat is london/off-broadway
 * @returns {boolean}
 */
function shouldAutoClearWrongProductionUrlYear(data, { isLondonOrOffBroadway } = {}) {
  if (data.wrongProduction !== true) return false;
  if (!data.wrongProductionNote || !data.wrongProductionNote.includes('URL contains year')) return false;
  if (!isLondonOrOffBroadway) return false;
  const hasManualReason = !!data.wrongProductionReason;
  const cvConfirmedWrong = data.contentVerification?.wrongProduction === true
    && data.contentVerification?.confidence === 'high';
  const cvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrong && !cvConfirmedWrongArticle;
}

/**
 * Decide whether the UK-URL wrongShow auto-clear path should strip wrongShow.
 *
 * When wrongShow was set on a London-market file whose URL is a UK outlet,
 * it's almost always an LLM false-positive (UK outlets only cover London
 * theatre). But: respect manual wrongShowReason, CV-confirmed wrongArticle,
 * and date-mismatches (review >90 days before open = prior production).
 *
 * Callers pass `isLondonMarketShow`, `isUkOutletUrl`, `dateMismatchOver90d`
 * so this lib stays decoupled from venue-classification / parseDate.
 *
 * @param {object} data
 * @param {object} ctx
 * @param {boolean} ctx.isLondonMarketShow
 * @param {boolean} ctx.isUkOutletUrl
 * @param {boolean} ctx.dateMismatchOver90d
 * @returns {boolean}
 */
function shouldAutoClearWrongShowUkUrl(data, { isLondonMarketShow, isUkOutletUrl, dateMismatchOver90d } = {}) {
  if (data.wrongShow !== true) return false;
  if (!isLondonMarketShow) return false;
  if (!isUkOutletUrl) return false;
  if (dateMismatchOver90d) return false;
  const isWrongArticle = data.contentVerification?.wrongArticle === true;
  const hasManualReason = !!data.wrongShowReason;
  return !isWrongArticle && !hasManualReason;
}

module.exports = {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  shouldAutoClearWrongProductionUrlYear,
  shouldAutoClearWrongShowUkUrl,
};
