/**
 * Shared critic score computation for build-time scripts.
 *
 * This is the JS-side mirror of src/lib/engine.ts::computeCriticScore().
 * Both implementations load tier data from src/config/outlet-tiers.json
 * so they cannot drift. If you change the SCORING FORMULA (dedup rules,
 * tier weights, designation bumps, confidence weights), you must update
 * BOTH this file AND engine.ts, and tests/unit/compute-critic-score.test.mjs
 * will fail if they disagree on a real show.
 *
 * Used by:
 *   - scripts/generate-mobile-data.js
 *   - scripts/generate-mobile-show-details.js
 *   - scripts/generate-homepage-archive.js
 *   - scripts/compute-gold-lists.js
 *   - scripts/preview-gold-lists.js
 *   - scripts/generate-social-post.js
 */

const path = require('path');

// v5 (2026-04-29): T4 added (0.20), T3 raised 0.35→0.40
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.40, 4: 0.20 };
const DEFAULT_TIER = 3;
// Off-market multiplier — applied to off-broadway / off-west-end reviews
const OFF_MARKET_MULTIPLIER = 0.8;

const DESIGNATION_BUMPS = { 'Critics_Pick': 3, 'Critics_Choice': 2 };
const DESIGNATION_FLOORS = { 'Critics_Pick': 70 };

// Tier overrides loaded from src/config/outlet-tiers.json — THE single
// source of truth for outlet tiers. Both scoring.ts (TypeScript side,
// via import) and this module (JS side, via require) load from the same
// file, so drift between the two code paths is impossible by construction.
// Before April 2026, a duplicate copy of this data in multiple files
// caused silent score drift — see memory/feedback_outlet_tiers_two_sources.md.
//
// v5 (2026-04-29): entries can declare `tiers: { nyc, london }` for region-
// aware lookup. Falls back to legacy `tier` field when showCategory absent.
const OUTLET_TIERS_DATA = require(path.join(__dirname, '..', '..', 'src', 'config', 'outlet-tiers.json'));
// Flatten to { id: { default, nyc?, london? } } for fast lookup
const OUTLET_TIER_OVERRIDES = {};
for (const [id, entry] of Object.entries(OUTLET_TIERS_DATA)) {
  const norm = { default: entry.tier };
  if (entry.tiers && typeof entry.tiers === 'object') {
    if (entry.tiers.nyc != null) norm.nyc = entry.tiers.nyc;
    if (entry.tiers.london != null) norm.london = entry.tiers.london;
  }
  OUTLET_TIER_OVERRIDES[id] = norm;
}

function _resolveOverrideTier(id, showCategory) {
  const entry = OUTLET_TIER_OVERRIDES[id];
  if (!entry) return undefined;
  if (showCategory) {
    const region = (showCategory === 'west-end' || showCategory === 'off-west-end') ? 'london' : 'nyc';
    if (entry[region] != null) return entry[region];
  }
  return entry.default;
}

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
 * @param {string} [showCategory] - Show market category for region-aware tier lookup
 *   (broadway / off-broadway / west-end / off-west-end). When omitted, uses default
 *   (NYC) tier — backwards-compatible with pre-v5 callers.
 * @param {string} [showType] - Show type override. When 'opera', all reviews count
 *   equally (forced T1, no off-market multiplier) since Met opera coverage doesn't
 *   follow theater's NYT-dominant tier hierarchy — Operawire, Parterre, NYCR are
 *   first-class voices.
 * @returns {{ s: number, rc: number, t1: number } | null}
 */
