/**
 * Tests for scripts/lib/browserbase-caps.js.
 *
 * Locks in the cap defaults that survive an April-style opening-night peak:
 *   - maxPerDay 250 covers April 2026 max (275/day would clip 1 day at 200).
 *   - maxPerRun 30 / maxPerDomain 10 prevent a single workflow run or paywalled
 *     outlet from monopolizing.
 * AND blocks Feb-style runaway (2,448 sessions/day was 10x the new ceiling).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkBrowserbaseCaps } = require('../../scripts/lib/browserbase-caps.js');

// April 2026 production defaults (post 2026-05-17 cap raise)
const PROD = { maxPerDay: 250, maxPerRun: 30, maxPerDomain: 10 };

test('allows when all counters under caps', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 50,
    sessionsThisRun: 5,
    sessionsPerDomain: { 'variety.com': 2 },
    urlDomain: 'variety.com',
    config: PROD,
  });
  assert.equal(r.allowed, true);
});

test('denies when sessionsToday >= maxPerDay', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 250,
    sessionsThisRun: 0,
    sessionsPerDomain: {},
    config: PROD,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'day');
  assert.equal(r.limit, 250);
  assert.equal(r.used, 250);
});

test('denies when sessionsThisRun >= maxPerRun', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 100,
    sessionsThisRun: 30,
    sessionsPerDomain: {},
    config: PROD,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'run');
});

test('denies when sessionsPerDomain[urlDomain] >= maxPerDomain', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 50,
    sessionsThisRun: 5,
    sessionsPerDomain: { 'variety.com': 10 },
    urlDomain: 'variety.com',
    config: PROD,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'domain');
  assert.equal(r.limit, 10);
  assert.equal(r.used, 10);
});

test('per-domain check skipped when urlDomain not provided', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 50,
    sessionsThisRun: 5,
    sessionsPerDomain: { 'variety.com': 999 },
    urlDomain: undefined,
    config: PROD,
  });
  assert.equal(r.allowed, true);
});

test('per-domain counter for OTHER domain does not block', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 50,
    sessionsThisRun: 5,
    sessionsPerDomain: { 'variety.com': 10 },
    urlDomain: 'ft.com',
    config: PROD,
  });
  assert.equal(r.allowed, true);
});

test('cap priority: day > run > domain', () => {
  // All three would deny; reports `day` first.
  const r = checkBrowserbaseCaps({
    sessionsToday: 250,
    sessionsThisRun: 30,
    sessionsPerDomain: { 'variety.com': 10 },
    urlDomain: 'variety.com',
    config: PROD,
  });
  assert.equal(r.reason, 'day');
});

// ============================================================================
// Empirical-history guards: caps that survive April, block Feb runaway
// ============================================================================

test('April 2026 peak (275/day) is BLOCKED at 250/day cap', () => {
  // Joe Turner opening night, April 26, 2026
  const r = checkBrowserbaseCaps({
    sessionsToday: 275,
    sessionsThisRun: 0,
    sessionsPerDomain: {},
    config: PROD,
  });
  assert.equal(r.allowed, false, 'cap should clip the empirical April peak above ceiling');
});

test('April 2026 typical day (84/day) is ALLOWED at 250/day cap', () => {
  const r = checkBrowserbaseCaps({
    sessionsToday: 84,
    sessionsThisRun: 5,
    sessionsPerDomain: { 'variety.com': 2 },
    urlDomain: 'variety.com',
    config: PROD,
  });
  assert.equal(r.allowed, true, 'cap must NOT clip a typical April opening-night day');
});

test('Feb 2026 runaway (2448/day) is BLOCKED — cap caught at 250 instead of $244.80', () => {
  // The whole reason caps exist.
  const r = checkBrowserbaseCaps({
    sessionsToday: 2448,
    sessionsThisRun: 0,
    sessionsPerDomain: {},
    config: PROD,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'day');
});

test('one paywalled outlet trying to consume 15 sessions is blocked at 10', () => {
  // Feb-style scenario: single paywalled outlet burst
  const r = checkBrowserbaseCaps({
    sessionsToday: 50,
    sessionsThisRun: 5,
    sessionsPerDomain: { 'hollywoodreporter.com': 15 },
    urlDomain: 'hollywoodreporter.com',
    config: PROD,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'domain');
});

// --- Single shared daily ceiling (Scraping v2 T13) ---
// collect-review-texts.js (local usage file) and lib/bww-rr-discover.js (live
// API count) cap the SAME Browserbase account. They used to each hard-code
// 250, with bww-rr-discover.js only asserting the invariant in a comment. The
// T13 step-down edits this ceiling, so a drift here means half the spend stays
// uncapped while the cap reads as lowered.

const { resolveMaxSessionsPerDay, DEFAULT_MAX_SESSIONS_PER_DAY } = require('../../scripts/lib/browserbase-caps.js');

test('daily ceiling defaults to 250 when the env var is unset', () => {
  assert.equal(DEFAULT_MAX_SESSIONS_PER_DAY, 250);
  assert.equal(resolveMaxSessionsPerDay({}), 250);
});

test('daily ceiling honours the env var — this is how T13 steps 250 -> 100 -> 60', () => {
  assert.equal(resolveMaxSessionsPerDay({ BROWSERBASE_MAX_SESSIONS_PER_DAY: '100' }), 100);
  assert.equal(resolveMaxSessionsPerDay({ BROWSERBASE_MAX_SESSIONS_PER_DAY: '60' }), 60);
});

test('unset/garbage/zero/negative fall back to the default, never to 0', () => {
  // The poller injects `${{ vars.BROWSERBASE_MAX_SESSIONS_PER_DAY }}`, which is
  // an EMPTY STRING when the repo variable does not exist. parseInt('') is NaN,
  // and a 0 ceiling would block every session account-wide.
  for (const bad of ['', '   ', 'abc', '0', '-5']) {
    assert.equal(
      resolveMaxSessionsPerDay({ BROWSERBASE_MAX_SESSIONS_PER_DAY: bad }),
      DEFAULT_MAX_SESSIONS_PER_DAY,
      `expected fallback for ${JSON.stringify(bad)}`,
    );
  }
});

test('both enforcement points resolve the SAME ceiling from one env read', () => {
  // Mirrors how collect-review-texts.js and bww-rr-discover.js each call it.
  const env = { BROWSERBASE_MAX_SESSIONS_PER_DAY: '60' };
  assert.equal(resolveMaxSessionsPerDay(env), resolveMaxSessionsPerDay(env));
  // ...and the resolved value is what actually gates a request.
  const r = checkBrowserbaseCaps({
    sessionsToday: 60,
    sessionsThisRun: 0,
    sessionsPerDomain: {},
    config: { maxPerDay: resolveMaxSessionsPerDay(env), maxPerRun: 30, maxPerDomain: 10 },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'day');
  assert.equal(r.limit, 60);
});

// ---------- BRO-5243 helpers ----------
test('BRO-5243 hostMatchesAny: exact, subdomain, www, null-safe, no suffix false positives', () => {
  const caps = require('../../scripts/lib/browserbase-caps.js');
  assert.equal(caps.hostMatchesAny('wsj.com', ['wsj.com']), true);
  assert.equal(caps.hostMatchesAny('www.WSJ.com', ['wsj.com']), true);
  assert.equal(caps.hostMatchesAny('m.facebook.com', ['facebook.com']), true);
  assert.equal(caps.hostMatchesAny('notwsj.com', ['wsj.com']), false);
  assert.equal(caps.hostMatchesAny(null, ['wsj.com']), false);
  assert.equal(caps.hostMatchesAny('', ['wsj.com']), false);
});

test('BRO-5243 deny list: defaults plus env extras; review outlets are never denied', () => {
  const caps = require('../../scripts/lib/browserbase-caps.js');
  assert.equal(caps.isDeniedHost('www.ticketline.co.uk', {}), true);
  assert.equal(caps.isDeniedHost('example.org', { BROWSERBASE_DENY_HOSTS: ' example.org , ' }), true);
  for (const h of ['wsj.com', 'nytimes.com', 'talkinbroadway.com', 'deadline.com', 'thestage.co.uk']) {
    assert.equal(caps.isDeniedHost(h, {}), false, h);
  }
  assert.equal(caps.isTier1RecoveryHost('www.newyorker.com'), true);
  assert.equal(caps.isTier1RecoveryHost('deadline.com'), false);
});

test('BRO-5243 openingWindowReserve: per-show below the cap, capped above it, garbage-safe', () => {
  const caps = require('../../scripts/lib/browserbase-caps.js');
  assert.equal(caps.openingWindowReserve({ openingWindowShows: 3, reservePerShow: 5, reserveMax: 75 }), 15);
  assert.equal(caps.openingWindowReserve({ openingWindowShows: 23, reservePerShow: 5, reserveMax: 75 }), 75);
  assert.equal(caps.openingWindowReserve({ openingWindowShows: 0, reservePerShow: 5, reserveMax: 75 }), 0);
  assert.equal(caps.openingWindowReserve({ openingWindowShows: NaN, reservePerShow: 5, reserveMax: 75 }), 0);
  assert.equal(caps.resolveOpeningWindowReserveMax({}), 75);
  assert.equal(caps.resolveOpeningWindowReserveMax({ BROWSERBASE_OPENING_WINDOW_RESERVE_MAX: 'x' }), 75);
  assert.equal(caps.resolveOpeningWindowReserveMax({ BROWSERBASE_OPENING_WINDOW_RESERVE_MAX: '40' }), 40);
  assert.deepEqual({ ...caps.OPENING_WINDOW_RESERVE_OPTS }, { lookbackDays: 1, lookAheadHours: 48 });
});

// BRO-5243 Option B: the time-boxed Tier-1 boost switches itself off.
test('tier1RecoveryBoost: +100 for Tier-1 hosts through 2026-10-27 UTC, 0 after, 0 elsewhere', () => {
  const { tier1RecoveryBoost, activeTier1Boost, TIER1_RECOVERY_BOOST } = require('../../scripts/lib/browserbase-caps.js');
  const at = (iso) => ({ now: new Date(iso), env: {} });
  assert.equal(TIER1_RECOVERY_BOOST.until, '2026-10-28T00:00:00Z');
  assert.equal(tier1RecoveryBoost('www.wsj.com', at('2026-10-13T16:00:00Z')), 100);
  assert.equal(tier1RecoveryBoost('nytimes.com', at('2026-10-27T23:59:59Z')), 100);
  assert.equal(tier1RecoveryBoost('wsj.com', at('2026-10-28T00:00:00Z')), 0);
  assert.equal(tier1RecoveryBoost('deadline.com', at('2026-10-13T16:00:00Z')), 0);
  assert.equal(tier1RecoveryBoost(null, at('2026-10-13T16:00:00Z')), 0);
  assert.equal(activeTier1Boost({ now: new Date('2026-10-13T16:00:00Z'), env: { BROWSERBASE_TIER1_BOOST_DISABLED: 'true' } }), 0);
});

test('tier1BoostForCaller: exempt callers get the boost for any host, others only on Tier-1', () => {
  const { tier1BoostForCaller } = require('../../scripts/lib/browserbase-caps.js');
  const on = { now: new Date('2026-10-20T12:00:00Z'), env: {} };
  const off = { now: new Date('2026-10-28T00:00:00Z'), env: {} };
  assert.equal(tier1BoostForCaller('deadline.com', { exempt: true, ...on }), 100);
  assert.equal(tier1BoostForCaller('deadline.com', { exempt: false, ...on }), 0);
  assert.equal(tier1BoostForCaller('wsj.com', { exempt: false, ...on }), 100);
  assert.equal(tier1BoostForCaller('deadline.com', { exempt: true, ...off }), 0);
});

test('countBrowserbaseAttempt counts an attempt and gives it back when no session was created (BRO-5261)', () => {
  const { countBrowserbaseAttempt } = require('../../scripts/lib/browserbase-caps.js');
  const u = { sessionsToday: 5, sessionsThisRun: 2, sessionsPerDomain: { 'wsj.com': 1 } };
  countBrowserbaseAttempt(u, 'wsj.com');
  assert.deepEqual(u, { sessionsToday: 6, sessionsThisRun: 3, sessionsPerDomain: { 'wsj.com': 2 } });
  countBrowserbaseAttempt(u, 'wsj.com', -1);
  assert.deepEqual(u, { sessionsToday: 5, sessionsThisRun: 2, sessionsPerDomain: { 'wsj.com': 1 } });
  const z = { sessionsToday: 0, sessionsThisRun: 0, sessionsPerDomain: {} };
  countBrowserbaseAttempt(z, 'nytimes.com', -1);
  assert.deepEqual(z, { sessionsToday: 0, sessionsThisRun: 0, sessionsPerDomain: { 'nytimes.com': 0 } }, 'never below zero');
});
