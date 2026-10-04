// Unit tests for scripts/lib/parse-playbill-grosses.js (BRO-4623).
//
// Fixture: tests/fixtures/playbill-grosses/week-2026-09-13.html, a trimmed
// capture of https://playbill.com/grosses?week=2026-09-13 (fetched 2026-10-04).
// Expected values below are the BroadwayWorld-sourced figures already stored
// in grosses.json / grosses-history.json for the same week, so these tests pin
// field-for-field parity with the old source, not just "it parses".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parsePlaybillGrossesHtml,
  validatePlaybillGrosses,
  isPlausibleRow,
  findMissingHistoryWeeks,
  isoWeekToMDY,
  playbillGrossesUrl,
} = require('../../scripts/lib/parse-playbill-grosses.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'playbill-grosses', 'week-2026-09-13.html'),
  'utf8',
);

const parsed = parsePlaybillGrossesHtml(FIXTURE);
const byShow = (prefix) => parsed.rows.find(r => r.show.startsWith(prefix));

test('reads the selected week, the week list, and every row', () => {
  assert.equal(parsed.schemaError, null);
  assert.equal(parsed.weekEnding, '2026-09-13');
  assert.deepEqual(parsed.availableWeeks.slice(0, 4), ['2026-09-27', '2026-09-20', '2026-09-13', '2026-09-06']);
  assert.equal(parsed.rows.length, 26);
  assert.deepEqual(validatePlaybillGrosses(parsed, { expectedWeek: '2026-09-13' }), []);
});

test('Hamilton matches the BWW-sourced grosses.json row for 9/13/2026 field for field', () => {
  const h = byShow('Hamilton');
  assert.equal(h.theater, 'Richard Rodgers Theatre');
  assert.equal(h.gross, 2541403);
  assert.equal(h.grossPrevWeek, 2187028);
  assert.equal(h.capacityPct, 97.56);
  assert.equal(h.capacityPctPrevWeek, 100.89);
  assert.equal(h.atp, 245.93);
  assert.equal(h.attendance, 10334);
  assert.equal(h.performances, 8);
  // Seats in Theatre (1,324) × 8 perfs: the same 10,592 BWW published for
  // Hamilton as its weekly seats offered (BWW 07/06/2026 capture).
  assert.equal(h.seatsOffered, 10592);
});

test('gross is rounded to whole dollars (BWW stored integers) and decodes entities', () => {
  const j = byShow('& Juliet');
  assert.ok(j, '"&amp; Juliet" decodes to "& Juliet"');
  assert.equal(j.gross, 601908); // $601,907.85
  assert.equal(j.grossPrevWeek, 779070); // 601,907.85 + 177,162.10
  assert.equal(j.capacityPctPrevWeek, 90.44); // 83.42 - (-7.02)
});

test('performances = Perfs + Previews (BWW counted preview performances too)', () => {
  const sg = byShow('School Girls');
  assert.equal(sg.perfs, 0);
  assert.equal(sg.previews, 7);
  assert.equal(sg.performances, 7);
});

test('a first reported week ($0.00 diff) has no prev-week figures, not "same as this week"', () => {
  const sg = byShow('School Girls');
  assert.equal(sg.grossDiff, 0);
  assert.equal(sg.grossPrevWeek, null);
  assert.equal(sg.capacityPctPrevWeek, null);
});

test('row grosses add up to the page\'s Week\'s Total', () => {
  assert.equal(parsed.weekTotalGross, 25019859.44);
  const sum = parsed.rows.reduce((acc, r) => acc + r.gross, 0);
  assert.ok(Math.abs(sum - parsed.weekTotalGross) <= parsed.rows.length);
});

test('seatsOffered is kept only when it reproduces the published % Cap', () => {
  for (const r of parsed.rows) {
    if (r.seatsOffered == null) continue;
    const cap = (r.attendance / r.seatsOffered) * 100;
    assert.ok(Math.abs(cap - r.capacityPct) < 0.05, `${r.show}: ${cap} vs ${r.capacityPct}`);
  }
  // Break the arithmetic for one row: seats in theatre no longer explains % Cap.
  const tampered = FIXTURE.replace(
    '<span class="data-value">10,334</span>\n        <span class="subtext">1,324</span>',
    '<span class="data-value">10,334</span>\n        <span class="subtext">1,500</span>',
  );
  assert.notEqual(tampered, FIXTURE, 'fixture snippet for Hamilton seats not found');
  const h = parsePlaybillGrossesHtml(tampered).rows.find(r => r.show === 'Hamilton');
  assert.equal(h.seatsInTheatre, 1500);
  assert.equal(h.seatsOffered, null);
});

