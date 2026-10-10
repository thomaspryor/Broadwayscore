// Unit tests for scripts/lib/grosses-integrity.js (BRO-4988): the weekly
// grosses integrity rules run after every ingest. Each case is the shape of a
// defect found in the 2026-10-10 audit of the real history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../scripts/lib/grosses-integrity.js');
const { ALERT_RULES, parseArgs } = require('../../scripts/check-grosses-integrity.js');

const row = (gross, extra = {}) => ({ gross, capacity: 90, attendance: 7000, seatsOffered: 7778, performances: 8, atp: 100, ...extra });
const rules = (fs) => fs.map((f) => f.rule);

test('week keys: Mondays from the BWW era are flagged, Sundays pass', () => {
  const h = { weeks: { '2026-06-14': {}, '2026-06-22': {}, '2026-07-12': {} } };
  const f = L.checkWeekKeys(h);
  assert.deepEqual(f.map((x) => x.week), ['2026-06-22']);
  assert.equal(L.isSunday('2026-10-04'), true);
  assert.equal(L.isSunday('2026-10-05'), false);
});

test('missing weeks: every Sunday inside a gap is named, before `since` ignored', () => {
  const h = { weeks: { '2020-01-05': {}, '2020-03-01': {}, '2026-06-14': {}, '2026-07-12': {} } };
  const f = L.checkMissingWeeks(h, { since: '2026-01-01' });
  assert.deepEqual(f.map((x) => x.week), ['2026-06-21', '2026-06-28', '2026-07-05']);
});

test('sundayOf: Mon-Wed snap back, Thu-Sat forward', () => {
  assert.equal(L.sundayOf('2026-06-22'), '2026-06-21');
  assert.equal(L.sundayOf('2026-10-08'), '2026-10-11');
  assert.equal(L.sundayOf('2026-10-04'), '2026-10-04');
});

test('totals: rows that add up to the League total pass; a dropped show fails on gross and count', () => {
  const h = { _meta: {}, weeks: { '2026-10-04': { a: row(1_000_000), b: row(500_000) } } };
  assert.equal(L.recordPublishedTotal(h, '2026-10-04', { gross: 1_500_000, showCount: 2, source: 'playbill' }), true);
  assert.deepEqual(L.checkWeekTotals(h), []);
  L.recordPublishedTotal(h, '2026-10-04', { gross: 2_100_000, showCount: 3, source: 'playbill' });
  const f = L.checkWeekTotals(h);
  assert.equal(f.length, 2);
  assert.match(f[0].detail, /published total is \$2,100,000/);
  assert.match(f[1].detail, /2 shows stored but the published list has 3/);
});

test('totals: keyed by Sunday, found under a nearby Monday key; no total recorded without figures', () => {
  const h = { weeks: { '2026-06-22': { a: row(100) } } };
  L.recordPublishedTotal(h, '2026-06-22', { gross: 100, showCount: 1 });
  assert.deepEqual(Object.keys(h._meta.weekTotals), ['2026-06-21']);
  assert.deepEqual(L.checkWeekTotals(h), []);
  assert.equal(L.recordPublishedTotal(h, '2026-06-29', { gross: null, showCount: null }), false);
});

test('total not recorded: newest week without a saved total is reported, never alerted', () => {
  const h = { weeks: { '2026-09-27': { a: row(1) }, '2026-10-04': { a: row(1) } } };
  assert.deepEqual(rules(L.checkTotalRecorded(h, '2026-10-04')), ['total-not-recorded']);
  L.recordPublishedTotal(h, '2026-10-04', { gross: 1, showCount: 1 });
  assert.deepEqual(L.checkTotalRecorded(h, '2026-10-04'), []);
  assert.equal(ALERT_RULES.has('total-not-recorded'), false);
});

test('totals: a mismatch is reported under the stored (Monday) key so the scoped run keeps it', () => {
  const h = { weeks: { '2026-06-22': { a: row(100) } } };
  L.recordPublishedTotal(h, '2026-06-22', { gross: 500, showCount: 2 });
  const f = L.checkGrossesIntegrity(h, [], { weeks: ['2026-06-22'] }).filter((x) => x.rule === 'total-mismatch');
  assert.equal(f.length, 2);
  assert.equal(f[0].week, '2026-06-22');
});

