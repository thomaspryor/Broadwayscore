/**
 * Minimum-reviews thresholds for score display — CommonJS mirror of the
 * canonical TS constants in src/config/score-buckets.ts.
 *
 * WHY THIS FILE EXISTS: score-buckets.ts is browser-bundled (imported by client
 * components and static pages), so it must stay pure TS and cannot be require()'d
 * from a plain-node script. The slim-file generator
 * (scripts/generate-mobile-show-details.js) runs under `node`, not tsx, so it
 * needs a CommonJS source for the same numbers.
 *
 * These values MUST equal the score-buckets.ts constants. The parity test
 * scripts/lib/min-reviews.test.mjs imports both and fails CI if they drift —
 * change one, change the other, or the test goes red.
 */

// Mirrors MIN_REVIEWS_FOR_SCORE / _OFF_BROADWAY / _WEST_END / _OFF_WEST_END.
const MIN_REVIEWS = 5; // Broadway / default
const MIN_REVIEWS_OFF_BROADWAY = 3;
const MIN_REVIEWS_WEST_END = 5;
const MIN_REVIEWS_OFF_WEST_END = 3;
// Mirrors MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL.
const MIN_REVIEWS_CURATED_HISTORICAL = 4;
// Mirrors T3_ONLY_EXTRA_REVIEWS.
const T3_ONLY_EXTRA = 2;

/**
 * Base minimum-reviews threshold for a market (no T3-only / curated adjustment).
 * Matches src/lib/market-utils.getMarketMinReviews() and the per-market branch
 * in score-buckets.reviewsRemainingForScore().
 */
function getMarketMinReviews(category) {
  switch (category) {
    case 'off-broadway':
    case 'off-off-broadway':
    case 'regional':
      return MIN_REVIEWS_OFF_BROADWAY;
    case 'off-west-end':
      return MIN_REVIEWS_OFF_WEST_END;
    case 'west-end':
      return MIN_REVIEWS_WEST_END;
    default:
      return MIN_REVIEWS;
  }
}

module.exports = {
  MIN_REVIEWS,
  MIN_REVIEWS_OFF_BROADWAY,
  MIN_REVIEWS_WEST_END,
  MIN_REVIEWS_OFF_WEST_END,
  MIN_REVIEWS_CURATED_HISTORICAL,
  T3_ONLY_EXTRA,
  getMarketMinReviews,
};
