// Unit tests for scripts/lib/nydcc-legacy-table-parser.js (BRO-2375).
//
// Regression target: scripts/scrape-nydcc.js's pre-2010 combined wikitable
// parser read Year/Show/"Nominated for" via cells[0]/[1]/[3] even after
// assertTableSchema — a schema check that only verifies the row has 4+
// cells, not that those columns are still at those positions. Wikipedia
// inserting or reordering a column (e.g. moving "Author(s)") would silently
// misassign values without ever failing the schema check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseNydccLegacyTable } = require('../../scripts/lib/nydcc-legacy-table-parser.js');

const categoryForHeading = (text) => {
  const norm = (text || '').toLowerCase();
  if (/best american play|best play(?:\s*\()?/i.test(norm)) return 'Best Play';
  if (/best foreign play/i.test(norm)) return 'Best Foreign Play';
  if (/best musical/i.test(norm)) return 'Best Musical';
  return null;
};

const cleanTitle = (raw) => {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s*\[\d+\]\s*$/, '').trim();
  return cleaned.length > 1 ? cleaned : null;
};

function tableHtml(headers, rows) {
  const thead = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table>${thead}${tbody}</table>`;
}

test('parses the live schema (Year / Show / Author(s) / Nominated for)', () => {
  const html = tableHtml(
    ['Year', 'Show', 'Author(s)', 'Nominated for'],
    [['1936', '<i>Idiot\'s Delight</i>', 'Robert E. Sherwood', 'Best Play']]
  );
  const { error, entries } = parseNydccLegacyTable(html, { minYear: 1900, categoryForHeading, cleanTitle });
  assert.equal(error, null);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { category: 'Best Play', year: 1936, title: "Idiot's Delight" });
});

test('resolves columns by label, not position, when a column is inserted before Show', () => {
  // Simulates Wikipedia inserting a "Ref." column between Year and Show —
  // a fixed-index reader (cells[1] for Show) would misread the new column
  // as the title.
  const html = tableHtml(
    ['Year', 'Ref.', 'Show', 'Author(s)', 'Nominated for'],
    [['1938', '[1]', '<i>Our Town</i>', 'Thornton Wilder', 'Best Play']]
  );
  const { error, entries } = parseNydccLegacyTable(html, { minYear: 1900, categoryForHeading, cleanTitle });
  assert.equal(error, null);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { category: 'Best Play', year: 1938, title: 'Our Town' });
});

test('resolves columns by label when Nominated-for and Author(s) swap order', () => {
  const html = tableHtml(
    ['Year', 'Show', 'Nominated for', 'Author(s)'],
    [['1941', '<i>Native Son</i>', 'Best Play', 'Richard Wright']]
  );
  const { error, entries } = parseNydccLegacyTable(html, { minYear: 1900, categoryForHeading, cleanTitle });
  assert.equal(error, null);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { category: 'Best Play', year: 1941, title: 'Native Son' });
});

test('returns a schema error instead of throwing when the header row is too short', () => {
  const html = tableHtml(['Year', 'Show'], [['1936', "Idiot's Delight"]]);
  const { error, entries } = parseNydccLegacyTable(html, { minYear: 1900, categoryForHeading, cleanTitle });
  assert.ok(error, 'expected a schema error message');
  assert.deepEqual(entries, []);
});

test('recognizes a "Category" header as an alternate to "Nominated for"', () => {
  // scrape-nydcc.js's own table-selection regex accepts either spelling
  // (/nominated for|category/i) — the parser must resolve both the same way
  // instead of silently returning zero entries for the "Category" spelling.
  const html = tableHtml(
    ['Year', 'Show', 'Author(s)', 'Category'],
    [['1936', "<i>Idiot's Delight</i>", 'Robert E. Sherwood', 'Best Play']]
  );
  const { error, entries } = parseNydccLegacyTable(html, { minYear: 1900, categoryForHeading, cleanTitle });
  assert.equal(error, null);
  assert.equal(entries.length, 1);
});

test('returns an error instead of throwing when a required label is missing entirely', () => {
  // Regression: a missing catIdx (-1) reached cells[-1] and threw instead of
  // failing loud the way assertTableSchema-guarded reads are supposed to.
  const html = tableHtml(
    ['Year', 'Show', 'Author(s)', 'Something Else'],
    [['1936', "<i>Idiot's Delight</i>", 'Robert E. Sherwood', 'Best Play']]
  );
  assert.doesNotThrow(() => {
    const { error, entries } = parseNydccLegacyTable(html, { minYear: 1900, categoryForHeading, cleanTitle });
    assert.ok(error, 'expected an error message, not a silent empty result');
    assert.deepEqual(entries, []);
  });
});

test('filters years below minYear and rows without a matching category', () => {
  const html = tableHtml(
    ['Year', 'Show', 'Author(s)', 'Nominated for'],
    [
      ['1920', '<i>Too Old</i>', 'Someone', 'Best Play'],
      ['2020', '<i>Uncategorized</i>', 'Someone', 'Best Revival'],
      ['2021', '<i>Included</i>', 'Someone', 'Best Musical'],
    ]
  );
  const { entries } = parseNydccLegacyTable(html, { minYear: 2000, categoryForHeading, cleanTitle });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Included');
});