test('dropouts: a show gone without a closing date is flagged; a closed one is not', () => {
  const h = { weeks: { '2026-09-27': { a: row(1), b: row(2), c: row(3) }, '2026-10-04': { a: row(1) } } };
  const shows = [{ slug: 'b', closingDate: '2026-09-28', status: 'closed' }, { slug: 'c', closingDate: '2027-01-03', status: 'open' }];
  const f = L.checkDropouts(h, shows, '2026-10-04');
  assert.deepEqual(f.map((x) => x.slug), ['c']);
  assert.match(f[0].detail, /closingDate is 2027-01-03/);
});

test('duplicate gross: Sweeney Todd 2023 copied a week to the dollar', () => {
  const h = { weeks: { '2023-03-12': { s: row(1_805_510) }, '2023-03-19': { s: row(1_700_000) }, '2023-07-16': { s: row(1_805_510) } } };
  const f = L.checkRepeatedGrosses(h);
  assert.deepEqual(rules(f), ['duplicate-gross']);
  assert.equal(f[0].week, '2023-07-16');
});

test('flat run: 3 weeks within 0.5% below 99% capacity flagged; sold out or a gap breaks it', () => {
  const flat = { weeks: { '2026-01-04': { s: row(1_000_000) }, '2026-01-11': { s: row(1_002_000) }, '2026-01-18': { s: row(999_000) } } };
  assert.deepEqual(rules(L.checkRepeatedGrosses(flat)), ['flat-gross-run']);
  const soldOut = { weeks: { '2026-01-04': { s: row(1_000_000, { capacity: 100 }) }, '2026-01-11': { s: row(1_002_000, { capacity: 100 }) }, '2026-01-18': { s: row(999_000, { capacity: 100 }) } } };
  assert.deepEqual(L.checkRepeatedGrosses(soldOut), []);
  const gap = { weeks: { '2026-01-04': { s: row(1_000_000) }, '2026-01-11': { s: row(1_002_000) }, '2026-01-25': { s: row(999_000) } } };
  assert.deepEqual(L.checkRepeatedGrosses(gap), []);
});

test('capacity capped: Wicked 2025 at exactly 100%/15,408 for 4+ weeks is flagged; over 100% is kept as is', () => {
  const weeks = {};
  ['2025-01-05', '2025-01-12', '2025-01-19', '2025-01-26'].forEach((w, i) => { weeks[w] = { wicked: row(2_000_000 + i, { capacity: 100, attendance: 15408 }) }; });
  const f = L.checkCappedCapacity({ weeks });
  assert.deepEqual(rules(f), ['capacity-capped']);
  assert.deepEqual(f[0].weeks, Object.keys(weeks));
  const over = { weeks: { '2025-01-05': { w: row(1, { capacity: 101.3, attendance: 15600 }) } } };
  assert.deepEqual(L.checkCappedCapacity(over), []);
  const three = { weeks: Object.fromEntries(Object.entries(weeks).slice(0, 3)) };
  assert.deepEqual(L.checkCappedCapacity(three), []);
});

test('row shape: zero performances with a gross, missing seatsOffered', () => {
  const h = { weeks: { '2023-03-12': { s: row(500_000, { performances: 0 }), t: row(1, { seatsOffered: null }), u: row(1, { seatsOffered: null, attendance: null }) } } };
  const f = L.checkRowShape(h, ['2023-03-12']);
  assert.deepEqual(f.map((x) => `${x.rule}:${x.slug}`), ['zero-perf-gross:s', 'seats-offered-missing:t']);
});

test('week-over-week: a 3x move on two full weeks is flagged; a partial week is not', () => {
  const h = { weeks: { '2026-05-03': { c: row(1_688_129) }, '2026-05-10': { c: row(556_231) }, '2026-05-17': { c: row(1_600_000, { performances: 4 }) } } };
  const f = L.checkWowJumps(h);
  assert.deepEqual(f.map((x) => x.week), ['2026-05-10']);
});

test('checkGrossesIntegrity scopes findings to the checked weeks; key and gap rules always surface', () => {
  const h = { weeks: {
    '2023-03-12': { s: row(500_000, { performances: 0 }) },
    '2026-06-14': { a: row(1) }, '2026-06-22': { a: row(1) }, '2026-07-12': { a: row(1) },
  } };
  const f = L.checkGrossesIntegrity(h, [{ slug: 'a' }], { weeks: ['2026-07-12'] });
  assert.ok(!f.some((x) => x.rule === 'zero-perf-gross'), 'old row out of scope');
  assert.ok(f.some((x) => x.rule === 'week-key-not-sunday'));
  assert.ok(f.some((x) => x.rule === 'week-missing' && x.week === '2026-07-05'));
});

