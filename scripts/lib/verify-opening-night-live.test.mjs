import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findLiveGaps, shouldAlert } = require('../verify-opening-night-live.js');

test('findLiveGaps flags only shows scored locally but under-represented live', () => {
  const local = new Map([['a', 20], ['b', 10], ['c', 5]]);
  const prod = new Map([['a', 20], ['b', 7], ['c', 8]]); // a in sync, b behind, c ahead(impossible-ish)
  const gaps = findLiveGaps(local, prod);
  assert.deepEqual(gaps.map((g) => g.showId), ['b'], 'only b (local>live) is a gap');
  assert.equal(gaps[0].delta, 3);
});

test('findLiveGaps treats missing prod entry as 0 (page not built)', () => {
  const gaps = findLiveGaps(new Map([['x', 4]]), new Map());
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].prodLive, 0);
});

test('shouldAlert holds during deploy-lag window, fires once stuck past threshold', () => {
  const gap = { showId: 'x', delta: 2 };
  const t0 = Date.parse('2026-06-28T12:00:00Z');
  // First sighting: no prior state → starts the clock, does NOT alert (could be lag).
  const first = shouldAlert(gap, undefined, t0, 40);
  assert.equal(first.alert, false);
  assert.equal(first.entry.firstSeenBehindAt, new Date(t0).toISOString());

  // 20 min later, still behind → within lag window, no alert.
  const mid = shouldAlert(gap, first.entry, t0 + 20 * 60000, 40);
  assert.equal(mid.alert, false);
  assert.equal(mid.entry.firstSeenBehindAt, first.entry.firstSeenBehindAt, 'clock not reset');

  // 45 min later, still behind → stuck, NOT lag → alert.
  const late = shouldAlert(gap, first.entry, t0 + 45 * 60000, 40);
  assert.equal(late.alert, true);
});
