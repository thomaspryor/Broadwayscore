'use strict';

/**
 * BRO-6055: the wrongProduction/wrongShow replacement branch in gather-reviews.js
 * swapped indecent-2017's Broadway TheaterMania URL (/broadway/reviews/...) for the
 * 2016 Vineyard review (/off-broadway/reviews/...), recreating a
 * wrong-production-by-date error. Probe of 8 off-broadway-path URLs on category
 * 'broadway' shows: 7 are flagged wrongProduction, 1 unflagged (straight-white-men-2018).
 *
 * True when `url` carries an /off-broadway/reviews/ path (TheaterMania shape) but the show is a
 * Broadway-category show that declares no priorRuns (so no earlier off-Broadway
 * run could legitimately own it).
 */
function isOffBroadwayUrlForBroadwayShow(url, show) {
  if (!url || !show) return false;
  if (show.category !== 'broadway') return false;
  if (Array.isArray(show.priorRuns) && show.priorRuns.length > 0) return false;
  return /\/off-broadway\/reviews\//i.test(String(url));
}

module.exports = { isOffBroadwayUrlForBroadwayShow };
