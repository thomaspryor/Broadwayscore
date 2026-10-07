/**
 * Theatr screenshot import mapping (src/lib/show-import.ts).
 *
 * Theatr reactions aren't star ratings, so attended rows must never carry a
 * rating (they land in To Be Rated), Interested rows must become watchlist
 * rows with no date, and rows repeated across overlapping screenshot batches
 * must collapse to one (BRO-4618).
 *
 * Run: npx tsx --test tests/unit/theatr-import.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { theatrRowsToEntries, mergeTheatrRows, theatrNotices, chunk } from '../../src/lib/show-import';

test('attended rows become unrated diary entries with their date', () => {
  const [e] = theatrRowsToEntries([{ title: 'Hadestown', venue: 'Walter Kerr Theatre', date: '2023-09-02', list: 'attended' }]);
  assert.equal(e.kind, 'diary');
  assert.equal(e.rating, null);
  assert.equal(e.date, '2023-09-02');
  assert.equal(e.venue, 'Walter Kerr Theatre');
});

test('interested rows become dateless watchlist entries', () => {
  const [e] = theatrRowsToEntries([{ title: 'Oh, Mary!', venue: null, date: '2025-01-01', list: 'interested' }]);
  assert.equal(e.kind, 'watchlist');
  assert.equal(e.date, null);
  assert.equal(e.rating, null);
  assert.equal(e.listName, 'Interested');
});

test('merge collapses repeats across batches and keeps a venue from either copy', () => {
  const rows = mergeTheatrRows([
    { title: 'Six', venue: null, date: '2024-04-01', list: 'attended' as const },
    { title: 'SIX', venue: 'Lena Horne Theatre', date: '2024-04-01', list: 'attended' as const },
    { title: 'Six', venue: null, date: null, list: 'interested' as const },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].venue, 'Lena Horne Theatre');
});

test('merge keeps two viewings of the same show on different dates', () => {
  const rows = mergeTheatrRows([
    { title: 'Wicked', venue: null, date: '2019-02-01', list: 'attended' as const },
    { title: 'Wicked', venue: null, date: '2024-06-15', list: 'attended' as const },
  ]);
  assert.equal(rows.length, 2);
});

test('merge does not mutate the caller rows', () => {
  const input = [
    { title: 'Six', venue: null, date: null, list: 'attended' as const },
    { title: 'Six', venue: 'Lena Horne Theatre', date: null, list: 'attended' as const },
  ];
  mergeTheatrRows(input);
  assert.equal(input[0].venue, null);
});

test('merge folds an undated attended copy into the dated one, whichever comes first', () => {
  const before = mergeTheatrRows([
    { title: 'Six', venue: null, date: null, list: 'attended' as const },
    { title: 'Six', venue: null, date: '2024-04-01', list: 'attended' as const },
  ]);
  const after = mergeTheatrRows([
    { title: 'Six', venue: null, date: '2024-04-01', list: 'attended' as const },
    { title: 'six', venue: 'Lena Horne Theatre', date: null, list: 'attended' as const },
  ]);
  assert.deepEqual(before.map(r => r.date), ['2024-04-01']);
  assert.deepEqual(after.map(r => [r.date, r.venue]), [['2024-04-01', 'Lena Horne Theatre']]);
});

test('merge keeps an undated attended row when no dated copy exists, once', () => {
  const rows = mergeTheatrRows([
    { title: 'Wicked', venue: null, date: null, list: 'attended' as const },
    { title: 'Wicked', venue: null, date: null, list: 'attended' as const },
  ]);
  assert.equal(rows.length, 1);
});

test('merge keeps screenshot order', () => {
  const rows = mergeTheatrRows([
    { title: 'B', venue: null, date: '2024-01-02', list: 'attended' as const },
    { title: 'A', venue: null, date: '2024-01-01', list: 'attended' as const },
  ]);
  assert.deepEqual(rows.map(r => r.title), ['B', 'A']);
});

test('chunk makes edge-function-sized batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 6).map(b => b.length), [6, 1]);
});

test('notices explain To Be Rated, undated rows, truncation and failures', () => {
  const entries = theatrRowsToEntries([
    { title: 'A', venue: null, date: '2024-01-01', list: 'attended' },
    { title: 'B', venue: null, date: null, list: 'attended' },
  ]);
  const n = theatrNotices(entries, { picked: 35, failedScreenshots: 6, unreadable: 1 });
  assert.equal(n.length, 5);
  assert.match(n.join(' '), /To Be Rated/);
  assert.equal(theatrNotices([], { picked: 3, failedScreenshots: 0, unreadable: 0 }).length, 0);
});
