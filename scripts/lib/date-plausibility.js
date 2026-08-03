/**
 * Ingest-time date-plausibility guard: pure decision for whether a review's
 * publishDate lands implausibly far before the show's earliest date, which
 * almost always means a different production of the same title leaked onto
 * this show's entry.
 *
 * Extracted from validate-data.js's [wrong-production-by-date] CHECK 0
 * (Notion 386637c5) so the same 180-day/priorRuns/humanReviewScore logic can
 * gate NEW review writes at ingest (review-write-guard.js safeWriteReview)
 * instead of only catching the problem post-commit on main. 5 incidents of
 * this class: sylvia (#499), crocodile (#730, recurred #832), oscar (#738),
 * cyrano (#832).
 */
const { earliestShowDate } = require('./date-guard');
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');
const { parseDate: parsePlausibilityDate } = require('./date-utils');

const DAYS_IMPLAUSIBLE_BEFORE = 180;

/**
 * @param {object} args
 * @param {object} args.review - review data (publishDate, humanReviewScore,
 *   wrongShow/wrongProduction/wrongUrl/duplicateOf/isRoundupArticle/isNotReview)
 * @param {object} args.show - show record (previewDate/previewsStartDate/openingDate, priorRuns)
 * @returns {{ implausible: boolean, daysBefore: number|null, earliestDate: string|null, reason: string|null }}
 */
function evaluateDatePlausibility({ review, show }) {
  const empty = { implausible: false, daysBefore: null, earliestDate: null, reason: null };
  if (!review || !show) return empty;

  // Already-flagged / operator-scored reviews are out of scope — same
  // carve-out as validate-data.js CHECK 0. An operator-trust override
  // (allowEarlyDate etc.) is deliberately NOT exempted here, matching CHECK 0.
  if (review.wrongShow || review.wrongProduction || review.wrongUrl || review.duplicateOf
    || review.isRoundupArticle || review.isNotReview || review.humanReviewScore) {
    return empty;
  }

  if (!review.publishDate) return empty;

  const pub = parsePlausibilityDate(review.publishDate);
  const earliestStr = earliestShowDate(show);
  const earliestD = earliestStr ? parsePlausibilityDate(earliestStr) : null;
  if (!pub || !earliestD) return { ...empty, earliestDate: earliestStr };

  const daysBefore = Math.round((earliestD.getTime() - pub.getTime()) / 86400000);
  if (
    daysBefore > DAYS_IMPLAUSIBLE_BEFORE &&
    !isWithinPriorRun(pub, show.priorRuns) &&
    !isWithinTourLeg(pub, show.tourLegs)
  ) {
    return { implausible: true, daysBefore, earliestDate: earliestStr, reason: 'date_implausible' };
  }
  return { implausible: false, daysBefore, earliestDate: earliestStr, reason: null };
}

module.exports = { evaluateDatePlausibility, parsePlausibilityDate, DAYS_IMPLAUSIBLE_BEFORE };
