// Column-order regression coverage for scripts/lib/alltime-table-parser.js
// (scripts/scrape-alltime.ts), part of the BRO-2375 "column-count
// brittleness cousins" sweep.
//
// scrape-alltime.ts itself was already fixed for this class of bug under
// BRO-47 (see tests/unit/scrape-alltime-column-count.test.mjs): it resolves
// Show/Gross/Seats Sold/Total Perf by header label via findColumnIndex,
// not by fixed cells[N] index, so assertTableSchema passing doesn't imply
// the columns are still where a fixed-position reader would assume. This
// file adds targeted column-reordering/insertion cases beyond the ones
// already covered, so the whole reordering-resilience contract for the
// all-time scraper has explicit, isolated coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseAllTimeHtml } = require('../../scripts/lib/alltime-table-parser.js');

function tableHtml(headers, rows) {
  const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table>${thead}<tbody>${tbody}</tbody></table>`;
}

test('resolves columns correctly when the entire column order is reversed', () => {
  const html = tableHtml(
    ['Total Perf.', 'Seats Sold', 'Avg. Tix', 'Gross', 'Show'],
    [['4,200', '6,032,000', '$189.50', '$1,143,000,000', 'Hamilton\nRichard Rodgers Theatre']]
  );
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].showTitle, 'Hamilton');
  assert.equal(rows[0].gross, '$1,143,000,000');
  assert.equal(rows[0].attendance, '6,032,000');
  assert.equal(rows[0].performances, '4,200');
});

test('resolves columns correctly when a new column is appended at the end', () => {
  const html = tableHtml(
    ['Show', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf.', 'Rank'],
    [['Wicked\nGershwin Theatre', '$900,000,000', '$150.00', '5,500,000', '9,500', '2']]
  );
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].showTitle, 'Wicked');
  assert.equal(rows[0].attendance, '5,500,000');
  assert.equal(rows[0].performances, '9,500');
});

test('resolves columns correctly across multiple rows after a column insertion', () => {
  const html = tableHtml(
    ['Show', 'Weeks Running', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf.'],
    [
      ['Hamilton\nRichard Rodgers Theatre', '520', '$1,143,000,000', '$189.50', '6,032,000', '4,200'],
      ['Chicago\nAmbassador Theatre', '1400', '$700,000,000', '$95.00', '9,000,000', '11,005'],
    ]
  );
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attendance, '6,032,000');
  assert.equal(rows[1].attendance, '9,000,000');
  assert.equal(rows[1].performances, '11,005');
});
