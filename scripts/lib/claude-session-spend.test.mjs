import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// CLAUDE.md rule 15: require the REAL functions, never a copy of the logic.
const require = createRequire(import.meta.url);
const {
  PRICES, modelTier, priceUsage, weeklyBuckets, quantile, calibrateAllowance, forecastMonthly,
} = require('./claude-session-spend.js');

test('opus/sonnet/haiku rates are imported from claude-cli, not redeclared', () => {
  const { APPROX_MODEL_RATES_PER_MTOK } = require('./claude-cli.js');
  for (const tier of Object.keys(APPROX_MODEL_RATES_PER_MTOK)) {
    assert.deepEqual(PRICES[tier], APPROX_MODEL_RATES_PER_MTOK[tier],
      `${tier} drifted from claude-cli.js — the whole point of importing it`);
  }
  assert.ok(PRICES.fable, 'fable is added on top (no public list price)');
});

test('an unrecognised model is excluded, never priced at a guessed tier', () => {
  // Diverges from estimateCostUSD's default-to-sonnet on purpose: a renamed
  // Opus model priced as Sonnet would understate a forecast 5x.
  const r = priceUsage({ input_tokens: 1_000_000 }, 'claude-something-new-9');
  assert.equal(r.tier, null);
  assert.equal(r.usd, 0);
  assert.equal(modelTier('claude-something-new-9'), null);
  assert.equal(modelTier(undefined), null);
  assert.equal(modelTier(''), null);
});

test('cache multipliers are applied: reads 0.1x, writes 1.25x', () => {
  const plain = priceUsage({ input_tokens: 1_000_000 }, 'claude-opus-5').usd;
  const read = priceUsage({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-5').usd;
  const write = priceUsage({ cache_creation_input_tokens: 1_000_000 }, 'claude-opus-5').usd;
  assert.equal(plain, 15);
  assert.ok(Math.abs(read - 1.5) < 1e-9, `cache read should be 0.1x input, got ${read}`);
  assert.ok(Math.abs(write - 18.75) < 1e-9, `cache write should be 1.25x input, got ${write}`);
});

test('output tokens price at the output rate', () => {
  assert.equal(priceUsage({ output_tokens: 1_000_000 }, 'claude-opus-5').usd, 75);
  assert.equal(priceUsage({ output_tokens: 1_000_000 }, 'claude-sonnet-5').usd, 15);
});

test('weeklyBuckets anchors on Thursday, matching the plan reset', () => {
  // 2026-09-03 is a Thursday; 2026-09-08 a Tuesday -> same week bucket.
  const b = weeklyBuckets({ '2026-09-03': 100, '2026-09-08': 50, '2026-09-10': 7 });
  assert.equal(b['2026-09-03'], 150);
  assert.equal(b['2026-09-10'], 7, 'the next Thursday opens a new bucket');
});

test('weeklyBuckets ignores unparseable days instead of throwing', () => {
  const b = weeklyBuckets({ 'not-a-date': 99, '2026-09-03': 1 });
  assert.equal(Object.values(b).reduce((a, c) => a + c, 0), 1);
});

test('quantile handles the empty case and interpolates', () => {
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([10, 20, 30], 0.5), 20);
  assert.equal(quantile([0, 100], 0.25), 25);
});

test('calibrateAllowance divides out the boost and flags provisional at n<3', () => {
  const a = calibrateAllowance({ demandWeek: 22606, billedWeek: 305 }, 1.5);
  assert.equal(a.boostedWeekly, 22301);
  assert.ok(Math.abs(a.baseWeekly - 14867.33) < 0.5);
  assert.equal(a.confidence, 'provisional', 'a single week must never read as solid');
  const b = calibrateAllowance([
    { demandWeek: 100, billedWeek: 0 },
    { demandWeek: 200, billedWeek: 100 },
    { demandWeek: 150, billedWeek: 50 },
  ]);
  assert.equal(b.n, 3);
  assert.equal(b.confidence, 'calibrated');
  assert.equal(b.baseWeekly, 100);
  assert.equal(calibrateAllowance([]), null);
});

test('forecastMonthly reports a distribution and clamps at the provider cap', () => {
  // 4 of 8 weeks overflow a 100 allowance -> bills [0,0,0,0,100,200,300,900],
  // p75 = 225/wk = $974/mo, which exceeds a $500 cap and so must be clamped.
  const weeklyDemands = [50, 60, 90, 100, 200, 300, 400, 1000];
  const f = forecastMonthly({ weeklyDemands, baseWeekly: 100, monthlyCap: 500 });
  assert.equal(f.weeks, 8);
  assert.equal(f.overflowWeeks, 4);
  assert.equal(f.weeklyBill.p25, 0, 'a quiet quarter of weeks bills nothing');
  assert.equal(f.weeklyBill.p75, 225);
  assert.equal(f.monthly.p75, 500, 'never forecast above the provider cap');
  assert.equal(f.capBindsAtP75, true);
  assert.ok(f.weeksToExhaustCapAtP75 < 4.33, 'cap exhausted before the month ends');
});

test('forecastMonthly is safe when nothing overflows', () => {
  const f = forecastMonthly({ weeklyDemands: [1, 2, 3], baseWeekly: 1000, monthlyCap: 500 });
  assert.equal(f.overflowWeeks, 0);
  assert.equal(f.monthly.median, 0);
  assert.equal(f.capBindsAtP75, false);
  assert.equal(f.weeksToExhaustCapAtP75, Infinity);
});