function computeCriticScore(showReviews, outletRegistry = {}, showCategory, showType) {
  const isOpera = showType === 'opera';
  if (!showReviews || showReviews.length === 0) return null;

  // Critic-level dedup: keep one review per (outlet, critic) pair, most recent by
  // publishDate. MUST match src/lib/engine.ts::computeCriticScore().
  //
  // Multi-critic outlets (NYSR, NYT, Variety, Vulture, EW, etc.) routinely
  // publish multiple critic reviews per show — distinct critics, distinct voices.
  // Earlier outlet-level dedup silently dropped all but one of these (~530 cases
  // across the corpus). Critic-level dedup keeps each critic but normalizes their
  // weight by 1/N where N is the count of distinct critics that outlet has on
  // this show. This preserves the original "one outlet = one tier vote" intent
  // while exposing every critic to the UI and SEO schema.
  const byCritic = new Map();
  for (const review of showReviews) {
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    const criticKey = (review.criticName || '__unknown__').toLowerCase();
    const key = `${outletKey}|${criticKey}`;
    const existing = byCritic.get(key);
    if (!existing || (review.publishDate || '') > (existing.publishDate || '')) {
      byCritic.set(key, review);
    }
  }
  const dedupedReviews = Array.from(byCritic.values());

  // Count distinct critics per outlet for per-outlet weight normalization.
  const criticCountByOutlet = new Map();
  for (const review of dedupedReviews) {
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    criticCountByOutlet.set(outletKey, (criticCountByOutlet.get(outletKey) || 0) + 1);
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let tier1Count = 0;
  let scoredCount = 0;

  for (const review of dedupedReviews) {
    // Determine tier (top critics get T1 regardless of outlet).
    // Lookup priority must match engine.ts::getOutletConfig():
    //   1. Top critic name → T1
    //   2. OUTLET_TIER_OVERRIDES (mirrors scoring.ts OUTLET_TIERS)
    //   3. outletRegistry (falls back to ~775 long-tail outlets)
    //   4. DEFAULT_TIER
    const isTopCritic = !!(review.criticName && TOP_CRITICS.has(review.criticName));
    const normalizedId = review.outletId?.toLowerCase()?.trim();
    const overrideTier = normalizedId ? _resolveOverrideTier(normalizedId, showCategory) : undefined;
    let registryTier;
    if (normalizedId && outletRegistry[normalizedId]) {
      const regEntry = outletRegistry[normalizedId];
      // Region-aware: prefer regEntry.tiers[region] if present
      if (showCategory && regEntry.tiers) {
        const region = (showCategory === 'west-end' || showCategory === 'off-west-end') ? 'london' : 'nyc';
        registryTier = regEntry.tiers[region] != null ? regEntry.tiers[region] : regEntry.tier;
      } else {
        registryTier = regEntry.tier;
      }
    }
    // Opera flat-weighting (2026-05-01): Met opera coverage doesn't follow
    // theater's tier hierarchy — Operawire, Parterre Box, NYCR, Bachtrack, CVA
    // are the equivalent of T1/T2 for opera. Force tier=1 for all opera reviews
    // and skip the off-market multiplier (opera shows are categorized as
    // off-broadway for routing but aren't off-market in any meaningful sense).
    const resolvedTier = isTopCritic ? 1 : (overrideTier || registryTier || DEFAULT_TIER);
    const tier = isOpera ? 1 : resolvedTier;
    const baseTierWeight = TIER_WEIGHTS[tier] || TIER_WEIGHTS[DEFAULT_TIER];
    const isOffMarket = !isOpera && (showCategory === 'off-broadway' || showCategory === 'off-west-end');
    const tierWeight = isOffMarket ? baseTierWeight * OFF_MARKET_MULTIPLIER : baseTierWeight;

    // Determine score. assignedScore is the canonical scoring output written by
    // scripts/rebuild-all-reviews.js (via getBestScore in scripts/lib/rebuild-helpers.js),
    // which is the single source of truth for per-review scoring including LLM
    // calibration. There is intentionally no llmScore fallback here: reviews.json
    // does not carry an llmScore object, and any future change that adds one would
    // silently bypass calibration if a fallback existed.
    let score = review.assignedScore;
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

    // Per-outlet share: divides each critic's effective weight by the number of
    // distinct critics that outlet has on this show, so the outlet still
    // contributes one full tier-vote (not N). Equivalent to averaging within
    // outlet then tier-weighting that average.
    const outletKey = (review.outletId || review.outlet || 'unknown').toLowerCase();
    const outletShare = 1 / (criticCountByOutlet.get(outletKey) || 1);

    weightedSum += score * tierWeight * confidenceWeight * outletShare;
    totalWeight += tierWeight * confidenceWeight * outletShare;

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

module.exports = { computeCriticScore, TIER_WEIGHTS, OFF_MARKET_MULTIPLIER, TOP_CRITICS, DEFAULT_TIER };
