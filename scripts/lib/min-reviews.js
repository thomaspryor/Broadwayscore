/**
 * Minimum-reviews thresholds + THE score-display gate.
 *
 * The constants mirror src/config/score-buckets.ts (scripts/lib/min-reviews.test.mjs
 * fails CI if they drift). The gate functions (reviewsRemainingForScore /
 * hasEnoughReviews) live ONLY here: score-buckets.ts re-exports them for the
 * website, and scripts/generate-mobile-show-details.js calls them for the slim
 * files, so both use one implementation (BRO-4312). Keep this file pure (no fs,
 * no path): it is bundled into client components through score-buckets.ts.
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
    case 'tour':
      return MIN_REVIEWS_OFF_BROADWAY;
    case 'off-west-end':
      return MIN_REVIEWS_OFF_WEST_END;
    case 'west-end':
      return MIN_REVIEWS_WEST_END;
    default:
      return MIN_REVIEWS;
  }
}

/**
 * How many more reviews a show needs before its Critic Score may be displayed.
 * Returns 0 when it qualifies. THE single implementation of the display gate:
 * src/config/score-buckets.ts re-exports this (website badges) and
 * scripts/generate-mobile-show-details.js calls it (slim-file `cs`), so the
 * site and the slim files cannot disagree on which shows carry a score
 * (BRO-4312: 7 curated historical shows showed a badge on the site while the
 * slim generator, lacking the curated carve-out, wrote no `cs`).
 *
 * @param {number} reviewCount - scored reviews counted by the scorer (`rc`)
 * @param {string} [category] - show market category
 * @param {number} [tier1And2Count] - T1 + T2 scored reviews; 0 → T3-only extra
 * @param {boolean} [isCuratedHistorical] - show is in data/curated-historical-shows.json
 * @returns {number}
 */
function reviewsRemainingForScore(reviewCount, category, tier1And2Count, isCuratedHistorical) {
  let min = getMarketMinReviews(category);
  // Curated historical override: only applies to Broadway (the bigger threshold)
  // and requires at least 1 T1+T2 review (so we don't accept e.g. 4 random blogs).
  // Intentionally NOT isBroadwayCategory: this file is browser-bundled (via
  // score-buckets.ts) and must stay dependency-free; same permissive form.
  if (isCuratedHistorical && (!category || category === 'broadway') && (tier1And2Count ?? 0) >= 1) {
    min = MIN_REVIEWS_CURATED_HISTORICAL;
  }
  if (tier1And2Count !== undefined && tier1And2Count === 0) {
    min += T3_ONLY_EXTRA;
  }
  return Math.max(0, min - reviewCount);
}

/**
 * True when a score meets the minimum threshold for display.
 * @param {number} reviewCount
 * @param {string} [category]
 * @param {number} [tier1And2Count]
 * @param {boolean} [isCuratedHistorical]
 * @returns {boolean}
 */
function hasEnoughReviews(reviewCount, category, tier1And2Count, isCuratedHistorical) {
  return reviewsRemainingForScore(reviewCount, category, tier1And2Count, isCuratedHistorical) === 0;
}

module.exports = {
  reviewsRemainingForScore,
  hasEnoughReviews,
  MIN_REVIEWS,
  MIN_REVIEWS_OFF_BROADWAY,
  MIN_REVIEWS_WEST_END,
  MIN_REVIEWS_OFF_WEST_END,
  MIN_REVIEWS_CURATED_HISTORICAL,
  T3_ONLY_EXTRA,
  getMarketMinReviews,
};
