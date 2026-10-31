/**
 * THE critic score formula: the only implementation in the repo.
 *
 * Build-time scripts call computeCriticScore() (slim-file `cs`, gold lists,
 * homepage archive), and the website's src/lib/engine.ts::computeCriticScore()
 * delegates to scoreReviews() here (BRO-4312), so every page and the slim
 * files compute the same number by construction. Change the formula (dedup
 * rules, tier weights, designation bumps, confidence weights) HERE only.
 * tests/unit/critic-score-canonical-parity.test.ts checks every show's
 * displayed score against this module end to end.
 *
 * Also used by src/lib/engine.ts (website, server bundle only).
 *
 * Used by:
 *   - scripts/generate-mobile-data.js
 *   - scripts/generate-mobile-show-details.js
 *   - scripts/generate-homepage-archive.js
 *   - scripts/compute-gold-lists.js
 *   - scripts/preview-gold-lists.js
 */

const path = require('path');

// Tier weights, default tier, and off-market multiplier are SHARED with
// scripts/lib/outlet-tiers.js — re-imported here instead of duplicated so
// the two JS-side canonicals can't silently drift. Adding T5 to TIER_WEIGHTS
// in outlet-tiers.js automatically propagates here; tier-config-consistency
// test enforces the equivalent contract on the TS side too.
//
// (Previous comment claimed "drift between the two code paths is impossible
// by construction" but referred only to the outlet-tiers.json data file —
// the WEIGHTS themselves were duplicated. Codex flagged this 2026-05-16.)
const {
  TIER_WEIGHTS,
  DEFAULT_TIER,
  OFF_MARKET_MULTIPLIER,
} = require('./outlet-tiers');

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
// Static relative path (not path.join(__dirname, ...)) so webpack can bundle this
// module into src/lib/engine.ts, which delegates its scoring here (BRO-4312).
const OUTLET_TIERS_DATA = require('../../src/config/outlet-tiers.json');
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
 * Compute tier-weighted composite critic score with per-review detail.
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
 * @returns {{ s: number, rc: number, t1: number, t2: number, t3: number,
 *   reviews: Array<{ review: any, tier: number, tierWeight: number, reviewScore: number,
 *     confidenceWeight: number, outletShare: number, weightedScore: number }> } | null}
 *   `reviews` holds the deduped, SCORED reviews (assignedScore != null) in dedup order.
 */
function scoreReviews(showReviews, outletRegistry = {}, showCategory, showType) {
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
  let tier2Count = 0;
  let tier3Count = 0;
  let scoredCount = 0;
  const scored = [];

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

    const weightedScore = score * tierWeight * confidenceWeight * outletShare;
    weightedSum += weightedScore;
    totalWeight += tierWeight * confidenceWeight * outletShare;

    if (tier === 1) tier1Count++;
    if (tier === 2) tier2Count++;
    if (tier === 3) tier3Count++;
    scored.push({ review, tier, tierWeight, reviewScore: score, confidenceWeight, outletShare, weightedScore });
  }

  if (totalWeight === 0) return null;

  // Keep 2 decimal places for tiebreaking in sort order
  const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;

  return {
    s: weightedScore,
    rc: scoredCount,
    t1: tier1Count,
    t2: tier2Count,
    t3: tier3Count,
    reviews: scored,
  };
}

/**
 * Compute tier-weighted composite critic score (aggregate only).
 * Same inputs and null cases as scoreReviews().
 * @returns {{ s: number, rc: number, t1: number, t2: number } | null}
 */
function computeCriticScore(showReviews, outletRegistry = {}, showCategory, showType) {
  const r = scoreReviews(showReviews, outletRegistry, showCategory, showType);
  if (!r) return null;
  return { s: r.s, rc: r.rc, t1: r.t1, t2: r.t2 };
}

module.exports = { computeCriticScore, scoreReviews, DESIGNATION_BUMPS, DESIGNATION_FLOORS, TIER_WEIGHTS, OFF_MARKET_MULTIPLIER, TOP_CRITICS, DEFAULT_TIER };
