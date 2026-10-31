/**
 * Week arithmetic for the Box Office v3 sections (BRO-5007). Calls the real
 * exported functions (CLAUDE.md rule 15): season boundaries, a 53-week
 * season, the year-ago week, the trailing window across a dark week and the
 * COVID gap, and paired-row per-seat maths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  yearAgoWeek,
  pctChange,
  seasonOfWeek,
  seasonFirstWeek,
  weekOfSeason,
  priorSeason,
  isReported,
  isPaired,
  isFullWeek,
  lastReportedWeeks,
  grossPerSeat,
  median,
  quantile,
  type HistoryRow,
} from '../../src/lib/box-office-weeks';
import { getSeason } from '../../src/lib/commercial-metrics';

test('addDays and daysBetween are UTC calendar arithmetic', () => {
  assert.equal(addDays('2026-03-08', 7), '2026-03-15'); // across the US DST change
  assert.equal(addDays('2024-03-03', -7), '2024-02-25'); // leap February
  assert.equal(daysBetween('2025-10-05', '2026-10-04'), 364);
});

test('season boundaries follow the July 1 rule', () => {
  assert.equal(seasonOfWeek('2025-06-29'), '2024-2025');
  assert.equal(seasonOfWeek('2025-07-06'), '2025-2026');
  assert.equal(seasonOfWeek('2026-06-28'), '2025-2026');
  assert.equal(seasonOfWeek('2026-07-05'), '2026-2027');
  assert.equal(seasonFirstWeek('2024-2025'), '2024-07-07');
  assert.equal(seasonFirstWeek('2025-2026'), '2025-07-06');
  assert.equal(seasonFirstWeek('2026-2027'), '2026-07-05');
  assert.equal(priorSeason('2026-2027'), '2025-2026');
  assert.equal(priorSeason('2026-2027', 2), '2024-2025');
});

test('seasonOfWeek agrees with /biz getSeason on every week ending of two years', () => {
  // getSeason reads local time; compare at noon UTC, which is the same calendar
  // day everywhere from UTC-11 to UTC+11 (the test also runs under TZ=Pacific/Kiritimati).
  for (let w = '2024-06-02'; w < '2026-07-12'; w = addDays(w, 7)) {
    const local = new Date(`${w}T12:00:00Z`);
    const sameDay = local.getDate() === Number(w.slice(8, 10));
    if (sameDay) assert.equal(seasonOfWeek(w), getSeason(`${w}T12:00:00Z`), w);
  }
});

test('week of season is 1-based and reaches 53 when July 1 is a Sunday', () => {
  assert.equal(weekOfSeason('2026-07-05'), 1);
  assert.equal(weekOfSeason('2026-10-04'), 14); // the mock's "Season so far (14 weeks)"
  assert.equal(weekOfSeason('2026-06-28'), 52);
  assert.equal(seasonFirstWeek('2018-2019'), '2018-07-01');
  assert.equal(weekOfSeason('2019-06-30'), 53);
  assert.equal(weekOfSeason('2019-07-07'), 1);
});

test('yearAgoWeek prefers exactly 364 days, then the nearest within 7', () => {
  const stored = new Set(['2025-10-05', '2025-10-12', '2025-09-28']);
  const has = (w: string) => stored.has(w);
  assert.equal(yearAgoWeek(has, '2026-10-04'), '2025-10-05');
  stored.delete('2025-10-05');
  // 2025-09-28 and 2025-10-12 are both 7 days off; the earlier one wins ties.
  assert.equal(yearAgoWeek(has, '2026-10-04'), '2025-09-28');
  stored.delete('2025-09-28');
  assert.equal(yearAgoWeek(has, '2026-10-04'), '2025-10-12');
  stored.delete('2025-10-12');
  assert.equal(yearAgoWeek(has, '2026-10-04'), null);
  // A Monday-keyed stray a day off still counts.
  assert.equal(yearAgoWeek((w) => w === '2025-10-06', '2026-10-04'), '2025-10-06');
  // Never further than the tolerance.
  assert.equal(yearAgoWeek((w) => w === '2025-10-13', '2026-10-04'), null);
});

test('pctChange refuses a base under $10K and missing sides', () => {
  assert.equal(pctChange(1_200_000, 1_000_000), 20);
  assert.equal(pctChange(500_000, 9_999), null);
  assert.equal(pctChange(500_000, null), null);
  assert.equal(pctChange(undefined, 1_000_000), null);
  assert.equal(pctChange(500_000, Number.NaN), null);
  assert.equal(pctChange(0, 1_000_000), -100);
});

test('reported and paired rows', () => {
  assert.equal(isReported({ gross: 1_000_000, performances: 8 }), true);
  assert.equal(isReported({ gross: 0, performances: 8 }), false);
  assert.equal(isReported({ gross: null }), false);
  // BRO-5057: a gross with 0 performances is a preview week whose count the backfill lost, not a dark week
  assert.equal(isReported({ gross: 1_302_511, capacity: 100.47, performances: 0 }), true);
  assert.equal(isReported({ gross: 0, performances: 0 }), false); // dark
  assert.equal(isReported(null), false);
  assert.equal(isPaired({ gross: 1_000_000, seatsOffered: 8_000 }), true);
  assert.equal(isPaired({ gross: 1_000_000 }), false);
  assert.equal(isPaired({ gross: 1_000_000, seatsOffered: 0 }), false);
});

test('lastReportedWeeks skips a dark week and stops at the lookback cap', () => {
  const rows: Record<string, HistoryRow> = {
    '2026-10-04': { gross: 900_000, performances: 8 },
    '2026-09-27': { gross: 0, performances: 0 }, // dark
    '2026-09-20': { gross: 800_000, performances: 8 },
    '2026-09-13': { gross: 700_000, performances: 8 },
    '2026-09-06': { gross: 600_000, performances: 8 },
    '2026-08-30': { gross: 500_000, performances: 8 },
  };
  const got = lastReportedWeeks((w) => rows[w], '2026-10-04');
  assert.deepEqual(got.map((r) => r.week), ['2026-10-04', '2026-09-20', '2026-09-13', '2026-09-06']);

  // Across the COVID shutdown the window must not join 2020 to 2021.
  const covid: Record<string, HistoryRow> = {
    '2021-09-26': { gross: 400_000, performances: 4 },
    '2020-03-08': { gross: 1_500_000, performances: 8 },
    '2020-03-01': { gross: 1_400_000, performances: 8 },
  };
  const reopened = lastReportedWeeks((w) => covid[w], '2021-10-03');
  assert.deepEqual(reopened.map((r) => r.week), ['2021-09-26']);
});

test('grossPerSeat uses paired rows only (no seats, no gross in the sum)', () => {
  // Shaped like Paranormal Activity's first weeks: a gross before seatsOffered was published.
  const rows: HistoryRow[] = [
    { gross: 400_000, performances: 8 },
    { gross: 600_000, seatsOffered: 6_000, performances: 8 },
    { gross: 900_000, seatsOffered: 9_000, performances: 8 },
    { gross: 0, seatsOffered: 9_000, performances: 0 },
  ];
  assert.equal(grossPerSeat(rows), 100);
  assert.equal(grossPerSeat([{ gross: 400_000 }]), null);
  assert.equal(grossPerSeat([]), null);
});

test('median and quantile', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([], 0.25), null);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
  assert.equal(quantile([10, 20, 30, 40], 0.5), 25);
  assert.equal(quantile([7], 0.9), 7);
});

test('BRO-5057: a 0-performance week with a gross is reported but never a full week', () => {
  const preview = { gross: 1_302_511, capacity: 100.47, seatsOffered: 9_250, performances: 0 };
  assert.equal(isReported(preview), true);
  assert.equal(isPaired(preview), true);
  assert.equal(isFullWeek(preview), false, 'unknown count: never a year-ago base');
  // real rows of this shape carry no seatsOffered, so they stay out of per-seat maths
  assert.equal(isPaired({ gross: 1_302_511, capacity: 100.47, attendance: 9_290, performances: 0 }), false);
  assert.equal(isFullWeek({ gross: 1_000_000, performances: 8 }), true);
  assert.equal(isFullWeek({ gross: 1_000_000 }), true, 'no count listed at all reads as full');
  const rows: Record<string, HistoryRow> = {
    '2015-08-02': { gross: 1_400_000, performances: 0 },
    '2015-07-26': { gross: 1_300_000, performances: 0 },
    '2015-07-19': { gross: 0, performances: 0 },
  };
  assert.deepEqual(lastReportedWeeks((w) => rows[w], '2015-08-02').map((r) => r.week), ['2015-08-02', '2015-07-26']);
});