test('flags a page that shows a different week than requested (Playbill falls back to latest)', () => {
  const problems = validatePlaybillGrosses(parsed, { expectedWeek: '2026-09-20' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /requested week 2026-09-20 but page shows 2026-09-13/);
});

test('a missing header label fails loud with no rows', () => {
  const drifted = FIXTURE.replace('data-cms-ai="0">Avg Ticket', 'data-cms-ai="0">Average Price');
  assert.notEqual(drifted, FIXTURE);
  const p = parsePlaybillGrossesHtml(drifted);
  assert.match(p.schemaError, /Avg Ticket/);
  assert.equal(p.rows.length, 0);
  assert.ok(validatePlaybillGrosses(p).some(x => /table schema/.test(x)));
});

test('columns are resolved by header label, so a reorder does not misassign values', () => {
  const html = `<table><thead>
    <th>% Cap</th><th>Show</th><th>Diff % cap</th><th>Perfs <span class="subtext">Previews</span></th>
    <th>This Week Gross <span class="subtext">Potential Gross</span></th><th>Diff $</th>
    <th>Seats Sold <span class="subtext">Seats in Theatre</span></th><th>Avg Ticket <span class="subtext">Top Ticket</span></th>
  </thead><tbody><tr>
    <td data-label="% Cap"><span class="data-value">97.56%</span></td>
    <td data-label="Show"><a><span class="data-value">Hamilton</span></a><span class="subtext">Richard Rodgers Theatre</span></td>
    <td data-label="Diff % cap"><span class="data-value">-3.33%</span></td>
    <td data-label="Perfs"><span class="data-value">8</span><span class="subtext">0</span></td>
    <td data-label="This Week Gross"><span class="data-value">$2,541,403.00</span><span class="subtext"></span></td>
    <td data-label="Diff $"><span class="data-value">$354,375.00</span></td>
    <td data-label="Seats Sold"><span class="data-value">10,334</span><span class="subtext">1,324</span></td>
    <td data-label="Avg Ticket"><span class="data-value">$245.93</span><span class="subtext">$599.00</span></td>
  </tr></tbody></table>`;
  const [h] = parsePlaybillGrossesHtml(html).rows;
  assert.equal(h.gross, 2541403);
  assert.equal(h.grossPrevWeek, 2187028);
  assert.equal(h.atp, 245.93);
  assert.equal(h.attendance, 10334);
  assert.equal(h.performances, 8);
  assert.equal(h.capacityPct, 97.56);
  assert.equal(h.capacityPctPrevWeek, 100.89);
});

test('a Cloudflare challenge page is rejected, not parsed as zero shows', () => {
  const challenge = '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';
  const problems = validatePlaybillGrosses(parsePlaybillGrossesHtml(challenge));
  assert.ok(problems.length >= 2, JSON.stringify(problems));
});

test('isPlausibleRow uses the BWW sanity ranges', () => {
  for (const r of parsed.rows) assert.equal(isPlausibleRow(r), true, r.show);
  assert.equal(isPlausibleRow({ gross: 1, atp: 8, performances: 8, capacityPct: 90 }), false);
  assert.equal(isPlausibleRow({ gross: 1, atp: 100, performances: 100, capacityPct: 90 }), false);
  assert.equal(isPlausibleRow({ gross: 1, atp: 100, performances: 8, capacityPct: 0.25 }), false);
  assert.equal(isPlausibleRow({ gross: null, atp: 8 }), true);
});

test('findMissingHistoryWeeks finds the BRO-4623 gap and nothing else', () => {
  const historyKeys = ['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13'];
  const available = ['2026-09-27', '2026-09-20', '2026-09-13', '2026-09-06', '2026-08-30', '2026-08-23', '2026-08-16', '2026-08-09', '2026-08-02'];
  assert.deepEqual(findMissingHistoryWeeks(historyKeys, available, '2026-09-27', 8), ['2026-09-20']);
  // Run the next week after 9/20 and 9/27 also failed: both gaps, oldest first.
  assert.deepEqual(findMissingHistoryWeeks(historyKeys, ['2026-10-04', ...available], '2026-10-04', 8), ['2026-09-20', '2026-09-27']);
  assert.deepEqual(findMissingHistoryWeeks(historyKeys, available, '2026-09-27', 0), []);
});

test('findMissingHistoryWeeks treats a Monday-keyed BWW week as present', () => {
  // grosses-history.json holds 2026-07-06 (a Monday) for Playbill's 2026-07-05.
  assert.deepEqual(findMissingHistoryWeeks(['2026-07-06'], ['2026-07-12', '2026-07-05'], '2026-07-12', 8), []);
});

test('findMissingHistoryWeeks only looks maxWeeks back', () => {
  const available = ['2026-09-27', '2026-09-20', '2026-09-13', '2026-09-06'];
  assert.deepEqual(findMissingHistoryWeeks([], available, '2026-09-27', 2), ['2026-09-13', '2026-09-20']);
});

test('week helpers', () => {
  assert.equal(isoWeekToMDY('2026-09-27'), '9/27/2026');
  assert.equal(isoWeekToMDY('2026-10-04'), '10/4/2026');
  assert.equal(isoWeekToMDY('nope'), null);
  assert.equal(playbillGrossesUrl(), 'https://playbill.com/grosses');
  assert.equal(playbillGrossesUrl('2026-09-20'), 'https://playbill.com/grosses?week=2026-09-20');
  assert.throws(() => playbillGrossesUrl('9/20/2026'));
});
