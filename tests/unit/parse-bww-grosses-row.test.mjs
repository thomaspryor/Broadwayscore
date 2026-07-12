// Unit tests for scripts/lib/parse-bww-grosses-row.js.
//
// Row shapes below are captured verbatim from https://www.broadwayworld.com/grosses.php
// on 2026-07-12 (week ending 07/06/2026). The critical assertion is that the
// second token of column [5] ("ATTEND. / CAPACITY") is the offered seats FOR
// THAT WEEK — varying by production configuration — not a fixed venue max, and
// that `attendance ÷ seatsOffered × 100` reproduces the published CAP % exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseBwwGrossesRow } = require('../../scripts/lib/parse-bww-grosses-row.js');

// Stub splitShowTheater — the pure lib takes it as a dependency so tests don't
// have to pull in the full BWW_THEATERS map.
const splitShowTheater = (raw) => {
  // "HAMILTONRICHARD RODGERS" → { show: "HAMILTON", theater: "RICHARD RODGERS" }
  // The stub for tests is dead-simple: split at the last uppercase-space run.
  const m = raw.match(/^(.+?)([A-Z][A-Z ,'.-]+)$/);
  if (!m) return { show: raw, theater: '' };
  return { show: m[1].trim(), theater: m[2].trim() };
};

// Sample rows: cells captured verbatim from BWW 2026-07-06 week.
// Layout: [0]=show/theater, [1..2]=gross, [3]=diff, [4]="ATP TopTicket",
// [5]="Attend Capacity", [6]=perfs, [7..8]=cap%, [9]=diff.
const HAMILTON = [
  'HAMILTONRICHARD RODGERS',
  '$2,110,261', '$2,015,244', '$95,017',
  '$198.25 $749.00',
  '10,644 10,592',
  '8',
  '100.49%', '95.35%', '5.14%',
];

const JUST_IN_TIME = [
  'JUST IN TIMECIRCLE IN THE SQUARE',
  '$1,371,542', '$1,510,830', '-$139,288',
  '$327.34 $499.00',
  '4,190 4,830',
  '7',
  '86.75%', '99.99%', '-13.24%',
];

const WICKED = [
  'WICKEDGERSHWIN',
  '$1,822,458', '$1,798,224', '$24,234',
  '$146.00 $299.00',
  '12,483 14,456',
  '8',
  '86.35%', '85.19%', '1.16%',
];

test('captures seatsOffered from BWW [5] second token', () => {
  const hamilton = parseBwwGrossesRow(HAMILTON, splitShowTheater);
  assert.equal(hamilton.attendance, 10644);
  assert.equal(hamilton.seatsOffered, 10592);

  const jit = parseBwwGrossesRow(JUST_IN_TIME, splitShowTheater);
  assert.equal(jit.attendance, 4190);
  assert.equal(jit.seatsOffered, 4830);
});

test('seatsOffered varies with production configuration (balcony-close case)', () => {
  // Circle in the Square is a reconfigurable arena; Just In Time offers
  // 4830/7 ≈ 690 seats/perf, well below the room's nominal capacity. The
  // whole point of storing this field is to catch exactly this case.
  const jit = parseBwwGrossesRow(JUST_IN_TIME, splitShowTheater);
  const perPerf = jit.seatsOffered / jit.performances;
  assert.ok(perPerf < 700, `expected < 700 seats/perf offered, got ${perPerf}`);
});

test('attendance ÷ seatsOffered × 100 reproduces published CAP %', () => {
  const rows = [
    [HAMILTON, 100.49],
    [JUST_IN_TIME, 86.75],
    [WICKED, 86.35],
  ];
  for (const [cells, publishedCap] of rows) {
    const row = parseBwwGrossesRow(cells, splitShowTheater);
    const computed = (row.attendance / row.seatsOffered) * 100;
    assert.ok(
      Math.abs(computed - publishedCap) < 0.05,
      `${row.show}: computed ${computed.toFixed(2)}% vs published ${publishedCap}%`,
    );
  }
});

test('RevPAS derives cleanly as gross ÷ seatsOffered', () => {
  const hamilton = parseBwwGrossesRow(HAMILTON, splitShowTheater);
  const revpas = hamilton.gross / hamilton.seatsOffered;
  // $2,110,261 ÷ 10,592 ≈ $199.23
  assert.ok(revpas > 195 && revpas < 205, `expected ~$199 RevPAS, got $${revpas.toFixed(2)}`);

  const jit = parseBwwGrossesRow(JUST_IN_TIME, splitShowTheater);
  const jitRevpas = jit.gross / jit.seatsOffered;
  // $1,371,542 ÷ 4,830 ≈ $283.96 — well above Hamilton because supply is constrained
  assert.ok(jitRevpas > 280 && jitRevpas < 290,
    `expected ~$284 RevPAS for Just In Time, got $${jitRevpas.toFixed(2)}`);
  // The BALCONY-CLOSE assertion: RevPAS via BWW's per-week seatsOffered gives
  // a higher, more accurate number than what a static-venue-map (chromolume's
  // approach) would produce. Circle in the Square nominal capacity per perf is
  // roughly 800 seats; a static map would use 800×7 = 5600, giving RevPAS ≈ $245.
  const staticRevpas = jit.gross / (800 * jit.performances);
  assert.ok(jitRevpas > staticRevpas,
    `per-week seatsOffered ($${jitRevpas.toFixed(2)}) should exceed static-map ($${staticRevpas.toFixed(2)})`);
});

test('returns null for rows with < 10 cells (safety)', () => {
  const short = ['HAMILTON', '$1M'];
  assert.equal(parseBwwGrossesRow(short, splitShowTheater), null);
});

test('handles dark-week / single-token attendance cell (BWW publishes "-" or blanks)', () => {
  // BWW occasionally reports a dark week with "-" placeholders. The parser must
  // return non-null so downstream sees the row (some fields will just be null),
  // OR return null cleanly — never a partially-parsed row with NaN.
  const darkWeek = [
    'HAMILTONRICHARD RODGERS',
    '$0', '$2,015,244', '-$2,015,244',
    '-',                // attendance/capacity cell — placeholder
    '-',                // ATP cell — placeholder
    '0',                // perfs = 0 (dark)
    '-', '95.35%', '-',
  ];
  const row = parseBwwGrossesRow(darkWeek, splitShowTheater);
  // Either null (structural drop) or a row with attendance/seatsOffered = null.
  if (row !== null) {
    // Attendance and seatsOffered must be nullable — never NaN.
    assert.ok(row.attendance === null || Number.isFinite(row.attendance),
      `attendance must be null or finite, got ${row.attendance}`);
    assert.ok(row.seatsOffered === null || Number.isFinite(row.seatsOffered),
      `seatsOffered must be null or finite, got ${row.seatsOffered}`);
  }

  // Single-token attendance cell — no capacity second token
  const singleToken = [
    'HAMILTONRICHARD RODGERS',
    '$1,000,000', '$2,015,244', '-$1,015,244',
    '$150.00 $300.00',
    '5000',             // attendance only, no seats-offered second token
    '4',
    '75%', '95.35%', '-20.35%',
  ];
  const singleRow = parseBwwGrossesRow(singleToken, splitShowTheater);
  assert.equal(singleRow?.attendance, 5000);
  assert.equal(singleRow?.seatsOffered, null,
    'seatsOffered must be null when BWW omits the second token');
});

test('sanity guard drops rows with implausible parses', () => {
  // Column-shift scenario: ATP field lands in the perfs column etc.
  const shifted = [
    'HAMILTONRICHARD RODGERS',
    '$2,110,261', '$2,015,244', '$95,017',
    '8 $749.00',        // ATP would parse as "8" — off-scale-low
    '10,644 10,592',
    '100',              // perfs would parse as 100 — off-scale-high
    '0.25%', '95.35%', '5.14%',
  ];
  assert.equal(parseBwwGrossesRow(shifted, splitShowTheater), null);
});
