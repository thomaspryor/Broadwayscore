/**
 * Tests for scripts/lib/serp-burst-caps.js — the WE opening-night SERP burst cap logic.
 *
 * Locks in the guardrails from the corrected diagnosis (data/audit/we-serp-diagnosis-corrected.md):
 *   - Flag default OFF (no flag → no burst → byte-identical to today).
 *   - Burst only for WE / off-west-end shows in the aggressive window, past the 3h gate.
 *   - Hard daily-global + per-show ceilings (cannot run unbounded — cascade prevention).
 *   - Cron-math projection stays well under the BD/SB caps before the flag is enabled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SERP_BURST_CONFIG,
  checkSerpBurstAllowed,
  isCascadeTripwireExceeded,
  projectDailySerpBurstCeiling,
} = require('../../scripts/lib/serp-burst-caps.js');

const WE_SHOW = { category: 'west-end', openingDate: '2026-06-03' };

function base(overrides = {}) {
  return {
    flagEnabled: true,
    show: WE_SHOW,
    mode: 'aggressive',
    hoursSinceOpening: 12,
    burstsToday: 0,
    burstsForShowToday: 0,
    ...overrides,
  };
}

// ── Flag gate (the single most important guarantee: OFF = no change) ──
test('flag OFF → never allowed, regardless of everything else', () => {
  const r = checkSerpBurstAllowed(base({ flagEnabled: false }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'flag-off');
});

test('happy path: WE aggressive-window show past 3h, under caps → allowed', () => {
  const r = checkSerpBurstAllowed(base());
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});

// ── Market gate ──
test('off-west-end is eligible', () => {
  const r = checkSerpBurstAllowed(base({ show: { category: 'off-west-end', openingDate: '2026-06-03' } }));
  assert.equal(r.allowed, true);
});

test('broadway is NOT eligible under the WE config (has its own BW config)', () => {
  const r = checkSerpBurstAllowed(base({ show: { category: 'broadway', openingDate: '2026-06-03' } }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'market');
});

test('off-broadway is NOT eligible', () => {
  const r = checkSerpBurstAllowed(base({ show: { category: 'off-broadway', openingDate: '2026-06-03' } }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'market');
});

test('reads market field as fallback for category', () => {
  const r = checkSerpBurstAllowed(base({ show: { market: 'west-end', openingDate: '2026-06-03' } }));
  assert.equal(r.allowed, true);
});

// ── Aggressive-window gate ──
test('non-aggressive mode (daily) → not allowed', () => {
  const r = checkSerpBurstAllowed(base({ mode: 'daily' }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-aggressive-window');
});

// ── 3h gate kept ──
test('inside the 3h-post-opening gate → not allowed', () => {
  const r = checkSerpBurstAllowed(base({ hoursSinceOpening: 2.5 }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, '3h-gate');
});

test('exactly at the 3h gate → allowed', () => {
  const r = checkSerpBurstAllowed(base({ hoursSinceOpening: 3 }));
  assert.equal(r.allowed, true);
});

test('null hoursSinceOpening → NOT allowed (cannot enforce 3h gate without an opening time)', () => {
  const r = checkSerpBurstAllowed(base({ hoursSinceOpening: null }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'no-opening-time');
});

// Defense-in-depth lock: a date-less WE show must NOT burst even if some future change to
// pollMode were to return 'aggressive' for a null openingDate. The explicit no-opening-time
// guard (not the aggressive-window gate) is what closes this hole.
test('WE show with null openingDate is refused even if mode were aggressive', () => {
  const r = checkSerpBurstAllowed(base({
    show: { category: 'west-end' }, // no openingDate
    mode: 'aggressive',             // hostile assumption: pollMode somehow returns aggressive
    hoursSinceOpening: null,
  }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'no-opening-time');
});

// ── Hard ceilings (cascade prevention) ──
test('per-show cap blocks once reached', () => {
  const r = checkSerpBurstAllowed(base({ burstsForShowToday: DEFAULT_SERP_BURST_CONFIG.perShowCap }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'per-show-cap');
  assert.equal(r.limit, DEFAULT_SERP_BURST_CONFIG.perShowCap);
});

test('daily-global cap blocks once reached', () => {
  const r = checkSerpBurstAllowed(base({ burstsToday: DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily-global-cap');
  assert.equal(r.limit, DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap);
});

test('global cap is checked before per-show cap', () => {
  const r = checkSerpBurstAllowed(base({
    burstsToday: DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap,
    burstsForShowToday: DEFAULT_SERP_BURST_CONFIG.perShowCap,
  }));
  assert.equal(r.reason, 'daily-global-cap');
});

test('one under each cap is still allowed (boundary)', () => {
  const r = checkSerpBurstAllowed(base({
    burstsToday: DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap - 1,
    burstsForShowToday: DEFAULT_SERP_BURST_CONFIG.perShowCap - 1,
  }));
  assert.equal(r.allowed, true);
});

// ── Cascade tripwire ──
test('tripwire fires at the configured threshold, not before', () => {
  assert.equal(isCascadeTripwireExceeded(DEFAULT_SERP_BURST_CONFIG.cascadeTripwire - 1), false);
  assert.equal(isCascadeTripwireExceeded(DEFAULT_SERP_BURST_CONFIG.cascadeTripwire), true);
});

test('tripwire threshold sits strictly below the hard daily cap', () => {
  assert.ok(DEFAULT_SERP_BURST_CONFIG.cascadeTripwire < DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap);
});

// ── Cron-math dry-run: worst-case daily SERP fan-out stays bounded ──
test('cron-math: 3 concurrent WE openings stays under daily-global cap', () => {
  const proj = projectDailySerpBurstCeiling({ concurrentWeOpenings: 3, serpBudgetPerCycle: 12 });
  // per-show (12) × 3 = 36, clipped to the global cap (30)
  assert.equal(proj.maxBurstsPerDay, DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap);
  assert.equal(proj.boundedBy, 'daily-global');
  // Worst-case SERP calls/day = 30 bursts × 12 outlet calls = 360, far under BD/SB caps.
  assert.equal(proj.maxSerpCallsPerDay, 360);
});

test('cron-math: a single WE opening is bounded by the per-show cap', () => {
  const proj = projectDailySerpBurstCeiling({ concurrentWeOpenings: 1, serpBudgetPerCycle: 12 });
  assert.equal(proj.maxBurstsPerDay, DEFAULT_SERP_BURST_CONFIG.perShowCap);
  assert.equal(proj.boundedBy, 'per-show');
  assert.equal(proj.maxSerpCallsPerDay, 144);
});

// ── Broadway hourly sweep (BRO-4272) ──
const { DEFAULT_BW_SERP_BURST_CONFIG, planSerpOutlets } = require('../../scripts/lib/serp-burst-caps.js');
const BW_SHOW = { category: 'broadway', openingDate: '2026-09-28' };
function bw(overrides = {}) {
  return base({ show: BW_SHOW, hoursSinceOpening: 27, firstReviewsLanded: true, config: DEFAULT_BW_SERP_BURST_CONFIG, ...overrides });
}

test('BW config: Broadway show with reviews, never burst before → allowed', () => {
  assert.equal(checkSerpBurstAllowed(bw()).allowed, true);
});

test('BW config: Broadway only (off-Broadway has no aggressive window), West End not', () => {
  assert.equal(checkSerpBurstAllowed(bw({ show: { category: 'off-broadway', openingDate: '2026-09-28' } })).reason, 'market');
  assert.equal(checkSerpBurstAllowed(bw({ show: { category: 'west-end', openingDate: '2026-09-28' } })).reason, 'market');
});

test('BW config end to end with the real pollMode: aggressive at 01:30 UTC after a Broadway opening', () => {
  const { pollMode } = require('../../scripts/opening-night-poller.js');
  const now = new Date('2026-09-29T01:30:00Z');
  const mode = pollMode(BW_SHOW, now);
  assert.equal(mode, 'aggressive');
  assert.equal(checkSerpBurstAllowed(bw({ mode, hoursSinceOpening: 25.5 })).allowed, true);
});

test('BW config: burst 59 min ago → hourly-spacing; 60 min ago → allowed', () => {
  const r = checkSerpBurstAllowed(bw({ minutesSinceLastBurstForShow: 59 }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'hourly-spacing');
  assert.equal(checkSerpBurstAllowed(bw({ minutesSinceLastBurstForShow: 60 })).allowed, true);
});

test('BW config: no reviews stored yet → no-reviews-yet', () => {
  const r = checkSerpBurstAllowed(bw({ firstReviewsLanded: false }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'no-reviews-yet');
});

test('BW config: still needs the aggressive window and its own caps', () => {
  assert.equal(checkSerpBurstAllowed(bw({ mode: 'daily' })).reason, 'not-aggressive-window');
  assert.equal(checkSerpBurstAllowed(bw({ burstsForShowToday: DEFAULT_BW_SERP_BURST_CONFIG.perShowCap })).reason, 'per-show-cap');
});

test('WE config ignores the new spacing/first-review inputs (behavior unchanged)', () => {
  const r = checkSerpBurstAllowed(base({ minutesSinceLastBurstForShow: 1, firstReviewsLanded: false }));
  assert.equal(r.allowed, true);
});

// ── planSerpOutlets: rotation reaches the T3 tail ──
function outlets(nHigh, lowIds) {
  // 9 T1 + the rest T2: the School Girls 2026-09-29 split (getMissingT1T2Outlets).
  const high = Array.from({ length: nHigh }, (_, i) => ({ id: `t${i < 9 ? 1 : 2}-${i}`, tier: i < 9 ? 1 : 2 }));
  return [...high, ...lowIds.map((id) => ({ id, tier: 3 }))];
}
const T3 = ['theater-scene', 'theater-life', 'culturesauce', 'front-row-center', 'pages-on-stages',
  'one-minute-critic', 'theatre-reviews-limited', 'cititour', 'digital-journal', 'stageandcinema',
  'frontmezzjunkies', 'exeunt-magazine', 'cote-notices'];

test('plan keeps 3 of 12 slots for T3 and puts T1/T2 first', () => {
  const plan = planSerpOutlets(outlets(68, T3), { budget: 12, lowTierReserve: 3, rotation: 0 });
  assert.equal(plan.length, 12);
  assert.deepEqual(plan.slice(9).map((o) => o.tier), [3, 3, 3]);
  assert.ok(plan.slice(0, 9).every((o) => o.tier <= 2));
});

test('School Girls shape: 68 missing T1/T2 + 13 T3 → stageandcinema searched within 5 hourly passes', () => {
  const seen = new Set();
  let reachedAt = null;
  for (let pass = 0; pass < 14 && reachedAt === null; pass++) {
    for (const o of planSerpOutlets(outlets(68, T3), { budget: 12, lowTierReserve: 3, rotation: pass })) seen.add(o.id);
    if (seen.has('stageandcinema')) reachedAt = pass;
  }
  assert.ok(reachedAt !== null && reachedAt <= 4, `reached at pass ${reachedAt}`);
});

test('T1 comes first every pass and every T1 is searched at least every other pass', () => {
  const lastSeen = {};
  for (let pass = 0; pass < 12; pass++) {
    const plan = planSerpOutlets(outlets(68, T3), { budget: 12, rotation: pass });
    const tiers = plan.map((o) => o.tier);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), 'T1 before T2 before T3');
    assert.equal(tiers.filter((t) => t === 1).length, 6);
    for (const o of plan) if (o.tier === 1) {
      if (lastSeen[o.id] !== undefined) assert.ok(pass - lastSeen[o.id] <= 2, `${o.id} gap ${pass - lastSeen[o.id]}`);
      lastSeen[o.id] = pass;
    }
  }
  assert.equal(Object.keys(lastSeen).length, 9);
});

test('every T2 outlet is covered within ceil(59/3) passes', () => {
  const seen = new Set();
  for (let pass = 0; pass < Math.ceil(59 / 3); pass++) {
    for (const o of planSerpOutlets(outlets(68, T3), { budget: 12, rotation: pass })) if (o.tier === 2) seen.add(o.id);
  }
  assert.equal(seen.size, 59);
});

test('with no T2 waiting, T1 may use all high slots', () => {
  const plan = planSerpOutlets(outlets(9, T3), { budget: 12, rotation: 0 });
  assert.equal(plan.filter((o) => o.tier === 1).length, 9);
});

test('unused T3 reserve falls back to T1/T2, and short lists are returned whole', () => {
  assert.equal(planSerpOutlets(outlets(20, []), { budget: 12 }).length, 12);
  assert.equal(planSerpOutlets(outlets(2, ['a']), { budget: 12 }).length, 3);
  assert.deepEqual(planSerpOutlets([], { budget: 12 }), []);
});
