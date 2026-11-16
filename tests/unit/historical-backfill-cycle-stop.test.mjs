// BRO-7551: the historical backfill wraps to a new cycle after the last show.
// Guard the wrap behaviour and the yield probe that decides whether it is worth it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nextBackfillSlice } = require('../../scripts/historical-backfill-next.js');
const { measureYield } = require('../../scripts/audit-historical-backfill-yield.js');

const DAY = 86400000;

test('cursor wraps to a new cycle after the last show', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  const r = nextBackfillSlice(list, { next: 4, cycle: 0 }, 3);
  assert.deepEqual(r.shows, ['e', 'a', 'b']);
  assert.equal(r.cycle, 1);
  assert.equal(r.next, 2);
});

test('mid-cycle slice does not bump the cycle', () => {
  const r = nextBackfillSlice(['a', 'b', 'c', 'd'], { next: 0, cycle: 2 }, 2);
  assert.deepEqual(r.shows, ['a', 'b']);
  assert.equal(r.cycle, 2);
});

test('yield: revisited shows with new reviews beat the control, verdict keep', () => {
  const end = Date.UTC(2026, 10, 15);
  const cursor = { next: 48, updatedAt: new Date(end).toISOString() };
  const ids = Array.from({ length: 96 }, (_, i) => `s${i}`);
  const fresh = [end - DAY, end - 3 * DAY];
  const first = {};
  ids.forEach((id, i) => { first[id] = i < 48 && i % 2 === 0 ? [0, ...fresh] : [0]; });
  const r = measureYield(ids, cursor, first, 24);
  assert.equal(r.visited.shows, 48);
  assert.equal(r.control.shows, 48);
  assert.ok(r.visited.newSinceVisit > 0);
  assert.equal(r.control.newSinceCycleStart, 0);
  assert.equal(r.verdict, 'keep');
});

test('yield: no new reviews anywhere is low-yield (stop-at-cycle-end case)', () => {
  const cursor = { next: 24, updatedAt: new Date(Date.UTC(2026, 10, 15)).toISOString() };
  const ids = Array.from({ length: 48 }, (_, i) => `s${i}`);
  const first = Object.fromEntries(ids.map((id) => [id, [0]]));
  assert.equal(measureYield(ids, cursor, first, 24).verdict, 'low-yield');
});
