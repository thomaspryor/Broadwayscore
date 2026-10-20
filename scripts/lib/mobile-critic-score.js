/**
 * The app feed's critic-score object (`cr` in public/data/mobile-shows.json),
 * built by scripts/generate-mobile-data.js.
 *
 *   s, rc, t1, t2  the shared scorer's numbers (scripts/lib/compute-critic-score.js,
 *                  the same module src/lib/engine.ts delegates to). Ungated:
 *                  older app builds read `s` and `rc` as they always have.
 *   l              the tier label the website's badge shows: the rounded score
 *                  against the market-aware thresholds (scripts/lib/score-tiers.js,
 *                  which src/config/score-buckets.ts re-exports). A West End 84
 *                  is "Recommended"; the 55-64 tier is "Mixed".
 *   q              1 when the score clears the website's review-count gate, 0 when
 *                  the site shows "CriticScore TBD": hasEnoughReviews
 *                  (scripts/lib/min-reviews.js) with the inputs the show page
 *                  passes: reviewCount, category, T1+T2 count, curated-historical.
 *
 * tests/unit/mobile-feed-website-parity.test.ts checks `l` and `q` against the
 * website's own functions for every show.
 */

const { computeCriticScore } = require('./compute-critic-score');
const { isCuratedHistoricalShow } = require('./should-hide-reviews');
const { hasEnoughReviews } = require('./min-reviews');
const { getScoreTierLabel } = require('./score-tiers');

/**
 * @param {{ id: string, category?: string, type?: string }} show
 * @param {Array<object>} showReviews - the show's reviews (reviews.json + blog reviews)
 * @param {Object} outletRegistry - data/outlet-registry.json `outlets`
 * @returns {{ s: number, rc: number, t1: number, t2: number, l: string, q: 0 | 1 } | null}
 */
function buildMobileCriticScore(show, showReviews, outletRegistry) {
  const result = computeCriticScore(showReviews, outletRegistry, show.category, show.type);
  if (!result) return null;
  return {
    ...result,
    l: getScoreTierLabel(result.s, show.category),
    q: hasEnoughReviews(result.rc, show.category, result.t1 + result.t2, isCuratedHistoricalShow(show.id)) ? 1 : 0,
  };
}

module.exports = { buildMobileCriticScore };
