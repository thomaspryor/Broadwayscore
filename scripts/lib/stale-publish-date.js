/**
 * Detect a review file's on-disk publishDate that is provably stale relative
 * to the show it belongs to — i.e. it would trip rebuild-all-reviews.js's
 * date guard (evaluatePreWindowInclusion) even though the URL currently on
 * file has just been re-verified as the right show's own review page.
 *
 * BRO-462: thestage--anna-james.json on anansi-the-spider-west-end-2026 kept
 * publishDate "January 26th, 2023" (leftover from a since-corrected URL that
 * pointed at a 2023 Unicorn Theatre production) after its URL was fixed to
 * the real 2026 Regent's Park review. review-guards.js's explainExclusion()
 * mirror doesn't model this date guard at all (isPrematureReviewForUnopenedShow
 * only fires pre-opening), so the mirror said "includable" while the real
 * rebuild silently excluded the file forever — a stale field neither ingest
 * path nor the guard mirror had a mechanism to notice or clear.
 *
 * Only meaningful when NO fresh publishDate was recovered from the current
 * fetch — a fresh date always wins via the normal merge path, this helper
 * exists for the "current fetch found nothing new, but what's already on
 * file is provably wrong" case.
 */

'use strict';

const { parseDate } = require('./date-utils');
const { earliestShowDate, evaluatePreWindowInclusion } = require('./date-guard');
const { isLondonMarket } = require('./venue-classification');

/**
 * @param {object} opts
 * @param {string|null|undefined} opts.existingPublishDate - publishDate currently on file
 * @param {string|null|undefined} opts.freshPublishDate - publishDate recovered from the
 *   current fetch, if any. A truthy value always short-circuits to false — the
 *   normal merge path handles genuine updates.
 * @param {object} opts.show - show record (previewDate/previewsStartDate/openingDate/
 *   category/priorRuns/tourLegs)
 * @returns {boolean} true when existingPublishDate should be cleared
 */
function isStalePublishDate({ existingPublishDate, freshPublishDate, show }) {
  if (freshPublishDate) return false;
  if (!existingPublishDate || !show) return false;
  const pubDate = parseDate(existingPublishDate);
  if (!pubDate || isNaN(pubDate.getTime())) return false;
  const earliestStr = earliestShowDate(show);
  if (!earliestStr) return false;
  const showEarliest = new Date(`${earliestStr}T00:00:00Z`);
  if (isNaN(showEarliest.getTime())) return false;
  const isFlexCategory = show.category === 'off-broadway' || isLondonMarket(show.category);
  const verdict = evaluatePreWindowInclusion({
    pubDate,
    showEarliest,
    isFlexCategory,
    priorRuns: show.priorRuns,
    tourLegs: show.tourLegs,
  });
  return verdict.exclude === true;
}

module.exports = { isStalePublishDate };
