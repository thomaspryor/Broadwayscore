/**
 * Unit tests for src/lib/engine.ts — the core scoring engine
 *
 * Tests all exported pure functions with realistic Broadway data.
 * Run with: npx tsx --test tests/unit/engine.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  computeCriticScore,
  computeAudienceScore,
  computeCompositeScore,
  assessConfidence,
  getOutletConfig,
  type RawReview,
  type RawAudience,
  type CriticScoreResult,
} from '../../src/lib/engine';

// ===========================================
// TEST HELPERS — Minimal review/audience builders
// ===========================================

function makeReview(overrides: Partial<RawReview> = {}): RawReview {
  return {
    showId: 'hamilton-2015',
    outlet: 'The New York Times',
    outletId: 'nytimes',
    url: 'https://nytimes.com/review',
    publishDate: '2015-08-06',
    ...overrides,
  };
}

function makeAudience(overrides: Partial<RawAudience> = {}): RawAudience {
  return {
    showId: 'hamilton-2015',
    platform: 'showscore',
    platformName: 'Show-Score',
    averageRating: 90,
    maxRating: 100,
    reviewCount: 200,
    lastUpdated: '2026-03-01',
    ...overrides,
  };
}

// ===========================================
// computeCriticScore
// ===========================================

describe('computeCriticScore', () => {
  test('returns null for empty reviews', () => {
    assert.strictEqual(computeCriticScore([]), null);
  });

  test('single T1 review with assignedScore', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 85 }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.reviewCount, 1);
    assert.strictEqual(result.tier1Count, 1);
    assert.strictEqual(result.reviews[0].tier, 1);
    assert.strictEqual(result.reviews[0].tierWeight, 1.0);
    assert.strictEqual(result.reviews[0].reviewScore, 85);
    // Weighted score = 85 * 1.0 * 1.0 / 1.0 = 85
    assert.strictEqual(result.weightedScore, 85);
  });

  test('single T2 review', () => {
    const result = computeCriticScore([
      makeReview({ outletId: 'nypost', outlet: 'NY Post', assignedScore: 80 }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.tier2Count, 1);
    assert.strictEqual(result.reviews[0].tier, 2);
    assert.strictEqual(result.reviews[0].tierWeight, 0.75);
    // Weighted: 80 * 0.75 / 0.75 = 80
    assert.strictEqual(result.weightedScore, 80);
  });

  test('single T3 review (unknown outlet)', () => {
    const result = computeCriticScore([
      makeReview({ outletId: 'some-blog', outlet: 'Some Blog', assignedScore: 70 }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.tier3Count, 1);
    assert.strictEqual(result.reviews[0].tier, 3);
    assert.strictEqual(result.reviews[0].tierWeight, 0.35);
    // Weighted: 70 * 0.35 / 0.35 = 70
    assert.strictEqual(result.weightedScore, 70);
  });

  test('mixed tiers: T1 and T3 weighted correctly', () => {
    const result = computeCriticScore([
      makeReview({ outletId: 'nytimes', assignedScore: 90 }),
      makeReview({ outletId: 'some-blog', outlet: 'Blog', assignedScore: 60 }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.reviewCount, 2);
    assert.strictEqual(result.tier1Count, 1);
    assert.strictEqual(result.tier3Count, 1);
    // T1: 90 * 1.0 = 90, T3: 60 * 0.35 = 21
    // Total weight: 1.0 + 0.35 = 1.35
    // Weighted avg: (90 + 21) / 1.35 = 82.22...
    const expected = Math.round(((90 * 1.0 + 60 * 0.35) / (1.0 + 0.35)) * 100) / 100;
    assert.strictEqual(result.weightedScore, expected);
  });

  // NOTE: `llmScore` fallback was removed from RawReview and computeCriticScore
  // in commit 3c11ddd675 (Phase A LLM calibration curve). assignedScore is now
  // the single source of truth — rebuild-all-reviews.js writes the calibrated
  // LLM score directly into assignedScore via getBestScore(), so there is no
  // runtime code path that reads llmScore. The two tests that lived here
  // asserting llmScore fallback behavior have been deleted because the
  // behavior they covered no longer exists.

  test('originalRating letter grade parsed correctly', () => {
    const result = computeCriticScore([
      makeReview({ originalRating: 'B+' }),
    ]);
    assert.ok(result);
    // B+ = 80 from LETTER_GRADE_MAP
    assert.strictEqual(result.reviews[0].assignedScore, 80);
  });

  test('originalRating star format parsed correctly', () => {
    const result = computeCriticScore([
      makeReview({ originalRating: '4/5' }),
    ]);
    assert.ok(result);
    // 4/5 = 80
    assert.strictEqual(result.reviews[0].assignedScore, 80);
  });

  test('designation bump applied', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 80, designation: 'Critics_Pick' }),
    ]);
    assert.ok(result);
    // Critics_Pick bump = +3, so 83
    assert.strictEqual(result.reviews[0].reviewScore, 83);
  });

  test('designation floor applied', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 60, designation: 'Critics_Pick' }),
    ]);
    assert.ok(result);
    // Critics_Pick floor = 70, bump = +3, so max(60, 70) + 3 = 73
    assert.strictEqual(result.reviews[0].reviewScore, 73);
  });

  test('excerpt/stub content tier reduces confidence weight', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 80, contentTier: 'excerpt' }),
    ]);
    assert.ok(result);
    // Excerpt without thumb = 0.5 confidence weight
    assert.strictEqual(result.reviews[0].confidenceWeight, 0.5);
  });

  test('excerpt with thumb gets higher confidence weight', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 80, contentTier: 'excerpt', dtliThumb: 'Up' }),
    ]);
    assert.ok(result);
    // Excerpt with thumb = 0.75 confidence weight
    assert.strictEqual(result.reviews[0].confidenceWeight, 0.75);
  });

  test('truncated content tier gets 0.85 weight', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 80, contentTier: 'truncated' }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.reviews[0].confidenceWeight, 0.85);
  });

  test('complete content tier gets 1.0 weight', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 80, contentTier: 'complete' }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.reviews[0].confidenceWeight, 1.0);
  });

  test('needsReview prevents thumb from boosting confidence', () => {
    const result = computeCriticScore([
      makeReview({ assignedScore: 80, contentTier: 'excerpt', dtliThumb: 'Up', needsReview: true }),
    ]);
    assert.ok(result);
    // needsReview=true → thumb not counted → 0.5 instead of 0.75
    assert.strictEqual(result.reviews[0].confidenceWeight, 0.5);
  });

  test('reviews sorted by reviewScore descending', () => {
    const result = computeCriticScore([
      makeReview({ outletId: 'nytimes', assignedScore: 60 }),
      makeReview({ outletId: 'variety', assignedScore: 90 }),
      makeReview({ outletId: 'vulture', assignedScore: 75 }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.reviews[0].reviewScore, 90);
    assert.strictEqual(result.reviews[1].reviewScore, 75);
    assert.strictEqual(result.reviews[2].reviewScore, 60);
  });

  test('label reflects score range', () => {
    const gold = computeCriticScore([makeReview({ assignedScore: 90 })]);
    assert.ok(gold);
    assert.strictEqual(gold.label, 'Critical Gold');

    const recommended = computeCriticScore([makeReview({ assignedScore: 78 })]);
    assert.ok(recommended);
    assert.strictEqual(recommended.label, 'Recommended');

    const worthSeeing = computeCriticScore([makeReview({ assignedScore: 68 })]);
    assert.ok(worthSeeing);
    assert.strictEqual(worthSeeing.label, 'Worth Seeing');

    const skippable = computeCriticScore([makeReview({ assignedScore: 55 })]);
    assert.ok(skippable);
    assert.strictEqual(skippable.label, 'Skippable');

    const stayAway = computeCriticScore([makeReview({ assignedScore: 30 })]);
    assert.ok(stayAway);
    assert.strictEqual(stayAway.label, 'Critical Miss');
  });

  test('default score is 50 when no score source available', () => {
    const result = computeCriticScore([
      makeReview({}), // No assignedScore, no llmScore, no originalRating
    ]);
    assert.ok(result);
    assert.strictEqual(result.reviews[0].assignedScore, 50);
  });
});

// ===========================================
// computeAudienceScore
// ===========================================

describe('computeAudienceScore', () => {
  test('returns null for empty data', () => {
    assert.strictEqual(computeAudienceScore([]), null);
  });

  test('single platform score mapped correctly', () => {
    const result = computeAudienceScore([
      makeAudience({ averageRating: 4, maxRating: 5 }),
    ]);
    assert.ok(result);
    // 4/5 = 80
    assert.strictEqual(result.score, 80);
    assert.strictEqual(result.totalReviewCount, 200);
  });

  test('divergence warning when platforms differ >20 points', () => {
    const result = computeAudienceScore([
      makeAudience({ platform: 'showscore', averageRating: 90, maxRating: 100 }),
      makeAudience({ platform: 'mezzanine', averageRating: 60, maxRating: 100 }),
    ]);
    assert.ok(result);
    assert.ok(result.divergenceWarning);
    assert.ok(result.divergenceWarning.includes('30'));
  });

  test('no divergence warning when platforms are close', () => {
    const result = computeAudienceScore([
      makeAudience({ platform: 'showscore', averageRating: 85, maxRating: 100 }),
      makeAudience({ platform: 'mezzanine', averageRating: 80, maxRating: 100 }),
    ]);
    assert.ok(result);
    assert.strictEqual(result.divergenceWarning, undefined);
  });
});

// ===========================================
// computeCompositeScore
// ===========================================

describe('computeCompositeScore', () => {
  test('returns null when all inputs are null', () => {
    assert.strictEqual(computeCompositeScore(null, null, null), null);
  });

  test('critic-only normalizes to 100% weight', () => {
    const result = computeCompositeScore(80, null, null);
    assert.strictEqual(result, 80);
  });

  test('critic + audience uses correct weights', () => {
    // critic=80 (weight 0.50), audience=90 (weight 0.35)
    // Normalized: critic=0.50/0.85=0.588, audience=0.35/0.85=0.412
    // Score = 80*0.588 + 90*0.412 = 47.06 + 37.06 = 84.12 (2dp for sort tiebreaking)
    const result = computeCompositeScore(80, 90, null);
    assert.strictEqual(result, 84.12);
  });

  test('all three components', () => {
    // critic=80 (0.50), audience=90 (0.35), buzz=70 (0.15) — weights sum to 1.0
    // Score = 80*0.50 + 90*0.35 + 70*0.15 = 40 + 31.5 + 10.5 = 82
    const result = computeCompositeScore(80, 90, 70);
    assert.strictEqual(result, 82);
  });

  test('audience-only normalizes correctly', () => {
    const result = computeCompositeScore(null, 75, null);
    assert.strictEqual(result, 75);
  });
});

// ===========================================
// assessConfidence
// ===========================================

describe('assessConfidence', () => {
  test('no critic score = low confidence', () => {
    const result = assessConfidence(null, null, 'open');
    assert.strictEqual(result.level, 'low');
    assert.ok(result.reasons[0].includes('No critic reviews'));
  });

  test('high confidence: 15+ reviews with 2+ T1', () => {
    const criticScore: CriticScoreResult = {
      score: 80,
      weightedScore: 80,
      reviewCount: 20,
      tier1Count: 3,
      tier2Count: 10,
      tier3Count: 7,
      label: 'Positive',
      reviews: [],
    };
    const result = assessConfidence(criticScore, null, 'open');
    assert.strictEqual(result.level, 'high');
  });

  test('medium confidence: 6-14 reviews', () => {
    const criticScore: CriticScoreResult = {
      score: 75,
      weightedScore: 75,
      reviewCount: 8,
      tier1Count: 1,
      tier2Count: 4,
      tier3Count: 3,
      label: 'Positive',
      reviews: [],
    };
    const result = assessConfidence(criticScore, null, 'open');
    assert.strictEqual(result.level, 'medium');
  });

  test('low confidence: <6 reviews', () => {
    const criticScore: CriticScoreResult = {
      score: 70,
      weightedScore: 70,
      reviewCount: 3,
      tier1Count: 1,
      tier2Count: 1,
      tier3Count: 1,
      label: 'Positive',
      reviews: [],
    };
    const result = assessConfidence(criticScore, null, 'open');
    assert.strictEqual(result.level, 'low');
  });
});

// ===========================================
// getOutletConfig
// ===========================================

describe('getOutletConfig', () => {
  test('known T1 outlet by ID', () => {
    const config = getOutletConfig('nytimes');
    assert.strictEqual(config.tier, 1);
    assert.strictEqual(config.name, 'The New York Times');
  });

  test('known T2 outlet by ID', () => {
    const config = getOutletConfig('nypost');
    assert.strictEqual(config.tier, 2);
  });

  test('unknown outlet defaults to tier 3', () => {
    const config = getOutletConfig('totally-unknown-blog-xyz');
    assert.strictEqual(config.tier, 3);
  });

  test('case insensitive lookup', () => {
    const config = getOutletConfig('NYTIMES');
    assert.strictEqual(config.tier, 1);
  });

  test('name fallback lookup', () => {
    const config = getOutletConfig(undefined, 'The New York Times');
    assert.strictEqual(config.tier, 1);
  });
});
