/**
 * Unit tests for getBreakdownTier — the classifier used by ScoreBreakdownBar
 * on the show page header card. Thresholds deliberately diverge from the
 * ScoreBadge/score-buckets 5-tier taxonomy: the bar uses 4 sentiment-oriented
 * tiers with a 70 floor for "Positive" (a soft recommend) and a market-aware
 * gold threshold for "Rave".
 *
 * Run with: npx tsx --test tests/unit/score-breakdown-tier.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { getBreakdownTier } from '../../src/components/show-cards/ScoreBreakdownBar';

describe('getBreakdownTier — Broadway (gold threshold 83)', () => {
  test('≥83 → rave', () => {
    assert.strictEqual(getBreakdownTier(83, 'broadway'), 'rave');
    assert.strictEqual(getBreakdownTier(90, 'broadway'), 'rave');
    assert.strictEqual(getBreakdownTier(100, 'broadway'), 'rave');
  });

  test('82 → positive (just below gold)', () => {
    assert.strictEqual(getBreakdownTier(82, 'broadway'), 'positive');
  });

  test('70 → positive (boundary)', () => {
    assert.strictEqual(getBreakdownTier(70, 'broadway'), 'positive');
  });

  test('70–82 all positive — including the former Worth Seeing territory', () => {
    for (const s of [70, 71, 72, 74, 75, 78, 82]) {
      assert.strictEqual(getBreakdownTier(s, 'broadway'), 'positive', `score ${s}`);
    }
  });

  test('69 → mixed (just below positive)', () => {
    assert.strictEqual(getBreakdownTier(69, 'broadway'), 'mixed');
  });

  test('55 → mixed (boundary)', () => {
    assert.strictEqual(getBreakdownTier(55, 'broadway'), 'mixed');
  });

  test('55–69 all mixed', () => {
    for (const s of [55, 60, 64, 65, 68, 69]) {
      assert.strictEqual(getBreakdownTier(s, 'broadway'), 'mixed', `score ${s}`);
    }
  });

  test('54 → negative', () => {
    assert.strictEqual(getBreakdownTier(54, 'broadway'), 'negative');
  });

  test('<55 all negative', () => {
    for (const s of [0, 10, 40, 54]) {
      assert.strictEqual(getBreakdownTier(s, 'broadway'), 'negative', `score ${s}`);
    }
  });
});

describe('getBreakdownTier — West End (gold threshold 85)', () => {
  test('85 → rave (WE threshold)', () => {
    assert.strictEqual(getBreakdownTier(85, 'west-end'), 'rave');
  });

  test('84 → positive on WE (would be rave on Broadway)', () => {
    assert.strictEqual(getBreakdownTier(84, 'west-end'), 'positive');
    assert.strictEqual(getBreakdownTier(84, 'broadway'), 'rave');
  });

  test('83 → positive on WE but rave on Broadway', () => {
    assert.strictEqual(getBreakdownTier(83, 'west-end'), 'positive');
    assert.strictEqual(getBreakdownTier(83, 'broadway'), 'rave');
  });

  test('off-west-end inherits 85 gold threshold', () => {
    assert.strictEqual(getBreakdownTier(84, 'off-west-end'), 'positive');
    assert.strictEqual(getBreakdownTier(85, 'off-west-end'), 'rave');
  });
});

describe('getBreakdownTier — rounding', () => {
  test('rounds non-integer scores before classifying', () => {
    // 82.4 → 82 → positive
    assert.strictEqual(getBreakdownTier(82.4, 'broadway'), 'positive');
    // 82.5 → 83 → rave
    assert.strictEqual(getBreakdownTier(82.5, 'broadway'), 'rave');
    // 69.9 → 70 → positive (boundary)
    assert.strictEqual(getBreakdownTier(69.9, 'broadway'), 'positive');
    // 54.4 → 54 → negative
    assert.strictEqual(getBreakdownTier(54.4, 'broadway'), 'negative');
  });
});

describe('getBreakdownTier — missing category', () => {
  test('defaults to Broadway gold threshold (83) when category is undefined', () => {
    assert.strictEqual(getBreakdownTier(83), 'rave');
    assert.strictEqual(getBreakdownTier(82), 'positive');
  });
});
