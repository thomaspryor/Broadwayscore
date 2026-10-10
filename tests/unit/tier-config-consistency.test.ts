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
import { TIER_DISPLAY, TIER_LIST, tierBarsLit, tierPercent } from '../../src/config/tier-display';
import outletTiers from '../../src/config/outlet-tiers.json';
import { METHODOLOGY_TIER_OUTLETS, methodologyOutletList, outletMarketTier } from '../../src/lib/methodology-tiers';
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

test('TIER_DISPLAY (Critic Scorecard tier chips) matches TIER_WEIGHTS', () => {
  // The chip popover tells readers how much a review counts. It lives in a
  // client-safe file with no imports, so it carries its own copy of the
  // weights; this keeps that copy honest (BRO-4881).
  const tsKeys = Object.keys(TIER_WEIGHTS).map(Number).sort((a, b) => a - b);
  const displayKeys = Object.keys(TIER_DISPLAY).map(Number).sort((a, b) => a - b);
  assert.deepEqual(displayKeys, tsKeys, 'TIER_DISPLAY must cover exactly the TIER_WEIGHTS tiers');
  for (const tier of tsKeys) {
    assert.equal(
      (TIER_DISPLAY as Record<number, { weight: number }>)[tier].weight,
      (TIER_WEIGHTS as Record<number, number>)[tier],
      `TIER_DISPLAY[${tier}].weight must equal TIER_WEIGHTS[${tier}]`
    );
  }
});

test('TIER_DISPLAY example outlets sit in that tier for their market', () => {
  // The chip popover names example outlets per tier. An outlet with a
  // regional tier (Daily Mail: NYC T2, London T1) was once listed under the
  // wrong London tier; check every named example against outlet-tiers.json.
  const ALIASES: Record<string, string> = {
    WSJ: 'wsj',
    'The Times': 'times-uk',
    'Daily News': 'nydailynews',
    'NY Post': 'nypost',
  };
  type Entry = { name?: string; tier?: number; tiers?: Record<string, number> };
  const entries = Object.entries(outletTiers as unknown as Record<string, Entry>)
    .filter(([, v]) => v && typeof v === 'object' && v.name);
  const norm = (s: string) => s.toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]/g, '');
  for (const tier of [1, 2] as const) {
    for (const [field, market] of [['examplesNyc', 'nyc'], ['examplesLondon', 'london']] as const) {
      for (const name of TIER_DISPLAY[tier][field].replace(/\.$/, '').split(', ')) {
        const hits = ALIASES[name]
          ? entries.filter(([k]) => k === ALIASES[name])
          : entries.filter(([, v]) => norm(v.name!) === norm(name));
        assert.ok(hits.length > 0, `example outlet "${name}" (tier ${tier}, ${market}) not in outlet-tiers.json; add an alias`);
        for (const [key, v] of hits) {
          const actual = v.tiers?.[market] ?? v.tier;
          assert.equal(actual, tier, `"${name}" (${key}) is a ${market} tier ${tier} example but its ${market} tier is ${actual}`);
        }
      }
    }
  }
});

test('app show-detail tiers resolve per market, like the website', () => {
  // The app's tier chips read rv[].t from generate-mobile-show-details.js.
  // It once called getTier(outletId) with no category, so West End reviews
  // carried NYC tiers (NYT/Variety/THR as T1 instead of London's T2) while
  // the website showed the regional tier (BRO-4881).
  assert.notEqual(
    jsOutletTiers.getTier('nytimes', { showCategory: 'west-end' }),
    jsOutletTiers.getTier('nytimes'),
    'fixture: nytimes should differ by market, else this guard proves nothing',
  );
  const src: string = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../scripts/generate-mobile-show-details.js'), 'utf8');
  const tierCalls = src.match(/getAuthoritativeTier\([^)]*\)/g) || [];
  assert.ok(tierCalls.length > 0, 'expected a getAuthoritativeTier call in the generator');
  for (const call of tierCalls) assert.match(call, /showCategory/, `${call} must pass showCategory`);
  const outletCalls = (src.match(/getOutletTier\([^)]*\)/g) || [])
    .filter(c => c !== 'getOutletTier(outletId, showCategory)');
  assert.ok(outletCalls.length > 0, 'expected a getOutletTier call site in the generator');
  for (const call of outletCalls) assert.match(call, /,\s*show\.category\)$/, `${call} must pass show.category`);
  // The app's tier sheet explains a promoted T1 from this flag.
  assert.match(src, /if \(isTopCritic\) entry\.tc = 1;/, 'generator must flag top critics (rv[].tc)');
});

test('tier chip bars and "Counts" key follow the weights (BRO-4905)', () => {
  assert.deepEqual([...TIER_LIST], Object.keys(TIER_DISPLAY).map(Number), 'TIER_LIST covers every displayed tier');
  for (const t of TIER_LIST) {
    // The key prints these; a drifted weight would show the wrong percent.
    assert.equal(tierPercent(t), Math.round(TIER_WEIGHTS[t as keyof typeof TIER_WEIGHTS] * 100), `T${t} percent`);
    const lit = tierBarsLit(t);
    assert.ok(lit >= 1 && lit <= 4, `T${t} lights 1-4 bars, got ${lit}`);
  }
  // A heavier tier always lights more bars than a lighter one.
  for (let i = 1; i < TIER_LIST.length; i++) {
    const [hi, lo] = [TIER_LIST[i - 1], TIER_LIST[i]];
    assert.ok(TIER_DISPLAY[hi].weight > TIER_DISPLAY[lo].weight && tierBarsLit(hi) > tierBarsLit(lo), `T${hi} must outrank T${lo}`);
  }
  // The chip and the key both draw bars from the helper, not a hardcoded count.
  const src: string = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/components/ReviewsList.tsx'), 'utf8');
  assert.match(src, /i < tierBarsLit\(tier\)/, 'TierBars must use tierBarsLit');
  assert.match(src, /\{tierPercent\(t\)\}%/, 'Counts key must use tierPercent');
});

test('methodology pages list each outlet under its real tier for that market (BRO-4925)', () => {
  // The lists were hand-typed and drifted (Daily Mail shown as London T2, Playbill as T2
  // with no tier entry). Now they are ids checked against outlet-tiers.json.
  for (const market of ['nyc', 'london'] as const) {
    for (const tier of [1, 2] as const) {
      const ids = METHODOLOGY_TIER_OUTLETS[market][tier];
      assert.equal(new Set(ids).size, ids.length, `${market} T${tier} lists an outlet twice`);
      for (const id of ids) {
        assert.equal(outletMarketTier(id, market), tier, `${id} is listed as ${market} tier ${tier} but outlet-tiers.json says ${outletMarketTier(id, market)}`);
        assert.equal(jsOutletTiers.getTier(id, { showCategory: market === 'nyc' ? 'broadway' : 'west-end' }), tier, `${id}: getTier disagrees for ${market}`);
      }
    }
  }
  assert.match(methodologyOutletList('london', 1), /^.+, .+ and .+$/);
});
