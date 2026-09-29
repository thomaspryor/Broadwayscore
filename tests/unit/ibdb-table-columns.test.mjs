// Unit tests for scripts/lib/ibdb-table-columns.js (BRO-2375).
//
// Regression target: scripts/scrape-ibdb.ts always read a row's title from
// cells[0], even after assertTableSchema passed — that schema check only
// verifies a table has 2+ cells (IBDB's exact header labels aren't pinned
// down), so a title column reorder would silently misassign the title.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveIbdbTitleIndices } = require('../../scripts/lib/ibdb-table-columns.js');

test('resolves the title column via a "Show" header label', () => {
  const headerRows = [['Show', 'Gross', 'Performances', 'Attendance']];
  assert.deepEqual(resolveIbdbTitleIndices(headerRows), [0]);
});

test('resolves the title column by label when it is not first', () => {
  // Simulates IBDB inserting a "Rank" column before Show — a fixed
  // cells[0] reader would misread the rank number as the title.
  const headerRows = [['Rank', 'Show', 'Gross', 'Performances']];
  assert.deepEqual(resolveIbdbTitleIndices(headerRows), [1]);
});

test('falls back to a "Title" label when "Show" is absent', () => {
  const headerRows = [['Title', 'Gross']];
  assert.deepEqual(resolveIbdbTitleIndices(headerRows), [0]);
});

test('falls back to index 0 when no title-ish header label is found', () => {
  const headerRows = [['Foo', 'Bar']];
  assert.deepEqual(resolveIbdbTitleIndices(headerRows), [0]);
});

test('an exact "Title" match wins over a loose substring match on "Show"', () => {
  // Regression: checking 'Show' (exact-then-substring) before ever trying
  // 'Title' let a substring hit like "Shows Played" beat an exact "Title"
  // header elsewhere in the same row.
  const headerRows = [['Shows Played', 'Title', 'Gross']];
  assert.deepEqual(resolveIbdbTitleIndices(headerRows), [1]);
});

test('resolves each table independently across multiple tables on the page', () => {
  const headerRows = [
    ['Rank', 'Show', 'Gross'],
    ['Show', 'Performances'],
    [],
  ];
  assert.deepEqual(resolveIbdbTitleIndices(headerRows), [1, 0, 0]);
});
