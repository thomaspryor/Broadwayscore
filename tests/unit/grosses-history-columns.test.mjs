// Unit tests for scripts/lib/grosses-history-columns.js (BRO-2375).
//
// Regression target: scripts/backfill-grosses-history.ts read Playbill's
// grosses table via cells[0]/[1]/[3]/[4]/[5]/[6] even after
// assertTableSchema passed — the schema check only guarantees the expected
// labels are present somewhere in the header row, not that they're still at
// those positions if Playbill inserts or reorders a column.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveGrossesHistoryColumns, LEGACY_INDICES } = require('../../scripts/lib/grosses-history-columns.js');

test('resolves the live header schema to its documented positions', () => {
  const headers = ['Show', 'This Week Gross', 'Diff $', 'Avg Ticket', 'Seats Sold', 'Perfs', '% Cap', 'Diff % cap'];
  const idx = resolveGrossesHistoryColumns(headers);
  assert.deepEqual(idx, { showIdx: 0, grossIdx: 1, atpIdx: 3, seatsIdx: 4, perfsIdx: 5, capIdx: 6 });
});

test('resolves columns by label, not position, when a column is inserted', () => {
  // Simulates Playbill inserting a "Rank" column at the front — a
  // fixed-index reader would misread every subsequent column.
  const headers = ['Rank', 'Show', 'This Week Gross', 'Diff $', 'Avg Ticket', 'Seats Sold', 'Perfs', '% Cap'];
  const idx = resolveGrossesHistoryColumns(headers);
  assert.deepEqual(idx, { showIdx: 1, grossIdx: 2, atpIdx: 4, seatsIdx: 5, perfsIdx: 6, capIdx: 7 });
});

test('resolves columns by label when two columns swap order', () => {
  const headers = ['Show', 'Avg Ticket', 'This Week Gross', 'Diff $', 'Seats Sold', 'Perfs', '% Cap'];
  const idx = resolveGrossesHistoryColumns(headers);
  assert.equal(idx.grossIdx, 2);
  assert.equal(idx.atpIdx, 1);
});

test('falls back to the legacy fixed layout when no header row is available', () => {
  assert.deepEqual(resolveGrossesHistoryColumns([]), LEGACY_INDICES);
  assert.deepEqual(resolveGrossesHistoryColumns(undefined), LEGACY_INDICES);
});

test('falls back per-column when a specific label is missing', () => {
  const headers = ['Show', 'This Week Gross', 'Diff $', 'Seats Sold', 'Perfs', '% Cap'];
  const idx = resolveGrossesHistoryColumns(headers);
  // "Avg Ticket" isn't present — falls back to the legacy index rather than throwing.
  assert.equal(idx.atpIdx, LEGACY_INDICES.atpIdx);
});
