// BRO-3010: requires the real scrapingbee-caps.js (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const caps = require('./scrapingbee-caps.js');

const DAY = '2026-10-13';

test('resolveShadow: shadow unless SB_BREAKER_SHADOW is exactly "0"', () => {
  assert.equal(caps.resolveShadow({}), true);
  assert.equal(caps.resolveShadow({ SB_BREAKER_SHADOW: '' }), true);
  assert.equal(caps.resolveShadow({ SB_BREAKER_SHADOW: '1' }), true);
  assert.equal(caps.resolveShadow({ SB_BREAKER_SHADOW: 'false' }), true);
  assert.equal(caps.resolveShadow({ SB_BREAKER_SHADOW: '0' }), false);
});

test('daysToRenewal: whole days, null on missing/garbage/past', () => {
  assert.equal(caps.daysToRenewal('2026-11-05', DAY), 23);
  assert.equal(caps.daysToRenewal('2026-11-05T18:40:36.521772', DAY), 23);
  assert.equal(caps.daysToRenewal(DAY, DAY), 0);
  assert.equal(caps.daysToRenewal('2026-10-01', DAY), null);
  assert.equal(caps.daysToRenewal(null, DAY), null);
  assert.equal(caps.daysToRenewal('soon', DAY), null);
});

test('resolveCeilingForDay: env pin > plan fair share > default', () => {
  const usage = { cycleUsed: 200000, cap: 1000000, renewalDate: '2026-11-05' };
  assert.deepEqual(caps.resolveCeilingForDay({ env: { SB_BREAKER_CEILING: '12345' }, usage, day: DAY }), { ceiling: 12345, source: 'env' });
  // (1M - 200k) / 23 days * 1.5 = 52174
  assert.deepEqual(caps.resolveCeilingForDay({ env: {}, usage, dayBaseline: 200000, day: DAY }), { ceiling: 52174, source: 'plan' });
  assert.deepEqual(caps.resolveCeilingForDay({ env: { SB_BREAKER_BURST_FACTOR: '1' }, usage, dayBaseline: 200000, day: DAY }), { ceiling: 34783, source: 'plan' });
  assert.deepEqual(caps.resolveCeilingForDay({ env: {}, usage: { cycleUsed: 1, cap: null, renewalDate: null }, day: DAY }), { ceiling: caps.DEFAULT_DAILY_CREDIT_CEILING, source: 'default' });
  assert.deepEqual(caps.resolveCeilingForDay({ env: {}, usage: null, day: DAY }), { ceiling: caps.DEFAULT_DAILY_CREDIT_CEILING, source: 'default' });
});

const row = (day, dayCredits, extra = {}) => ({ day, capturedAt: `${day}T23:00:00Z`, providers: { scrapingbee: { status: 'ok', cycleUsed: 100000, cap: 1000000, dayCredits, ...extra } } });

test('trailingMedianDayCredits: 14 days strictly before today, clean rows only, deduped by day', () => {
  const rows = [
    row('2026-10-12', 20000), row('2026-10-11', 16000), row('2026-10-10', 36000),
    row('2026-10-09', 22000), row('2026-10-08', 39000), row('2026-10-07', 22000),
    row('2026-10-06', 14000),
    row('2026-10-04', 0, { cycleUsed: 1000005 }), // exhausted pack: excluded
    { day: '2026-10-05', providers: { scrapingbee: { status: 'baseline' } } }, // not ok: excluded
    row(DAY, 999999), // today: excluded
    row('2026-09-01', 999999), // outside 14d: excluded
    { ...row('2026-10-12', 99999), capturedAt: '2026-10-12T01:00:00Z' }, // older duplicate: loses
  ];
  // values: 14000 16000 20000 22000 22000 36000 39000 → median 22000
  assert.equal(caps.trailingMedianDayCredits(rows, DAY), 22000);
});

test('trailingMedianDayCredits: null below 7 clean samples', () => {
  assert.equal(caps.trailingMedianDayCredits([row('2026-10-12', 1), row('2026-10-11', 2)], DAY), null);
});

