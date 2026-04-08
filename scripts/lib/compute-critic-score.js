/**
 * Shared critic score computation for build-time scripts.
 *
 * SINGLE SOURCE OF TRUTH for the tier-weighted scoring formula.
 * Mirrors src/lib/engine.ts computeCriticScore() — if you change
 * the formula there, change it here too (or better: add a validation
 * step that catches drift).
 *
 * Used by: generate-mobile-data.js, generate-mobile-show-details.js
 */

const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.35 };
const DEFAULT_TIER = 3;

const DESIGNATION_BUMPS = { 'Critics_Pick': 3, 'Critics_Choice': 2 };
const DESIGNATION_FLOORS = { 'Critics_Pick': 70 };

const TOP_CRITICS = new Set([
  'Jesse Green', 'Ben Brantley', 'Charles Isherwood', 'David Rooney',
  'Hilton Als', 'Helen Shaw', 'Peter Marks', 'Elisabeth Vincentelli',
  'Adam Feldman', 'Linda Winer', 'Alexis Soloski', 'Sara Holdren',
  'Johnny Oleksinski', 'Chris Jones',
]);

/**
 * Compute tier-weighted composite critic score.
 *
 * @param {Array} showReviews - Reviews for a single show
 * @param {Object} outletRegistry - Outlet registry keyed by lowercase outletId
 * @returns {{ s: number, rc: number, t1: number } | null}
 */
function computeCriticScore(showReviews, outletRegistry = {}) {
  if (!showReviews || showReviews.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;
  let tier1Count = 0;
  let scoredCount = 0;

  for (const review of showReviews) {
    // Determine tier (top critics get T1 regardless of outlet)
    const isTopCritic = !!(review.criticName && TOP_CRITICS.has(review.criticName));
    const entry = outletRegistry[review.outletId?.toLowerCase()?.trim()];
    const tier = isTopCritic ? 1 : (entry?.tier || DEFAULT_TIER);
    const tierWeight = TIER_WEIGHTS[tier] || TIER_WEIGHTS[DEFAULT_TIER];

    // Determine score (same priority as engine.ts)
    let score = review.assignedScore;
    if (score == null && review.llmScore?.score != null) score = review.llmScore.score;
    if (score == null) continue; // Skip unscored reviews

    scoredCount++;

    // Apply designation bumps/floors
    if (review.designation) {
      if (DESIGNATION_FLOORS[review.designation]) {
        score = Math.max(score, DESIGNATION_FLOORS[review.designation]);
      }
      if (DESIGNATION_BUMPS[review.designation]) {
        score = Math.min(100, score + DESIGNATION_BUMPS[review.designation]);
      }
    }

    // Confidence weight based on content quality
    const thumbReflectedInScore = !!(review.dtliThumb || review.bwwThumb) && !review.needsReview;
    let confidenceWeight = 1.0;
    if (review.contentTier === 'excerpt' || review.contentTier === 'stub') {
      confidenceWeight = thumbReflectedInScore ? 0.75 : 0.5;
    } else if (review.contentTier === 'truncated') {
      confidenceWeight = 0.85;
    }

    weightedSum += score * tierWeight * confidenceWeight;
    totalWeight += tierWeight * confidenceWeight;

    if (tier === 1) tier1Count++;
  }

  if (totalWeight === 0) return null;

  // Keep 2 decimal places for tiebreaking in sort order
  const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;

  return {
    s: weightedScore,
    rc: scoredCount,
    t1: tier1Count,
  };
}

module.exports = { computeCriticScore, TIER_WEIGHTS, TOP_CRITICS, DEFAULT_TIER };
