import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isPressWindowSerpSlot } = require('../../scripts/lib/press-window-serp.js');
const { shouldRunSerpForMode, pollMode } = require('../../scripts/opening-night-poller.js');

const open = '2026-11-01T00:00:00Z';
const at = (iso) => new Date(iso);
const ob = { category: 'off-broadway', openingDate: open };

test('OB gets an evening slot in the first 3 days only', () => {
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-01T22:00:00Z')), true);
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-02T22:00:00Z')), true);
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-05T22:00:00Z')), false, 'day 5');
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-01T22:00:00Z'), { DISABLE_OB_PRESS_WINDOW_SERP: 'true' }), false, 'kill switch');
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-02T12:00:00Z')), false, 'wrong hour');
});

test('other markets and undated shows are untouched', () => {
  assert.equal(isPressWindowSerpSlot({ category: 'broadway', openingDate: open }, at('2026-11-01T22:00:00Z')), false);
  assert.equal(isPressWindowSerpSlot({ category: 'west-end', openingDate: open }, at('2026-11-01T17:00:00Z')), false);
  assert.equal(isPressWindowSerpSlot({ category: 'off-broadway' }, at('2026-11-01T22:00:00Z')), false);
});

test('shouldRunSerpForMode: OB daily mode now runs in the evening slot, still not at other hours', () => {
  const now = at('2026-11-02T22:00:00Z');
  assert.equal(pollMode(ob, now), 'daily');
  assert.equal(shouldRunSerpForMode('daily', ob, now), true);
  assert.equal(shouldRunSerpForMode('daily', ob, at('2026-11-02T15:00:00Z')), false);
  assert.equal(shouldRunSerpForMode('daily', { category: 'broadway', openingDate: open }, now), false);
});

test('OWE evening slot', () => {
  const owe = { category: 'off-west-end', openingDate: open };
  assert.equal(shouldRunSerpForMode('daily', owe, at('2026-11-02T17:00:00Z')), true);
});

test('extra slot stops once the show has used its two SERP sessions today', () => {
  const t = at('2026-11-02T22:00:00Z');
  assert.equal(isPressWindowSerpSlot(ob, t, {}, 1), true);
  assert.equal(isPressWindowSerpSlot(ob, t, {}, 2), false);
});

// BRO-6801: windows must sit on hours a SERP-capable poller run exists (the OB window wraps midnight).
test('OB slot wraps midnight (21Z-05Z) and closes before the morning', () => {
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-02T01:30:00Z')), true, '01:30Z run');
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-02T04:59:00Z')), true);
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-02T06:00:00Z')), false);
  assert.equal(isPressWindowSerpSlot(ob, at('2026-11-02T20:00:00Z')), false);
});

test('OWE slot covers the 19-22Z West End orchestrator runs', () => {
  const owe = { category: 'off-west-end', openingDate: open };
  for (const h of ['19', '21', '23']) assert.equal(isPressWindowSerpSlot(owe, at(`2026-11-02T${h}:10:00Z`)), true, h);
  assert.equal(isPressWindowSerpSlot(owe, at('2026-11-02T08:00:00Z')), false);
});

test('press-window burst config: own caps, OB+OWE only, spaced', () => {
  const { PRESS_WINDOW_SERP_BURST_CONFIG: c, checkSerpBurstAllowed } = require('../../scripts/lib/serp-burst-caps.js');
  const base = { flagEnabled: true, show: ob, mode: 'aggressive', hoursSinceOpening: 30, burstsToday: 0, burstsForShowToday: 0, config: c };
  assert.equal(checkSerpBurstAllowed(base).allowed, true);
  assert.equal(checkSerpBurstAllowed({ ...base, burstsForShowToday: 2 }).reason, 'per-show-cap');
  assert.equal(checkSerpBurstAllowed({ ...base, burstsToday: 8 }).reason, 'daily-global-cap');
  assert.equal(checkSerpBurstAllowed({ ...base, minutesSinceLastBurstForShow: 30 }).reason, 'hourly-spacing');
  assert.equal(checkSerpBurstAllowed({ ...base, show: { category: 'broadway' } }).reason, 'market');
  assert.equal(checkSerpBurstAllowed({ ...base, hoursSinceOpening: 1 }).reason, '3h-gate');
});
