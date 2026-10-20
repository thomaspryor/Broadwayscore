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
 *                  This is the website card and badge rule.
 *   pq             1 when the website's show page shows the score: `q`'s gate,
 *                  previews/upcoming always TBD, then the coverage floor
 *                  (scripts/lib/coverage-floor.js: a score public for 24h+
 *                  stays shown; a never-public score waits while known reviews
 *                  are missing). Differs from `q` for a few dozen shows.
 *
 * tests/unit/mobile-feed-website-parity.test.ts checks `l`, `q` and `pq`
 * against the website's own functions for every show.
 */

const { computeCriticScore } = require('./compute-critic-score');
const { isCuratedHistoricalShow } = require('./should-hide-reviews');
const { hasEnoughReviews } = require('./min-reviews');
const { getScoreTierLabel } = require('./score-tiers');
const { applyCoverageFloor } = require('./coverage-floor');

/**
 * @param {{ id: string, category?: string, type?: string, status?: string }} show
 * @param {Array<object>} showReviews - the show's reviews (reviews.json + blog reviews)
 * @param {Object} outletRegistry - data/outlet-registry.json `outlets`
 * @param {{scorePublicSince?: string, coverageState?: string, coverageAcked?: boolean, now?: number}} [floorOpts]
 *   the show's coverage floor inputs (coverageFloorOptsForShow in
 *   scripts/lib/coverage-floor-inputs.js); omitted means no stamp, no verdict
 * @returns {{ s: number, rc: number, t1: number, t2: number, l: string, q: 0 | 1, pq: 0 | 1 } | null}
 */
function buildMobileCriticScore(show, showReviews, outletRegistry, floorOpts = {}) {
  const result = computeCriticScore(showReviews, outletRegistry, show.category, show.type);
  if (!result) return null;
  const enough = hasEnoughReviews(result.rc, show.category, result.t1 + result.t2, isCuratedHistoricalShow(show.id));
  // Same expression as the website show page's showTBD (src/app/show/[slug]/page.tsx).
  const pageTBD = applyCoverageFloor(
    !enough || show.status === 'previews' || show.status === 'upcoming',
    floorOpts,
  );
  return {
    ...result,
    l: getScoreTierLabel(result.s, show.category),
    q: enough ? 1 : 0,
    pq: pageTBD ? 0 : 1,
  };
}

module.exports = { buildMobileCriticScore };
