// Unit tests for scripts/lib/critics-circle-parser.js (BRO-3596).
//
// Regression target: extractCategoryEntries read the Year column at
// cells[0] with NO assertTableSchema guard at all — worse than the
// BRO-2375 cousins, which at least had a schema check (just one that
// didn't verify column position). A decade table that inserts or reorders
// a column ahead of Year would silently drop every row in that table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractCategoryEntries } = require('../../scripts/lib/critics-circle-parser.js');

function ccPage(rowsHtml, sectionId = 'Best_New_Play') {
  return `<html><body><div class="mw-heading mw-heading3"><h3 id="${sectionId}">${sectionId.replace(/_/g, ' ')}</h3></div>
<table class="wikitable">
<tbody>
${rowsHtml}
</tbody>
</table>
</body></html>`;
}

test('parses the live schema (Year | Play | Writer | Ref)', () => {
  const html = ccPage(`
    <tr><th>Year</th><th>Play</th><th>Writer</th><th>Ref</th></tr>
    <tr><td>1990</td><td>Racing Demon</td><td>David Hare</td><td>[1]</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best New Play', 1980);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 1990);
  assert.equal(entries[0].winner, 'Racing Demon');
  assert.deepEqual(entries[0].nominees, ['Racing Demon']);
});

test('resolves the Year column by label when Ref moves ahead of it', () => {
  // Simulates a decade table where a "Ref" column moved ahead of Year (Play
  // stays at its expected index 1, matching SHOW_COLUMN_BY_CATEGORY, so this
  // isolates the Year-column fix). Before the fix, a bare cells[0] read would
  // try to parse "[2]" as a 4-digit year, fail to match, and silently drop
  // this row entirely (0 entries for the whole table).
  const html = ccPage(`
    <tr><th>Ref</th><th>Play</th><th>Year</th><th>Writer</th></tr>
    <tr><td>[2]</td><td>Arcadia</td><td>1994</td><td>Tom Stoppard</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best New Play', 1980);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 1994);
  assert.equal(entries[0].winner, 'Arcadia');
});

test('skips a table whose header has no Year label instead of misreading rows', () => {
  const html = ccPage(`
    <tr><th>Season</th><th>Play</th><th>Writer</th></tr>
    <tr><td>1994-95</td><td>Arcadia</td><td>Tom Stoppard</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best New Play', 1980);
  assert.deepEqual(entries, []);
});

test('Best Actor category still resolves showCol=2 alongside a label-based Year column', () => {
  const html = ccPage(`
    <tr><th>Year</th><th>Actor</th><th>Work</th><th>Ref</th></tr>
    <tr><td>2001</td><td>Simon Russell Beale</td><td>Hamlet</td><td>[3]</td></tr>
  `, 'Best_Actor');
  const entries = extractCategoryEntries(html, 'Best Actor', 1980);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].winner, 'Hamlet');
});

test('resolves the SHOW column by label too, when Play moves off its fixed index', () => {
  // Code-review finding: resolving Year alone while leaving Show at the
  // fixed SHOW_COLUMN_BY_CATEGORY index is worse than leaving both fixed —
  // before this fix, showCol=1 would read "1994" (the Year column's own
  // text) as the winner once Play moved to index 2, with no signal at all
  // since Year still resolved "correctly".
  const html = ccPage(`
    <tr><th>Ref</th><th>Year</th><th>Play</th><th>Writer</th></tr>
    <tr><td>[2]</td><td>1994</td><td>Arcadia</td><td>Tom Stoppard</td></tr>
  `);
  const entries = extractCategoryEntries(html, 'Best New Play', 1980);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 1994);
  assert.equal(entries[0].winner, 'Arcadia');
});
