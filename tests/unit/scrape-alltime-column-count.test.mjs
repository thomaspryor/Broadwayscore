// Unit tests for scripts/lib/alltime-table-parser.js (task BRO-47).
//
// Regression target: BroadwayWorld's cumulative grosses table dropped from 7
// to 5 columns in March 2026. scrape-alltime.ts hardcoded cells[6] for
// performances + a `cells.length < 6` guard, so every row fell below the
// guard and the cron logged "Found 0 shows" for two months (fixed in
// 09c841f07c, then centralized via assertTableSchema in 50e0a4f/task #118).
//
// These tests lock in the BRO-47 follow-up: column positions are now
// resolved by header LABEL (findColumnIndex), not a fixed index, so a
// column being inserted/reordered/appended doesn't silently misassign a
// value to the wrong field the way a fixed-position read would — even
// though a fixed-position read would still pass assertTableSchema's
// label-presence check (all expected labels are still present somewhere in
// the header row; only their *positions* moved).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseAllTimeHtml } = require('../../scripts/lib/alltime-table-parser.js');

function tableHtml(headers, rows) {
  const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = rows
    .map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${thead}<tbody>${tbody}</tbody></table>`;
}

test('parses the current live 5-column schema (Show/Gross/Avg. Tix/Seats Sold/Total Perf)', () => {
  const html = tableHtml(
    ['Show', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf.'],
    [['Hamilton\nRichard Rodgers Theatre', '$1,143,000,000', '$189.50', '6,032,000', '4,200']]
  );
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].showTitle, 'Hamilton');
  assert.equal(rows[0].gross, '$1,143,000,000');
  assert.equal(rows[0].attendance, '6,032,000');
  assert.equal(rows[0].performances, '4,200');
});

test('resolves columns by label, not position, when a column is inserted mid-table', () => {
  // Simulates BWW inserting a new "Weeks Running" column between Gross and
  // Avg. Tix — same label set as the live schema, but Seats Sold/Total Perf
  // both shift one position to the right. A fixed-index reader (cells[3]/
  // cells[4]) would misread "Weeks Running"/"Avg. Tix" as attendance/perfs.
  const html = tableHtml(
    ['Show', 'Gross', 'Weeks Running', 'Avg. Tix', 'Seats Sold', 'Total Perf.'],
    [['Wicked\nGershwin Theatre', '$900,000,000', '1,100', '$150.00', '5,500,000', '9,500']]
  );
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attendance, '5,500,000');
  assert.equal(rows[0].performances, '9,500');
});

test('resolves columns by label on the pre-March-2026 7-column legacy schema', () => {
  // The actual legacy layout BWW used to run before dropping to 5 columns:
  // Show / Gross / Previews / Regular Shows / Avg. Tix / Seats Sold / Total Perf.
  const html = tableHtml(
    ['Show', 'Gross', 'Previews', 'Regular Shows', 'Avg. Tix', 'Seats Sold', 'Total Perf.'],
    [['Chicago\nAmbassador Theatre', '$700,000,000', '5', '11,000', '$95.00', '9,000,000', '11,005']]
  );
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attendance, '9,000,000');
  assert.equal(rows[0].performances, '11,005');
});

test('returns [] instead of throwing when a required column is missing entirely', () => {
  const html = tableHtml(
    ['Show', 'Gross', 'Avg. Tix'],
    [['Some Show\nSome Theatre', '$1,000,000', '$100.00']]
  );
  assert.doesNotThrow(() => {
    const rows = parseAllTimeHtml(html);
    assert.deepEqual(rows, []);
  });
});

test('skips rows shorter than the resolved max column index instead of crashing', () => {
  const headers = ['Show', 'Gross', 'Avg. Tix', 'Seats Sold', 'Total Perf.'];
  const html = tableHtml(headers, [
    ['Complete Show\nTheatre', '$1,000,000', '$100.00', '10,000', '500'],
    ['Truncated Row\nTheatre', '$2,000,000'], // malformed: missing trailing cells
  ]);
  const rows = parseAllTimeHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].showTitle, 'Complete Show');
});
