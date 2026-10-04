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
import { theatrRowsToEntries, dedupeTheatrEntries } from '../../src/lib/show-import';

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

test('dedupe collapses repeats across batches and keeps a venue from either copy', () => {
  const rows = dedupeTheatrEntries([
    { title: 'Six', venue: null, date: '2024-04-01', list: 'attended' as const },
    { title: 'SIX', venue: 'Lena Horne Theatre', date: '2024-04-01', list: 'attended' as const },
    { title: 'Six', venue: null, date: null, list: 'interested' as const },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].venue, 'Lena Horne Theatre');
});

test('dedupe keeps two viewings of the same show on different dates', () => {
  const rows = dedupeTheatrEntries([
    { title: 'Wicked', venue: null, date: '2019-02-01', list: 'attended' as const },
    { title: 'Wicked', venue: null, date: '2024-06-15', list: 'attended' as const },
  ]);
  assert.equal(rows.length, 2);
});

test('dedupe does not mutate the caller rows', () => {
  const input = [
    { title: 'Six', venue: null, date: null, list: 'attended' as const },
    { title: 'Six', venue: 'Lena Horne Theatre', date: null, list: 'attended' as const },
  ];
  dedupeTheatrEntries(input);
  assert.equal(input[0].venue, null);
});
