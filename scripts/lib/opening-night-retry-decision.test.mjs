import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRetryForThinPressNight, MIN_PRESS_NIGHT_SCORED } = require('./opening-night-retry-decision');
const { computeWindow } = require('./opening-night-windows');

const show = { id: 'bc-860', category: 'broadway', openingDate: '2026-10-21' };
const win = computeWindow(show, { now: new Date('2026-10-21T20:00:00Z') });
const inside = new Date('2026-10-22T03:30:00Z');
const outside = new Date('2026-10-21T12:00:00Z');

test('1 scored review inside the window -> retry', () => {
  const r = shouldRetryForThinPressNight({ scoredCount: 1, window: win, now: inside });
  assert.equal(r.retry, true);
});
test('1 scored review outside the window -> no retry', () => {
  assert.equal(shouldRetryForThinPressNight({ scoredCount: 1, window: win, now: outside }).retry, false);
});
test('5 scored reviews inside the window -> no retry', () => {
  assert.equal(shouldRetryForThinPressNight({ scoredCount: 5, window: win, now: inside }).retry, false);
});
test('exactly the minimum -> no retry; one below -> retry', () => {
  assert.equal(shouldRetryForThinPressNight({ scoredCount: MIN_PRESS_NIGHT_SCORED, window: win, now: inside }).retry, false);
  assert.equal(shouldRetryForThinPressNight({ scoredCount: MIN_PRESS_NIGHT_SCORED - 1, window: win, now: inside }).retry, true);
});
test('a retry run never re-enqueues (cap), zero scored included', () => {
  assert.equal(shouldRetryForThinPressNight({ scoredCount: 0, window: win, now: inside, isRetry: true }).retry, false);
});
test('no window -> no retry; missing count inside window counts as zero -> retry', () => {
  assert.equal(shouldRetryForThinPressNight({ scoredCount: 0, window: null, now: inside }).retry, false);
  assert.equal(shouldRetryForThinPressNight({ scoredCount: undefined, window: win, now: inside }).retry, true);
});
test('after the window closes -> no retry', () => {
  assert.equal(shouldRetryForThinPressNight({ scoredCount: 0, window: win, now: new Date('2026-10-23T12:00:00Z') }).retry, false);
});
