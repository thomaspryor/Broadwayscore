// Unit tests for parseYearPageTable in scripts/lib/year-page-precursor.js
// (BRO-3596).
//
// Regression target: scrapeYear read the category slot at cells[0] with NO
// schema guard at all. Unlike the HTML-table parsers in this codebase, this
// wikitext format has no header row to resolve columns by label from — each
// row is a strict two-cell `Category | Nominees` pair by MediaWiki template
// convention, so there's no "Year" or "Show" label to look up. The
// equivalent guard here is asserting the table's rows actually reach that
// 2-cell shape BEFORE trusting cells[0] as the category — a table whose
// rows never split into 2+ cells previously yielded zero categories with no
// signal at all, indistinguishable from "no data this year" at the caller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseYearPageTable } = require('../../scripts/lib/year-page-precursor.js');
const { TableSchemaError } = require('../../scripts/lib/table-schema-assertion.js');

const categoryPrefixRe = /(?:Outstanding|Best)/i;

test('parses a well-formed category table', () => {
  const table = `{| class="wikitable"
|-
! Category !! Nominees
|-
| '''[[Outstanding Musical]]'''
| {{bulleted list|''[[Ragtime]]''|''[[Cats]]''}}
|-
|}`;
  const categories = parseYearPageTable(table, { year: 2024, categoryPrefixRe });
  assert.ok(categories['Outstanding Musical'], 'expected an Outstanding Musical entry');
  assert.equal(categories['Outstanding Musical'].year, 2024);
  assert.deepEqual(categories['Outstanding Musical'].nominees, ['Ragtime', 'Cats']);
});

test('a leading one-cell separator row does not reject an otherwise-valid table', () => {
  // Code-review finding: checking only dataRows[0] would wrongly reject a
  // table whose first row is a colspan'd section divider even though every
  // other row is a normal 2-cell Category|Nominees pair.
  const table = `{| class="wikitable"
|-
| colspan="2" | Acting awards
|-
| '''[[Outstanding Lead Actor]]'''
| {{bulleted list|''[[Ragtime]]''|''[[Cats]]''}}
|-
|}`;
  const categories = parseYearPageTable(table, { year: 2024, categoryPrefixRe });
  assert.ok(categories['Outstanding Lead Actor'], 'expected an Outstanding Lead Actor entry despite the leading divider row');
});

test('throws TableSchemaError instead of silently returning zero categories when rows never reach 2 cells', () => {
  // Simulates a markup change that collapses the Category|Nominees row onto
  // a single cell. Before the fix, this returned {} with no signal — the
  // exact "0 categories" shape a legitimately-empty year also produces —
  // and runYearPageScraper's format-drift check only fires when catCount > 0.
  const table = `{| class="wikitable"
|-
| Just one cell here
|-
|}`;
  assert.throws(
    () => parseYearPageTable(table, { year: 2024, categoryPrefixRe }),
    TableSchemaError,
  );
});