test('runner: report-tier rules never alert; args parse', () => {
  for (const r of ['capacity-capped', 'flat-gross-run', 'seats-offered-missing']) assert.equal(ALERT_RULES.has(r), false);
  for (const r of ['total-mismatch', 'show-dropout', 'duplicate-gross', 'week-overdue']) assert.equal(ALERT_RULES.has(r), true);
  assert.deepEqual(parseArgs(['--weeks=3', '--alert', '--rule=show-dropout']), { weeks: 3, all: false, json: false, alert: true, strict: false, rule: 'show-dropout' });
});

test('missing weeks: a Monday key holds its Sunday, so one bad key is not also a missing week', () => {
  const h = { weeks: { '2026-06-14': {}, '2026-06-22': {}, '2026-06-28': {} } };
  assert.deepEqual(L.checkMissingWeeks(h, { since: '2026-01-01' }), []);
});

test('week overdue: a scrape that stored nothing is caught once the grace day passes', () => {
  const h = { weeks: { '2026-09-27': { a: row(1) } } };
  // Tue 2026-10-06 15:00 UTC: week 10-04 is out but within the grace day.
  assert.deepEqual(L.checkWeekOverdue(h, new Date('2026-10-06T15:00:00Z')), []);
  // Wed retry still without it: flagged.
  const f = L.checkWeekOverdue(h, new Date('2026-10-07T15:00:00Z'));
  assert.deepEqual(f.map((x) => `${x.rule}:${x.week}`), ['week-overdue:2026-10-04']);
  h.weeks['2026-10-04'] = { a: row(1) };
  assert.deepEqual(L.checkWeekOverdue(h, new Date('2026-10-07T15:00:00Z')), []);
});

test('routing: one condition per rule and newest week; a clean week resolves its open condition', async () => {
  const { conditionKeyFor, routeFindings } = require('../../scripts/check-grosses-integrity.js');
  assert.equal(conditionKeyFor('show-dropout', [{ week: '2026-09-27' }, { week: '2026-10-04' }]), 'grosses-integrity:show-dropout:2026-10-04');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-ledger-'));
  process.env.ALERT_LEDGER_PATH = path.join(dir, 'ledger.json');
  process.env.ALERT_DIGEST_QUEUE_PATH = path.join(dir, 'queue.json');
  fs.writeFileSync(process.env.ALERT_LEDGER_PATH, JSON.stringify({ conditions: {
    'grosses-integrity:show-dropout:2026-09-27': { status: 'open' },
    'other:thing': { status: 'open' },
  } }));
  await routeFindings(new Map());
  const after = JSON.parse(fs.readFileSync(process.env.ALERT_LEDGER_PATH, 'utf8')).conditions;
  assert.equal(after['grosses-integrity:show-dropout:2026-09-27'].status, 'resolved');
  assert.equal(after['other:thing'].status, 'open');
});

test('known gaps: COVID shutdown and the two archive holes are never reported missing', () => {
  const h = { weeks: { '2020-03-08': {}, '2021-08-29': {}, '2021-09-12': {} } };
  const f = L.checkMissingWeeks(h);
  assert.deepEqual(f.map((x) => x.week), ['2021-09-05']);
});

test('negative values are alerted; capacity over 100% is not', () => {
  const h = { weeks: { '2026-10-04': { a: row(-5), b: row(1, { capacity: 101.3 }) } } };
  const f = L.checkRowShape(h, ['2026-10-04']);
  assert.deepEqual(f.map((x) => `${x.rule}:${x.slug}`), ['negative-value:a']);
  assert.equal(ALERT_RULES.has('negative-value'), true);
});

test('audit-grosses-data.js uses the shared rules, not its own copies', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/audit-grosses-data.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/grosses-integrity'\)/);
  assert.match(src, /integrity\.checkMissingWeeks\(/);
  assert.doesNotMatch(src, /capacity > 110/);
  // League grosses are Broadway-only: an Off-Broadway or West End show is never "missing".
  assert.doesNotMatch(src, /showsData\.shows\.filter\(s => s\.status/);
});
