/**
 * Unit tests for scripts/lib/scrapingdog-caps.js (card #1252).
 *
 * Run: node --test scripts/lib/scrapingdog-caps.test.mjs
 *
 * Production code requires this module — change a decision function, these
 * fail. That is the point (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('./scrapingdog-caps.js');
const { utcDay } = require('./brightdata-caps.js');

const {
  DEFAULT_DAILY_CREDIT_CEILING,
  resolveDailyCreditCeiling,
  resolveExemptScripts,
  shouldTripBreaker,
  computeTodayCredits,
  isBreakerActive,
  consultScrapingdog,
  getScrapingdogCapStats,
  _resetForTests,
} = caps;

// ---------- resolvers ----------

test('resolveDailyCreditCeiling: default when env unset', () => {
  assert.equal(resolveDailyCreditCeiling({}), DEFAULT_DAILY_CREDIT_CEILING);
});

test('resolveDailyCreditCeiling: honors a positive override', () => {
  assert.equal(resolveDailyCreditCeiling({ SD_BREAKER_CEILING: '1' }), 1);
  assert.equal(resolveDailyCreditCeiling({ SD_BREAKER_CEILING: '9000' }), 9000);
});

test('resolveDailyCreditCeiling: garbage/zero/negative fall back, never NaN or 0', () => {
  for (const bad of ['', 'abc', '0', '-5', undefined]) {
    assert.equal(resolveDailyCreditCeiling({ SD_BREAKER_CEILING: bad }), DEFAULT_DAILY_CREDIT_CEILING, `input ${JSON.stringify(bad)}`);
  }
});

test('resolveExemptScripts: default reuses BD list, env override, blank env ignored', () => {
  assert.ok(resolveExemptScripts({}).includes('opening-night-poller.js'));
  assert.deepEqual(resolveExemptScripts({ SD_EXEMPT_SCRIPTS: 'a.js, b.js' }), ['a.js', 'b.js']);
  assert.ok(resolveExemptScripts({ SD_EXEMPT_SCRIPTS: '   ' }).includes('opening-night-poller.js'));
});

// ---------- shouldTripBreaker ----------

test('shouldTripBreaker: over and exactly at the ceiling both trip', () => {
  assert.equal(shouldTripBreaker({ dayCredits: 46000, ceiling: 45000 }).tripped, true);
  assert.equal(shouldTripBreaker({ dayCredits: 45000, ceiling: 45000 }).tripped, true);
});

test('shouldTripBreaker: under the ceiling does not trip', () => {
  assert.equal(shouldTripBreaker({ dayCredits: 44999, ceiling: 45000 }).tripped, false);
  assert.equal(shouldTripBreaker({ dayCredits: 0, ceiling: 45000 }).tripped, false);
});

test('shouldTripBreaker: unknown/null credits is NOT zero and NOT over — fails open', () => {
  for (const bad of [null, undefined, NaN, 'lots']) {
    const v = shouldTripBreaker({ dayCredits: bad, ceiling: 45000 });
    assert.equal(v.tripped, false, `input ${String(bad)}`);
    assert.equal(v.reason, 'unknown-billing');
  }
});

test('shouldTripBreaker: a missing/zero ceiling never trips', () => {
  assert.equal(shouldTripBreaker({ dayCredits: 999999, ceiling: 0 }).reason, 'no-ceiling');
  assert.equal(shouldTripBreaker({ dayCredits: 999999, ceiling: NaN }).tripped, false);
});

// ---------- computeTodayCredits ----------

test('computeTodayCredits: cold start (no prevState) is a baseline day, never a trip', () => {
  const r = computeTodayCredits({ cycleUsed: 50000, day: '2026-08-11', prevState: null });
  assert.equal(r.status, 'baseline');
  assert.equal(r.dayCredits, null);
  assert.deepEqual(r.newState, { day: '2026-08-11', dayBaseline: 50000, lastCycleUsed: 50000 });
});

test('computeTodayCredits: same-day reads diff against the SAME baseline', () => {
  const prevState = { day: '2026-08-11', dayBaseline: 50000, lastCycleUsed: 50500 };
  const r = computeTodayCredits({ cycleUsed: 51200, day: '2026-08-11', prevState });
  assert.equal(r.status, 'ok');
  assert.equal(r.dayCredits, 1200);
  assert.equal(r.newState.dayBaseline, 50000, 'baseline must not drift across same-day reads');
});

test('computeTodayCredits: day rollover carries forward YESTERDAY\'S LAST reading, not today\'s first', () => {
  // This is the exact bug the cycleDelta-parity fix guards against: resetting
  // to "whatever today's first reading happens to be" would silently absorb
  // a post-midnight burst into the new baseline.
  const prevState = { day: '2026-08-10', dayBaseline: 40000, lastCycleUsed: 44000 };
  const r = computeTodayCredits({ cycleUsed: 44300, day: '2026-08-11', prevState });
  assert.equal(r.status, 'ok');
  assert.equal(r.dayCredits, 300, 'diff must be against 44000 (yesterday\'s last reading), not 44300 (today\'s first)');
  assert.equal(r.newState.dayBaseline, 44000);
});

test('computeTodayCredits: a gap of more than one day degrades to baseline, never a false trip', () => {
  const prevState = { day: '2026-08-08', dayBaseline: 10000, lastCycleUsed: 12000 };
  const r = computeTodayCredits({ cycleUsed: 40000, day: '2026-08-11', prevState });
  assert.equal(r.status, 'baseline');
  assert.equal(r.dayCredits, null);
  assert.equal(r.newState.dayBaseline, 40000);
});

test('computeTodayCredits: counter going down mid-day means the cycle renewed — new cycle IS today\'s usage', () => {
  const prevState = { day: '2026-08-11', dayBaseline: 40000, lastCycleUsed: 44900 };
  const r = computeTodayCredits({ cycleUsed: 500, day: '2026-08-11', prevState });
  assert.equal(r.status, 'ok');
  assert.equal(r.dayCredits, 500);
  assert.equal(r.newState.dayBaseline, 0, 'baseline clamps to 0 so later same-day reads keep diffing correctly');
});

test('computeTodayCredits: after a mid-day renewal, a later same-day read keeps accumulating correctly', () => {
  const afterRenewal = { day: '2026-08-11', dayBaseline: 0, lastCycleUsed: 500 };
  const r = computeTodayCredits({ cycleUsed: 900, day: '2026-08-11', prevState: afterRenewal });
  assert.equal(r.dayCredits, 900);
});

test('computeTodayCredits: unreachable billing (null cycleUsed) leaves prevState untouched', () => {
  const prevState = { day: '2026-08-11', dayBaseline: 40000, lastCycleUsed: 44000 };
  const r = computeTodayCredits({ cycleUsed: null, day: '2026-08-11', prevState });
  assert.equal(r.status, 'unknown');
  assert.equal(r.dayCredits, null);
  assert.deepEqual(r.newState, prevState);
});

test('computeTodayCredits: unreachable billing with no prior state at all', () => {
  const r = computeTodayCredits({ cycleUsed: NaN, day: '2026-08-11', prevState: null });
  assert.equal(r.status, 'unknown');
  assert.equal(r.newState, null);
});

// ---------- isBreakerActive ----------

test('isBreakerActive: same day + trippedAt blocks', () => {
  assert.equal(isBreakerActive({ day: '2026-08-11', trippedAt: '2026-08-11T12:00:00.000Z' }, '2026-08-11'), true);
});

test('isBreakerActive: yesterday\'s state expires with its day', () => {
  assert.equal(isBreakerActive({ day: '2026-08-10', trippedAt: '2026-08-10T12:00:00.000Z' }, '2026-08-11'), false);
});

test('isBreakerActive: absent/garbage state never blocks', () => {
  for (const s of [null, undefined, {}, 'nope', 42]) {
    assert.equal(isBreakerActive(s, '2026-08-11'), false);
  }
});

test('isBreakerActive: an entry without trippedAt is a cleared entry', () => {
  assert.equal(isBreakerActive({ day: '2026-08-11', trippedAt: null }, '2026-08-11'), false);
});

// ---------- consultScrapingdog (stateful) ----------

function withStateFile(state) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdcaps-')), 'sd-circuit-breaker.json');
  if (state !== null) fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

const TRIPPED = (day) => ({ day, trippedAt: '2026-08-11T12:00:00.000Z', dayCredits: 46000, ceiling: 45000 });

test('consultScrapingdog: no breaker → allowed', () => {
  _resetForTests();
  const env = { SD_BREAKER_STATE_PATH: withStateFile({}) };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: tripped breaker blocks a bulk caller without throwing', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  const v = consultScrapingdog({ env });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'breaker');
  assert.equal(getScrapingdogCapStats().blockedByBreaker, 1);
});

test('consultScrapingdog: opening-night caller (via BD_OPENING_NIGHT) is exempt even with the breaker tripped', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), BD_OPENING_NIGHT: '1' };
  const v = consultScrapingdog({ env });
  assert.equal(v.allowed, true);
  assert.equal(v.exempt, true);
});

test('consultScrapingdog: opening-night workflow name exempts too', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), GITHUB_WORKFLOW: 'Opening Night Poller' };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: a missing state file fails open', () => {
  _resetForTests();
  const env = { SD_BREAKER_STATE_PATH: path.join(os.tmpdir(), 'sdcaps-does-not-exist', 'x.json') };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: a corrupt state file fails open', () => {
  _resetForTests();
  const p = withStateFile({});
  fs.writeFileSync(p, '{not json');
  assert.equal(consultScrapingdog({ env: { SD_BREAKER_STATE_PATH: p } }).allowed, true);
});

test('consultScrapingdog: SD_CAPS_DISABLED=1 is a full kill switch', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), SD_CAPS_DISABLED: '1' };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: firstBlock is true once, then false — one ledger row per process', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  assert.equal(consultScrapingdog({ env }).firstBlock, true);
  assert.equal(consultScrapingdog({ env }).firstBlock, false);
  assert.equal(consultScrapingdog({ env }).firstBlock, false);
  assert.equal(getScrapingdogCapStats().blocked, 3, 'every withheld call still counts');
});

test('consultScrapingdog: a cleared breaker (yesterday\'s trip) does not block today', () => {
  _resetForTests();
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED('2026-08-01')) };
  assert.equal(consultScrapingdog({ env, now: new Date('2026-08-11T12:00:00Z') }).allowed, true);
});
