'use strict';
/**
 * Drop a Show Score rating that came from a UK page (BRO-7434).
 *
 * The scraper finds a US show's cached Show Score URL now serving London's page. It used to clear the
 * stale rating only in memory, which a shard run never saves, so merge-show-score-shards.js kept the
 * London rating until purge-uk-show-score-audience.js was run by hand (a-moon-for-the-misbegotten-2007
 * on 2026-11-22, jerusalem-2011 on 2026-11-25). Shards now record the page's rating and the merge
 * applies it through this one routine, which the single-process scraper uses too.
 *
 * Pure: mutates only the audienceBuzz record passed in; callers load and save the file.
 */
const { storedRatingMatchesPage } = require('./show-score-canonical');
const { removeSourceWithTombstone } = require('./reconcile-audience-buzz');
const { calculateCombinedScore, getDesignation } = require('./audience-weighting');

/**
 * @param {object} rec audience-buzz.json shows[showId] (may be undefined)
 * @param {{score:number,count:number}|null} pageRating rating printed on the UK page (pageRatingOf)
 * @param {object} [show] shows.json entry (status/closingDate/category feed the weighting)
 * @returns {{removed: boolean, combinedScore?: number|null}}
 */
function dropUkShowScoreRating(rec, pageRating, show) {
  if (!rec || !rec.sources || !rec.sources.showScore) return { removed: false };
  // Only when the stored rating IS the UK page's: a transient London page proves nothing about a
  // rating scraped earlier from the right page (same proof as purge-uk-show-score-audience.js).
  if (!storedRatingMatchesPage(rec.sources.showScore, pageRating)) return { removed: false };
  removeSourceWithTombstone(rec, 'showScore', 'Show Score page is a UK production page (canonical /uk/london/...) (BRO-5499)');
  const { score } = calculateCombinedScore(rec.sources, show ? { status: show.status, closingDate: show.closingDate, category: show.category } : undefined);
  rec.combinedScore = score ?? null;
  rec.designation = score == null ? null : getDesignation(score);
  return { removed: true, combinedScore: rec.combinedScore };
}

module.exports = { dropUkShowScoreRating };
