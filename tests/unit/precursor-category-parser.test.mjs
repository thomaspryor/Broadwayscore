// Unit tests for scripts/lib/precursor-category-parser.js (BRO-3596).
//
// Regression target: the per-table row loop read the Year column at
// cells[0] with NO assertTableSchema guard at all — worse than the
// BRO-2375 cousins. A table that inserts a column ahead of Year would
// silently read a non-year cell as the year on every row, dropping the
// whole table with no signal at all.
//
// parseCategoryPage's own table-SELECTION step (yearTables filter) also
// resolves Year by header label now — a code-review finding on the first
// version of this fix caught that the per-row resolution in parseYearTable
// was unreachable in production if selection still assumed cells[0]: a
// table that moved Year off the first column would never even be picked as
// a "year table". The column-reorder regression test below therefore goes
// through the real parseCategoryPage entry point, not just parseYearTable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { parseCategoryPage, parseYearTable } = require('../../scripts/lib/precursor-category-parser.js');
const { TableSchemaError } = require('../../scripts/lib/table-schema-assertion.js');

function tableEl(rowsHtml) {
  const dom = new JSDOM(`<table class="wikitable">${rowsHtml}</table>`);
  return dom.window.document.querySelector('table');
}

function newYearMap() {
  const byYear = new Map();
  const ensureYear = (y) => {
    if (!byYear.has(y)) byYear.set(y, { year: y, winner: null, nomineeSet: new Map() });
    return byYear.get(y);
  };
  return { byYear, ensureYear };
}

test('parses the live schema (Year | Winner | Nominees) end-to-end via parseCategoryPage', () => {
  const html = `<html><body><table class="wikitable">
    <tr><th>Year</th><th>Winner</th><th>Nominees</th></tr>
    <tr><td>2020</td><td><i><b>Hadestown</b></i></td><td></td></tr>
  </table></body></html>`;
  const entries = parseCategoryPage(html, { minYear: 2000 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2020);
  assert.equal(entries[0].winner, 'Hadestown');
});

test('resolves the Year column by label end-to-end via parseCategoryPage when a Ref column is inserted before it', () => {
  // Before the fix, cells[0] ("[1]") would fail parseFourDigitYear both at
  // table-selection time (yearTables filter) and at row-extraction time —
  // this table would never even be selected, let alone parsed.
  const html = `<html><body><table class="wikitable">
    <tr><th>Ref</th><th>Year</th><th>Winner</th></tr>
    <tr><td>[1]</td><td>2021</td><td><i><b>Moulin Rouge!</b></i></td></tr>
  </table></body></html>`;
  const entries = parseCategoryPage(html, { minYear: 2000 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2021);
  assert.equal(entries[0].winner, 'Moulin Rouge!');
});

test('throws TableSchemaError instead of misreading rows when Year is not a header label', () => {
  const table = tableEl(`
    <tr><th>Season</th><th>Winner</th></tr>
    <tr><td>2021-22</td><td><i><b>Moulin Rouge!</b></i></td></tr>
  `);
  const { ensureYear } = newYearMap();
  assert.throws(() => parseYearTable(table, { minYear: 2000 }, ensureYear), TableSchemaError);
});

test('parseCategoryPage soft-continues (empty result) when a table fails the schema check', () => {
  const html = `<html><body><table class="wikitable">
    <tr><th>Season</th><th>Winner</th></tr>
    <tr><td>2021-22</td><td><i><b>Moulin Rouge!</b></i></td></tr>
  </table></body></html>`;
  const entries = parseCategoryPage(html, { minYear: 2000 });
  assert.deepEqual(entries, []);
});
