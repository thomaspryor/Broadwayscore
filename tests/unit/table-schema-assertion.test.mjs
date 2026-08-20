// Unit tests for scripts/lib/table-schema-assertion.js (task #118).
//
// Regression target: BroadwayWorld's cumulative grosses table dropped from 7
// to 5 columns in March 2026. scrape-alltime.ts hardcoded cells[6] + a
// `cells.length < 6` guard, so every row silently fell below the guard and
// the cron logged "Found 0 shows" for two months (fixed in 09c841f07c).
// These tests lock in that a column-count or header-label drift is rejected
// LOUDLY (a thrown TableSchemaError) instead of silently producing 0 rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertTableSchema, TableSchemaError, findColumnIndex } = require('../../scripts/lib/table-schema-assertion.js');

// Real header rows captured live from BroadwayWorld 2026-08-12.
const ALLTIME_HEADER = ['Show', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf.'];
const ALLTIME_SCHEMA = { minCells: 5, expectedHeaders: ['Show', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf'] };

const GROSSES_HEADER = [
  'ShowTheater', 'Gross', 'GrossPrev week', 'Gross Diff.', 'Avg. TixTop Tix',
  'Attend.Capacity', 'Perf.Prev.', 'Cap %This Wk', 'Cap %Last Wk', 'Diff. %',
];
const GROSSES_SCHEMA = { minCells: 10, expectedHeaders: ['Show', 'Gross', 'Avg. Tix', 'Attend', 'Perf', 'Cap %'] };

test('assertTableSchema passes for the live all-time grosses header', () => {
  assert.equal(assertTableSchema([ALLTIME_HEADER], ALLTIME_SCHEMA), true);
});

test('assertTableSchema passes for the live weekly grosses header', () => {
  assert.equal(assertTableSchema([GROSSES_HEADER], GROSSES_SCHEMA), true);
});

test('assertTableSchema throws when column count drops below the minimum (the March 2026 incident)', () => {
  // BWW's real regression: 7 cols -> 5 cols on the all-time page collapsed
  // the weekly-grosses-shaped table down past its 10-cell minimum.
  const shrunk = ALLTIME_HEADER.slice(0, 3);
  assert.throws(
    () => assertTableSchema([shrunk], ALLTIME_SCHEMA),
    TableSchemaError
  );
});

test('assertTableSchema throws when an expected header label is missing (renamed column)', () => {
  const renamed = ['Show', 'Revenue', 'Avg. Tix', 'Seats Sold', 'Total Perf.'];
  assert.throws(
    () => assertTableSchema([renamed], ALLTIME_SCHEMA),
    TableSchemaError
  );
});

test('assertTableSchema throws when there are no rows at all (table missing)', () => {
  assert.throws(() => assertTableSchema([], ALLTIME_SCHEMA), TableSchemaError);
  assert.throws(() => assertTableSchema([[]], ALLTIME_SCHEMA), TableSchemaError);
});

test('assertTableSchema requires minCells', () => {
  assert.throws(() => assertTableSchema([ALLTIME_HEADER], {}), TableSchemaError);
});

test('assertTableSchema skips label checking when expectedHeaders is omitted', () => {
  assert.equal(assertTableSchema([ALLTIME_HEADER], { minCells: 5 }), true);
});

test('assertTableSchema is case- and whitespace-insensitive for header matching', () => {
  const messy = ['  show  ', 'GROSS', 'avg.   tix', 'Seats Sold', 'total perf.'];
  assert.equal(assertTableSchema([messy], ALLTIME_SCHEMA), true);
});

// findColumnIndex (task BRO-47 follow-up) — resolves a column's position
// by header label so assertTableSchema passing (all labels present
// somewhere) doesn't mask a fixed-index read silently landing on the
// wrong cell after a column is inserted or reordered.

test('findColumnIndex finds an exact-match header', () => {
  assert.equal(findColumnIndex(ALLTIME_HEADER, 'Show'), 0);
  assert.equal(findColumnIndex(ALLTIME_HEADER, 'Gross'), 1);
});

test('findColumnIndex falls back to substring match (e.g. "Total Perf." trailing period)', () => {
  assert.equal(findColumnIndex(ALLTIME_HEADER, 'Total Perf'), 4);
});

test('findColumnIndex returns -1 when no header cell matches', () => {
  assert.equal(findColumnIndex(ALLTIME_HEADER, 'Weeks Running'), -1);
});

test('findColumnIndex prefers an exact match over an unrelated substring collision', () => {
  // A hypothetical future column ("Weekly Gross") that contains "Gross" as
  // a substring must not steal the match from the real "Gross" column.
  const withCollision = ['Show', 'Weekly Gross', 'Gross', 'Seats Sold', 'Total Perf.'];
  assert.equal(findColumnIndex(withCollision, 'Gross'), 2);
});

test('findColumnIndex falls back to substring match when no exact match exists at all', () => {
  // No column is titled exactly "Gross" — only "Weekly Gross" exists — so
  // the substring fallback is the correct (only) way to resolve it.
  const onlySubstring = ['Show', 'Weekly Gross', 'Seats Sold', 'Total Perf.'];
  assert.equal(findColumnIndex(onlySubstring, 'Gross'), 1);
});

test('findColumnIndex is case- and whitespace-insensitive', () => {
  const messy = ['  show  ', 'GROSS', 'avg.   tix', 'Seats Sold', 'total perf.'];
  assert.equal(findColumnIndex(messy, 'Gross'), 1);
});
