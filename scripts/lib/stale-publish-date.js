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
 * Judges the EXISTING date only — it does not know or care whether a fresh
 * date was also recovered this run. That decision (correct with the fresh
 * value vs. clear to null) belongs to the caller: the normal review-file-
 * writer.js merge only fills BLANK fields (never overwrites a truthy
 * existing value — see _mergeIntoExisting's `!existing[key]` guard), so a
 * stale-but-truthy publishDate would otherwise survive a successful re-scrape
 * forever even when a correct fresh date WAS recovered.
 */

'use strict';

const { parseDate } = require('./date-utils');
const { earliestShowDate, evaluatePreWindowInclusion } = require('./date-guard');
const { isLondonMarket } = require('./venue-classification');

/**
 * @param {object} opts
 * @param {string|null|undefined} opts.existingPublishDate - publishDate currently on file
 * @param {object} opts.show - show record (previewDate/previewsStartDate/openingDate/
 *   category/priorRuns/tourLegs)
 * @returns {boolean} true when existingPublishDate is provably too early for this show
 */
function isStalePublishDate({ existingPublishDate, show }) {
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
