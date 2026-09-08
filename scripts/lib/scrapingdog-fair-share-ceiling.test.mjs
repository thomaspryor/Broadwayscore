/**
 * BRO-2943: plan-derived fair-share ceiling for the Scrapingdog daily breaker.
 *
 * The hardcoded 45,000 (minus the 3,000/show opening-window reserve) tripped
 * by mid-morning most days against ~50K/day of real demand and rerouted
 * routine SERP/page traffic to Bright Data (17x) + ScrapingBee SERP (5x) —
 * ~900K+ ScrapingBee credits per cycle attributed to nothing else. The
 * ceiling now derives from the prepaid pack itself (limit, days to renewal,
 * today's baseline) so it tracks plan changes and only shrinks when the pack
 * is genuinely running low.
 *
 * Requires the real module (CLAUDE.md rule 15) — no copied logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_DAILY_CREDIT_CEILING,
  DEFAULT_FAIR_SHARE_BURST_FACTOR,
  planFairShareCeiling,
  resolveCeilingForDay,
  shouldTripBreaker,
} = require('./scrapingdog-caps.js');

test('planFairShareCeiling: 2026-09-07 real numbers — 3M pack, 221,180 spent at day start, 26d left → 160,317', () => {
  assert.equal(planFairShareCeiling({ limit: 3_000_000, dayBaseline: 221_180, daysToRenewal: 26 }), 160_317);
  assert.equal(DEFAULT_FAIR_SHARE_BURST_FACTOR, 1.5);
});

test('planFairShareCeiling: the measured 50,883-credit day does NOT trip under the plan ceiling (it tripped at 45,000)', () => {
  const plan = planFairShareCeiling({ limit: 3_000_000, dayBaseline: 221_180, daysToRenewal: 26 });
  assert.equal(shouldTripBreaker({ dayCredits: 50_883, ceiling: plan }).tripped, false);
  assert.equal(shouldTripBreaker({ dayCredits: 50_883, ceiling: DEFAULT_DAILY_CREDIT_CEILING }).tripped, true);
});

test('planFairShareCeiling: shrinks toward the fair share as the pack runs low, never above what is left', () => {
  // 10,000 left, 2 days: fair share 5,000 × 1.5 = 7,500 (under the remainder)
  assert.equal(planFairShareCeiling({ limit: 100_000, dayBaseline: 90_000, daysToRenewal: 2 }), 7_500);
  // 1,000 left, 1 day: 1,500 would exceed the remainder → clamped to 1,000
  assert.equal(planFairShareCeiling({ limit: 100_000, dayBaseline: 99_000, daysToRenewal: 1 }), 1_000);
  // renewal day (0 days) is treated as 1 day, not a divide-by-zero
  assert.equal(planFairShareCeiling({ limit: 100_000, dayBaseline: 99_000, daysToRenewal: 0 }), 1_000);
  // pack fully spent, or downgraded below what is already used → 1, so the
  // first credit trips. NOT 0: shouldTripBreaker reads 0 as "no ceiling" and
  // would fail open on an exhausted pack (Codex ship-check finding).
  assert.equal(planFairShareCeiling({ limit: 100_000, dayBaseline: 100_000, daysToRenewal: 5 }), 1);
  assert.equal(planFairShareCeiling({ limit: 100_000, dayBaseline: 150_000, daysToRenewal: 5 }), 1);
  assert.equal(shouldTripBreaker({ dayCredits: 1, ceiling: 1 }).tripped, true);
  // a handful of credits left over many days never rounds down to 0 either
  assert.equal(planFairShareCeiling({ limit: 100_000, dayBaseline: 99_998, daysToRenewal: 30 }), 1);
});

test('planFairShareCeiling: unusable inputs return null (never NaN/undefined)', () => {
  assert.equal(planFairShareCeiling({ limit: null, dayBaseline: 0, daysToRenewal: 26 }), null);
  assert.equal(planFairShareCeiling({ limit: 3_000_000, dayBaseline: null, daysToRenewal: 26 }), null);
  assert.equal(planFairShareCeiling({ limit: 3_000_000, dayBaseline: 0, daysToRenewal: null }), null);
  // negative validity = expired/grace pack, not "renews today" (would license the whole remainder in a day)
  assert.equal(planFairShareCeiling({ limit: 3_000_000, dayBaseline: 0, daysToRenewal: -1 }), null);
  assert.equal(planFairShareCeiling({ limit: 0, dayBaseline: 0, daysToRenewal: 26 }), null);
  assert.equal(planFairShareCeiling({ limit: 3_000_000, dayBaseline: -1, daysToRenewal: 26 }), null);
  assert.equal(planFairShareCeiling({ limit: 3_000_000, dayBaseline: 0, daysToRenewal: 26, burstFactor: 0 }), null);
  assert.equal(planFairShareCeiling(), null);
});

test('resolveCeilingForDay: env override pins the ceiling regardless of the plan', () => {
  const account = { cycleUsed: 272_000, limit: 3_000_000, daysToRenewal: 26 };
  assert.deepEqual(
    resolveCeilingForDay({ env: { SD_BREAKER_CEILING: '9000' }, account, dayBaseline: 221_180 }),
    { ceiling: 9000, source: 'env' },
  );
});

test('resolveCeilingForDay: plan fair share when the account carries limit + renewal', () => {
  const account = { cycleUsed: 272_000, limit: 3_000_000, daysToRenewal: 26 };
  assert.deepEqual(
    resolveCeilingForDay({ env: {}, account, dayBaseline: 221_180 }),
    { ceiling: 160_317, source: 'plan' },
  );
  // no settled baseline yet (cold start) → today's cycle reading stands in
  assert.deepEqual(
    resolveCeilingForDay({ env: {}, account, dayBaseline: null }),
    { ceiling: Math.round((3_000_000 - 272_000) / 26 * 1.5), source: 'plan' },
  );
});

test('resolveCeilingForDay: SD_BREAKER_BURST_FACTOR tunes the multiplier; garbage falls back to 1.5', () => {
  const account = { cycleUsed: 272_000, limit: 3_000_000, daysToRenewal: 26 };
  assert.deepEqual(resolveCeilingForDay({ env: { SD_BREAKER_BURST_FACTOR: '1' }, account, dayBaseline: 221_180 }), { ceiling: 106_878, source: 'plan' });
  assert.deepEqual(resolveCeilingForDay({ env: { SD_BREAKER_BURST_FACTOR: 'lots' }, account, dayBaseline: 221_180 }), { ceiling: 160_317, source: 'plan' });
  assert.deepEqual(resolveCeilingForDay({ env: { SD_BREAKER_BURST_FACTOR: '0' }, account, dayBaseline: 221_180 }), { ceiling: 160_317, source: 'plan' });
  // negative validity on the account → plan unusable → legacy default, not a one-day free-for-all
  assert.deepEqual(resolveCeilingForDay({ env: {}, account: { ...account, daysToRenewal: -2 }, dayBaseline: 221_180 }), { ceiling: DEFAULT_DAILY_CREDIT_CEILING, source: 'default' });
});

test('resolveCeilingForDay: legacy default when billing is unreachable or the plan shape is missing', () => {
  assert.deepEqual(
    resolveCeilingForDay({ env: {}, account: null, dayBaseline: 221_180 }),
    { ceiling: DEFAULT_DAILY_CREDIT_CEILING, source: 'default' },
  );
  assert.deepEqual(
    resolveCeilingForDay({ env: {}, account: { cycleUsed: 272_000, limit: null, daysToRenewal: null }, dayBaseline: 221_180 }),
    { ceiling: DEFAULT_DAILY_CREDIT_CEILING, source: 'default' },
  );
  // garbage env override is ignored, not treated as 0
  assert.deepEqual(
    resolveCeilingForDay({ env: { SD_BREAKER_CEILING: 'abc' }, account: null }),
    { ceiling: DEFAULT_DAILY_CREDIT_CEILING, source: 'default' },
  );
});
