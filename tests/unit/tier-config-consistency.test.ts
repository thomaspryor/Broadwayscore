/**
 * Tier configuration consistency invariants.
 *
 * Why this test exists: T4 was added to TIER_WEIGHTS on 2026-04-29. Two
 * stale `[1, 2, 3]` literal guards stayed broken until the 2026-05-16
 * T3→T4 demotion exposed them in CI. Four more stale-T3 sites in the
 * llm-scoring pipeline didn't trip CI at all (calibration noise only).
 *
 * This test enforces the systematic fix: a single canonical VALID_TIERS
 * list per side (TS + JS), with the two sides asserted to match. Adding
 * a new tier (T5) to one side without the other now fails this test
 * immediately instead of silently corrupting downstream guards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIER_WEIGHTS, VALID_TIERS, DEFAULT_TIER } from '../../src/config/scoring';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsOutletTiers = require('../../scripts/lib/outlet-tiers');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsComputeCriticScore = require('../../scripts/lib/compute-critic-score');

test('VALID_TIERS derives from TIER_WEIGHTS (TS side)', () => {
  const keys = Object.keys(TIER_WEIGHTS).map(Number).sort((a, b) => a - b);
  assert.deepEqual([...VALID_TIERS], keys, 'TS VALID_TIERS must equal sorted TIER_WEIGHTS keys');
});

test('VALID_TIERS derives from TIER_WEIGHTS (JS side)', () => {
  const keys = Object.keys(jsOutletTiers.TIER_WEIGHTS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(jsOutletTiers.VALID_TIERS, keys, 'JS VALID_TIERS must equal sorted TIER_WEIGHTS keys');
});

test('TS and JS TIER_WEIGHTS canonicals agree', () => {
  // Two canonicals exist by necessity (TS imports TIER_WEIGHTS from
  // src/config/scoring.ts; scripts/* require it from scripts/lib/outlet-tiers.js).
  // They're hand-synced — this invariant catches drift.
  const tsKeys = Object.keys(TIER_WEIGHTS).map(Number).sort((a, b) => a - b);
  const jsKeys = Object.keys(jsOutletTiers.TIER_WEIGHTS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(tsKeys, jsKeys, 'TS TIER_WEIGHTS keys must match JS TIER_WEIGHTS keys');

  for (const tier of tsKeys) {
    const tsWeight = (TIER_WEIGHTS as Record<number, number>)[tier];
    const jsWeight = jsOutletTiers.TIER_WEIGHTS[tier];
    assert.equal(
      tsWeight,
      jsWeight,
      `Tier ${tier} weight diverges: TS=${tsWeight} JS=${jsWeight}`
    );
  }
});

test('VALID_TIERS agree across TS and JS', () => {
  assert.deepEqual([...VALID_TIERS], jsOutletTiers.VALID_TIERS, 'TS and JS VALID_TIERS must be identical');
});

test('buildTierAccumulator pre-keys every canonical tier', () => {
  const acc = jsOutletTiers.buildTierAccumulator(() => ({ count: 0 }));
  const keys = Object.keys(acc).sort();
  const expected = jsOutletTiers.VALID_TIERS.map((t: number) => `tier${t}`).sort();
  assert.deepEqual(keys, expected, 'buildTierAccumulator must expose one bucket per VALID_TIERS entry');
  // Independent values per bucket (factory called fresh each time)
  acc.tier1.count = 5;
  assert.equal(acc[`tier${jsOutletTiers.VALID_TIERS[1]}`].count, 0, 'buckets must not share state');
});

test('sampleStratifiedByTier covers every populated tier', () => {
  const items = [
    ...Array.from({ length: 10 }, () => ({ tier: 1 })),
    ...Array.from({ length: 20 }, () => ({ tier: 2 })),
    ...Array.from({ length: 30 }, () => ({ tier: 3 })),
    ...Array.from({ length: 40 }, () => ({ tier: 4 })),
  ];
  const sample = jsOutletTiers.sampleStratifiedByTier(items, 50);
  // Proportional allocation: every tier with population > 0 should be represented
  for (const tier of jsOutletTiers.VALID_TIERS as number[]) {
    const tierCount = sample.filter((x: { tier: number }) => x.tier === tier).length;
    assert.ok(
      tierCount > 0,
      `Tier ${tier} had population but zero samples — VALID_TIERS drift`
    );
  }
  assert.equal(sample.length, 50, 'sample total must equal requested size');
});

test('sampleStratifiedByTier handles empty input', () => {
  assert.deepEqual(jsOutletTiers.sampleStratifiedByTier([], 10), []);
  assert.deepEqual(jsOutletTiers.sampleStratifiedByTier([{ tier: 1 }], 0), []);
});

test('compute-critic-score.js re-exports the canonical (no duplicate)', () => {
  // Codex 2026-05-16: compute-critic-score.js used to declare its own copy of
  // TIER_WEIGHTS, DEFAULT_TIER, OFF_MARKET_MULTIPLIER — a third silent canonical
  // alongside scripts/lib/outlet-tiers.js and src/config/scoring.ts. It now
  // re-imports from outlet-tiers.js; this test asserts they are the same value
  // (which would also be true if someone re-declared them with identical
  // numbers, but the stronger goal is to make sure they don't drift in practice).
  assert.deepEqual(
    jsComputeCriticScore.TIER_WEIGHTS,
    jsOutletTiers.TIER_WEIGHTS,
    'compute-critic-score TIER_WEIGHTS must equal outlet-tiers TIER_WEIGHTS'
  );
  assert.equal(
    jsComputeCriticScore.DEFAULT_TIER,
    jsOutletTiers.DEFAULT_TIER,
    'compute-critic-score DEFAULT_TIER must equal outlet-tiers DEFAULT_TIER'
  );
  assert.equal(
    jsComputeCriticScore.OFF_MARKET_MULTIPLIER,
    jsOutletTiers.OFF_MARKET_MULTIPLIER,
    'compute-critic-score OFF_MARKET_MULTIPLIER must equal outlet-tiers'
  );
});

test('DEFAULT_TIER agrees across TS and JS canonicals', () => {
  assert.equal(
    DEFAULT_TIER,
    jsOutletTiers.DEFAULT_TIER,
    'TS DEFAULT_TIER and JS DEFAULT_TIER must match'
  );
});
