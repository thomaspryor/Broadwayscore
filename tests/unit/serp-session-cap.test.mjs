/**
 * Tests for scripts/lib/serp-session-cap.js — the poller's daily SERP-session cap.
 *
 * Locks in the Sprint-1 invariants (sprint-plan-serp-cadence.md, data/audit/we-serp-diagnosis-corrected.md):
 *   - Strict NO-OP at today's volume (generous per-show + daily-global ceilings).
 *   - Market-agnostic: the cap counts SERP cycles regardless of market (no market gate).
 *   - Global cap checked before per-show cap (account-wide ceiling wins).
 *   - Cron-math projection stays well under the BD/SB caps (worst-case 60 × 12 = 720/day).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SERP_SESSION_CONFIG,
  checkSerpSessionAllowed,
  projectDailySerpCeiling,
} = require('../../scripts/lib/serp-session-cap.js');

function base(overrides = {}) {
  return { perShowToday: 0, globalToday: 0, ...overrides };
}

// ── No-op invariant: fresh day → always allowed ──
test('fresh day (0/0) → allowed', () => {
  const r = checkSerpSessionAllowed(base());
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});

test("today's measured volume (~2 cycles/opening) is nowhere near the cap → allowed", () => {
  const r = checkSerpSessionAllowed(base({ perShowToday: 2, globalToday: 5 }));
  assert.equal(r.allowed, true);
});

// ── Per-show cap boundary ──
test('one under the per-show cap → still allowed (boundary)', () => {
  const r = checkSerpSessionAllowed(base({ perShowToday: DEFAULT_SERP_SESSION_CONFIG.perShowCap - 1 }));
  assert.equal(r.allowed, true);
});

test('exactly at the per-show cap → blocked', () => {
  const r = checkSerpSessionAllowed(base({ perShowToday: DEFAULT_SERP_SESSION_CONFIG.perShowCap }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'per-show-cap');
  assert.equal(r.limit, DEFAULT_SERP_SESSION_CONFIG.perShowCap);
  assert.equal(r.used, DEFAULT_SERP_SESSION_CONFIG.perShowCap);
});

// ── Daily-global cap boundary ──
test('one under the daily-global cap → still allowed (boundary)', () => {
  const r = checkSerpSessionAllowed(base({ globalToday: DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap - 1 }));
  assert.equal(r.allowed, true);
});

test('exactly at the daily-global cap → blocked', () => {
  const r = checkSerpSessionAllowed(base({ globalToday: DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily-global-cap');
  assert.equal(r.limit, DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap);
});

// ── Ordering: global cap wins when both are hit ──
test('global cap is checked before per-show cap', () => {
  const r = checkSerpSessionAllowed(base({
    perShowToday: DEFAULT_SERP_SESSION_CONFIG.perShowCap,
    globalToday: DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap,
  }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily-global-cap');
});

// ── Market-agnostic: there is no market input; the same counts decide identically ──
test('market-agnostic: cap depends only on counts, not on any show/market field', () => {
  // The function signature has no market/show param — passing extra fields is ignored.
  const r1 = checkSerpSessionAllowed({ perShowToday: 0, globalToday: 0, market: 'broadway' });
  const r2 = checkSerpSessionAllowed({ perShowToday: 0, globalToday: 0, market: 'west-end' });
  assert.deepEqual(r1, r2);
  assert.equal(r1.allowed, true);
});

// ── Config sanity: defaults keep the cap a no-op vs measured volume ──
test('default caps sit well above measured daily volume (no-op guarantee)', () => {
  // Measured today: ~2/opening per-show, ~2 global. Caps must be at least 10× that.
  assert.ok(DEFAULT_SERP_SESSION_CONFIG.perShowCap >= 20);
  assert.ok(DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap >= 40);
  // Global must be >= per-show so the per-show cap can actually be reached by one show.
  assert.ok(DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap >= DEFAULT_SERP_SESSION_CONFIG.perShowCap);
});

// ── Cron-math projection ──
test('cron-math: 3 concurrent openings clipped to the daily-global cap', () => {
  const proj = projectDailySerpCeiling({ concurrentOpenings: 3, serpBudgetPerCycle: 12 });
  // per-show (30) × 3 = 90, clipped to the global cap (60)
  assert.equal(proj.maxSessionsPerDay, DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap);
  assert.equal(proj.boundedBy, 'daily-global');
  assert.equal(proj.maxSerpCallsPerDay, 60 * 12); // 720, far under BD/SB caps
});

test('cron-math: a single opening is bounded by the per-show cap', () => {
  const proj = projectDailySerpCeiling({ concurrentOpenings: 1, serpBudgetPerCycle: 12 });
  assert.equal(proj.maxSessionsPerDay, DEFAULT_SERP_SESSION_CONFIG.perShowCap);
  assert.equal(proj.boundedBy, 'per-show');
  assert.equal(proj.maxSerpCallsPerDay, 30 * 12); // 360
});

test('cron-math: worst-case daily SERP fan-out stays under a 1000-call cascade threshold', () => {
  const proj = projectDailySerpCeiling({ concurrentOpenings: 99, serpBudgetPerCycle: 12 });
  // No matter how many concurrent openings, the global cap bounds total fan-out.
  assert.equal(proj.maxSessionsPerDay, DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap);
  assert.ok(proj.maxSerpCallsPerDay < 1000);
});
