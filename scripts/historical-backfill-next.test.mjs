import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { nextBackfillSlice, alreadyRanToday } = require('./historical-backfill-next.js');

const all = ['a', 'b', 'c', 'd', 'e'];

test('takes the next slice and advances the cursor', () => {
  assert.deepEqual(nextBackfillSlice(all, {}, 2), { shows: ['a', 'b'], next: 2, cycle: 0 });
  assert.deepEqual(nextBackfillSlice(all, { next: 2, cycle: 0 }, 2), { shows: ['c', 'd'], next: 4, cycle: 0 });
});

test('wraps at the end and counts a new cycle', () => {
  assert.deepEqual(nextBackfillSlice(all, { next: 4, cycle: 0 }, 2), { shows: ['e', 'a'], next: 1, cycle: 1 });
  assert.deepEqual(nextBackfillSlice(all, { next: 3, cycle: 0 }, 2), { shows: ['d', 'e'], next: 0, cycle: 1 });
});

test('an out-of-range cursor (list shrank) restarts from the top', () => {
  assert.deepEqual(nextBackfillSlice(all, { next: 99, cycle: 2 }, 1), { shows: ['a'], next: 1, cycle: 3 });
});

test('count larger than the list returns each show once; duplicates removed', () => {
  assert.deepEqual(nextBackfillSlice(['a', 'b', 'a'], {}, 10), { shows: ['a', 'b'], next: 0, cycle: 1 });
});

test('alreadyRanToday: same UTC day only; missing or bad stamps never block', () => {
  const now = Date.parse('2026-10-09T07:17:00Z');
  assert.equal(alreadyRanToday({ updatedAt: '2026-10-09T06:40:00Z' }, now), true);
  assert.equal(alreadyRanToday({ updatedAt: '2026-10-08T23:59:00Z' }, now), false);
  assert.equal(alreadyRanToday({}, now), false);
  assert.equal(alreadyRanToday({ updatedAt: 'garbage' }, now), false);
});
