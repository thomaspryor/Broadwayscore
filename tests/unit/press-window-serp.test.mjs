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
