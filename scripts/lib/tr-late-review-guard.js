'use strict';
/**
 * tr-late-review-guard.js (BRO-5420): Theatre Record is a London press archive.
 * A UK critic covering a Broadway production does so around its opening; a TR
 * review filed under a Broadway show and dated months after opening is a
 * review of a London production of the same title. chicago-1996 carried the
 * Daily Mail's 1997 review of the London Adelphi Chicago, live at 78, because
 * the importer only refused reviews dated BEFORE the show (isLikelyWrongProduction).
 *
 * Pure. True when the show is Broadway (isBroadwayCategory: null category counts), the review is dated more than
 * lagDays after opening, and the date is not inside a declared priorRuns or
 * tourLegs window (a London prior run or transfer is legitimate coverage).
 */
const { toDateMs } = require('./date-utils');
const { isBroadwayCategory } = require('./venue-classification');

function isLateTheatreRecordReviewOfBroadwayShow(show, publishDate, { lagDays = 60, isWithinPriorRun, isWithinTourLeg } = {}) {
  if (!show || !isBroadwayCategory(show) || !publishDate) return false;
  const openMs = toDateMs(show.openingDate || show.previewsStartDate || '');
  const pubMs = toDateMs(publishDate);
  if (Number.isNaN(openMs) || Number.isNaN(pubMs)) return false;
  if (pubMs <= openMs + lagDays * 86400000) return false;
  const d = new Date(pubMs);
  if (isWithinPriorRun && isWithinPriorRun(d, show.priorRuns)) return false;
  if (isWithinTourLeg && isWithinTourLeg(d, show.tourLegs)) return false;
  return true;
}

module.exports = { isLateTheatreRecordReviewOfBroadwayShow };
