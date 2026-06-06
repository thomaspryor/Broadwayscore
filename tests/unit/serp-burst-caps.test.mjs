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

test('broadway is NOT eligible (handled by its own timing)', () => {
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
