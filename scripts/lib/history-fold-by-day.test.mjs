/**
 * Tests for foldHistoryByDay (task #530 follow-up).
 *
 * Driven by the real contamination in data/audit/bundle-size-history.json:
 * 50 entries covering only 8 distinct days, 21 of them on 2026-04-19.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { foldHistoryByDay } = require('./history-fold-by-day.js');

test('collapses many same-day runs to one entry', () => {
  const entries = [
    { timestamp: '2026-04-19T01:00:00Z', sharedJS: 100 },
    { timestamp: '2026-04-19T09:00:00Z', sharedJS: 101 },
    { timestamp: '2026-04-19T23:00:00Z', sharedJS: 102 },
    { timestamp: '2026-04-20T04:00:00Z', sharedJS: 103 },
  ];
  const folded = foldHistoryByDay(entries);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map(e => e.sharedJS), [102, 103], 'last run of each day wins');
});

test('the retention window becomes days, not runs', () => {
  // 21 runs on one day + 7 single-run days = 28 rows that were only 8 days.
  const entries = [];
  for (let i = 0; i < 21; i++) {
    entries.push({ timestamp: `2026-04-19T${String(i).padStart(2, '0')}:00:00Z`, sharedJS: 200 + i });
  }
  for (let d = 20; d < 27; d++) {
    entries.push({ timestamp: `2026-04-${d}T12:00:00Z`, sharedJS: 300 + d });
  }
  const folded = foldHistoryByDay(entries);
  assert.equal(entries.length, 28);
  assert.equal(folded.length, 8, '28 rows were only ever 8 days of signal');
});

test('output is chronological regardless of input order', () => {
  const folded = foldHistoryByDay([
    { timestamp: '2026-04-22T00:00:00Z', v: 'c' },
    { timestamp: '2026-04-20T00:00:00Z', v: 'a' },
    { timestamp: '2026-04-21T00:00:00Z', v: 'b' },
  ]);
  assert.deepEqual(folded.map(e => e.v), ['a', 'b', 'c']);
});

test('an already-clean history is returned unchanged', () => {
  const entries = [
    { timestamp: '2026-04-20T00:00:00Z', v: 1 },
    { timestamp: '2026-04-21T00:00:00Z', v: 2 },
  ];
  assert.deepEqual(foldHistoryByDay(entries), entries);
});

test('supports a date-keyed field too (the check-seo-health shape)', () => {
  const folded = foldHistoryByDay([
    { date: '2026-06-21', clicks: 1 },
    { date: '2026-06-21', clicks: 2 },
    { date: '2026-06-28', clicks: 3 },
  ], 'date');
  assert.equal(folded.length, 2);
  assert.equal(folded[0].clicks, 2, 'the live duplicate 2026-06-21 collapses to the later row');
});

test('rows with no usable key are kept, never dropped', () => {
  // Losing a measurement to fix a duplicate would be the worse bug.
  const folded = foldHistoryByDay([
    { timestamp: '2026-04-20T00:00:00Z', v: 'dated' },
    { v: 'no-timestamp' },
    { timestamp: null, v: 'null-timestamp' },
  ]);
  assert.equal(folded.length, 3);
  assert.ok(folded.some(e => e.v === 'no-timestamp'));
  assert.ok(folded.some(e => e.v === 'null-timestamp'));
});

test('junk input never throws', () => {
  assert.deepEqual(foldHistoryByDay(null), []);
  assert.deepEqual(foldHistoryByDay(undefined), []);
  assert.deepEqual(foldHistoryByDay([]), []);
  assert.deepEqual(foldHistoryByDay([null, undefined, 42]), []);
});