test('enforcementDecision: shadow never enforces; no history never enforces; loosen-only floors at 1.5x the median', () => {
  const sh = caps.enforcementDecision({ shadow: true, ceiling: 0, ceilingSource: 'plan+opening-window-reserve', median: 30000 });
  assert.deepEqual([sh.enforce, sh.effectiveCeiling], [false, 45000], 'shadow records the same floored ceiling enforcement would use');
  const noHist = caps.enforcementDecision({ shadow: false, ceiling: 50000, ceilingSource: 'plan', median: null });
  assert.equal(noHist.enforce, false);
  const ok = caps.enforcementDecision({ shadow: false, ceiling: 50000, ceilingSource: 'plan', median: 30000 });
  assert.deepEqual([ok.enforce, ok.effectiveCeiling, ok.ceilingSource], [true, 50000, 'plan']);
  // between 1x and 1.5x the median is still lifted (a floor AT the median would trip on ~half of normal days)
  const mid = caps.enforcementDecision({ shadow: false, ceiling: 40000, ceilingSource: 'plan', median: 30000 });
  assert.equal(mid.effectiveCeiling, 45000);
  assert.equal(caps.MEDIAN_FLOOR_FACTOR, 1.5);
  // a reserved/plan ceiling below normal demand is lifted to the median
  const floored = caps.enforcementDecision({ shadow: false, ceiling: 9000, ceilingSource: 'plan+opening-window-reserve', median: 30000 });
  assert.deepEqual([floored.enforce, floored.effectiveCeiling, floored.ceilingSource], [true, 45000, 'plan+opening-window-reserve+median-floor']);
});

test('isPackExhausted and isShadowActive (day-scoped like isBreakerActive)', () => {
  assert.equal(caps.isPackExhausted({ cycleUsed: 1000005, cap: 1000000 }), true);
  assert.equal(caps.isPackExhausted({ cycleUsed: 5, cap: 1000000 }), false);
  assert.equal(caps.isPackExhausted(null), false);
  assert.equal(caps.isShadowActive({ day: DAY, wouldTripAt: 'x' }, DAY), true);
  assert.equal(caps.isShadowActive({ day: '2026-10-12', wouldTripAt: 'x' }, DAY), false, 'yesterday\'s would-trip is not active today');
  assert.equal(caps.isShadowActive({ day: DAY, wouldTripAt: null }, DAY), false);
});

function withState(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbcaps-')), 'sb.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('consultScrapingbee: a SHADOW state (wouldTripAt only) never blocks', () => {
  caps._resetForTests();
  const env = { SB_BREAKER_STATE_PATH: withState({ day: DAY, wouldTripAt: '2026-10-13T05:00:00Z', trippedAt: null }) };
  assert.equal(caps.consultScrapingbee({ env, now: new Date(`${DAY}T12:00:00Z`) }).allowed, true);
});

test('consultScrapingbee: an ENFORCED trip blocks today only; exempt callers and the kill switch pass', () => {
  caps._resetForTests();
  const state = { day: DAY, trippedAt: '2026-10-13T05:00:00Z', dayCredits: 60000, ceiling: 50000 };
  const env = { SB_BREAKER_STATE_PATH: withState(state) };
  const v = caps.consultScrapingbee({ env, now: new Date(`${DAY}T12:00:00Z`) });
  assert.deepEqual([v.allowed, v.reason, v.firstBlock], [false, 'breaker', true]);
  assert.equal(caps.consultScrapingbee({ env, now: new Date(`${DAY}T12:00:00Z`) }).firstBlock, false);
  caps._resetForTests();
  assert.equal(caps.consultScrapingbee({ env, now: new Date('2026-10-14T01:00:00Z') }).allowed, true, 'yesterday\'s trip does not block today');
  caps._resetForTests();
  assert.equal(caps.consultScrapingbee({ env: { ...env, BD_OPENING_NIGHT: '1' }, now: new Date(`${DAY}T12:00:00Z`) }).allowed, true);
  caps._resetForTests();
  assert.equal(caps.consultScrapingbee({ env: { ...env, SB_CAPS_DISABLED: '1' }, now: new Date(`${DAY}T12:00:00Z`) }).allowed, true);
});

test('computeTodayCredits is the SD implementation (reused, not copied)', () => {
  const sd = require('./scrapingdog-caps.js');
  assert.equal(caps.computeTodayCredits, sd.computeTodayCredits);
  assert.equal(caps.shouldTripBreaker, sd.shouldTripBreaker);
});
