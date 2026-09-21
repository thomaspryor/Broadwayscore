// Unit tests for scripts/lib/evening-standard-parser.js (BRO-3596).
//
// Regression target: extractCategoryEntries relied entirely on the
// hardcoded SHOW_COL_BY_CATEGORY position (and a bare cells[0] header-row
// sniff) with NO assertTableSchema guard — worse than the BRO-2375 cousins.
// A category table that reorders its data columns silently reads the wrong
// cell as the winner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractCategoryEntries } = require('../../scripts/lib/evening-standard-parser.js');

function esPage(rowsHtml) {
  return `<html><body>
<table class="wikitable">
<tbody>
${rowsHtml}
</tbody>
</table>
</body></html>`;
}

test('parses the live single-row-per-ceremony schema (Ceremony | Play)', () => {
  const html = esPage(`
    <tr><th>Ceremony</th><th>Play</th><th>Writer</th></tr>
    <tr><td>1st</td><td>Chips with Everything</td><td>Arnold Wesker</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best Play', 1900);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 1955);
  assert.equal(entries[0].winner, 'Chips with Everything');
});

test('resolves the show column by label when Writer moves ahead of Play', () => {
  // SHOW_COL_BY_CATEGORY['Best Play'] = 0 (first data column). If Writer and
  // Play swap order, a bare fixed index would read the writer's name as the
  // winning play.
  const html = esPage(`
    <tr><th>Ceremony</th><th>Writer</th><th>Play</th></tr>
    <tr><td>2nd</td><td>Robert Bolt</td><td>A Man for All Seasons</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best Play', 1900);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].winner, 'A Man for All Seasons');
});

test('resolves the Best Actor show column (Work) by label regardless of position', () => {
  const html = esPage(`
    <tr><th>Ceremony</th><th>Work</th><th>Actor</th></tr>
    <tr><td>3rd</td><td>Hamlet</td><td>Peter O'Toole</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best Actor', 1900);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].winner, 'Hamlet');
});

test('skips a table whose header row is too short instead of misreading rows', () => {
  const html = esPage(`
    <tr><th>Ceremony</th></tr>
    <tr><td>4th</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best Play', 1900);
  assert.deepEqual(entries, []);
});
