'use strict';
/**
 * The daily outlet-listing poller reads every feed the opening-night lane reads (BRO-6965).
 *
 * LANE_FEEDS (scripts/lib/opening-night-lane/lane-sources.js) is the list of outlet feeds the lane polls on opening
 * night. A feed the lane reads but the daily poller does not leaves preview-period reviews unfound until a reader
 * submits one (Bob's Theater Blog, A Few Good Men and Other Desert Cities). This file derives a daily-poller config for
 * every LANE_FEEDS outlet the poller does not already read, and the per-item rules that go with it. It requires the
 * lane's data and functions; it copies none of their logic. The lane directory is not edited.
 */
const { LANE_FEEDS, laneMarket, outletInMarket } = require('./opening-night-lane/lane-sources');
const { hasReviewSignal, headlineIsShowTitle } = require('./opening-night-lane/discovery');

/**
 * Poller config entries for LANE_FEEDS outlets that `configured` (OUTLET_STRATEGY_CONFIG plus WP_API_CONFIG, keyed by
 * outletId) does not cover. `laneRules` marks them for laneFeedAccepts below.
 */
function dailyLaneFeedConfigs(configured, skipOutlets = new Set()) {
  const out = {};
  for (const f of LANE_FEEDS) {
    if (configured[f.outletId] || skipOutlets.has(f.outletId)) continue;
    out[f.outletId] = {
      strategy: 'rss',
      url: f.url,
      laneRules: true,
      ...(f.reviewsOnly ? { reviewsOnly: true } : {}),
      ...(f.titledReviews ? { titledReviews: true } : {}),
    };
  }
  return out;
}

/**
 * Whether a feed item may be filed under `show` for a laneRules outlet, on the lane's rules:
 *  - market: the outlet must sit in the show's market (laneMarket / outletInMarket);
 *  - titledReviews (Bob's): only a headline that is the show title alone is a review;
 *  - reviewsOnly: the feed carries nothing but reviews;
 *  - otherwise: a review word (or star rating, or /review/ path) must be in the headline or URL.
 * The show-title match itself stays with findMatchingShows.
 */
function laneFeedAccepts(cfg, outletId, item, show) {
  if (!cfg || !cfg.laneRules) return true;
  if (!outletInMarket(outletId, laneMarket(show))) return false;
  if (cfg.titledReviews) return headlineIsShowTitle(item.headline, show.title);
  if (cfg.reviewsOnly) return true;
  return hasReviewSignal(item.url, item.headline);
}

module.exports = { dailyLaneFeedConfigs, laneFeedAccepts };
