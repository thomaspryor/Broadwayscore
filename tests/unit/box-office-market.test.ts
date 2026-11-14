/**
 * Market numbers for the Box Office v3 page (BRO-5007). Calls the real
 * exported functions (CLAUDE.md rule 15) on small fixtures: market totals
 * from every history row, the half-count guard on comparisons, movers that
 * skip a first week and a tiny base, per-seat ranks with "too new", sell-out
 * streaks across a dark week, premium pull, each run's personal bests and
 * the new-musical cohort's revival and n floors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marketWeek,
  marketSummary,
  seasonGrossThrough,
  seasonSeries,
  seriesRange,
  movers,
  MOVER_MIN_PCT,
  isScheduleMove,
  perSeatTable,
  sellOutStreak,
  premiumPull,
  weekEndingOnOrAfter,
  weekOfRun,
  isComparableRun,
  personalBests,
  ownRunWeeks,
  weeklyRecords,
  RECORD_MIN_PRIOR_WEEKS,
  BESTS_MIN_WEEKS,
  newMusicalCohort,
  COHORT_MIN_N,
  type MarketInput,
  type MarketShow,
} from '../../src/lib/box-office-market';
import { addDays, isFullWeek, type HistoryRow, type HistoryWeeks } from '../../src/lib/box-office-weeks';

const row = (gross: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({ gross, performances: 8, seatsOffered: 8_000, capacity: 90, atp: 100, ...extra });
const show = (slug: string, extra: Partial<MarketShow> = {}): MarketShow => ({ slug, title: slug, category: 'broadway', type: 'musical', ...extra });
const input = (weeks: HistoryWeeks, shows: MarketShow[] = []): MarketInput => ({ weeks, shows: new Map(shows.map((s) => [s.slug, s])) });

test('marketWeek counts every reported Broadway row, not just shows with records', () => {
  const m = marketWeek(input({
    '2026-10-04': { a: row(2_000_000), b: row(1_000_000), dark: row(0, { performances: 0 }), unknown: row(500_000), we: row(900_000) },
  }, [show('a'), show('b'), show('dark'), show('we', { category: 'west-end' })]), '2026-10-04')!;
  assert.equal(m.shows, 3);
  assert.equal(m.gross, 3_500_000);
  assert.deepEqual(m.ranked.map((r) => r.slug), ['a', 'b', 'unknown']);
  assert.equal(marketWeek(input({}), '2026-10-04'), null);
});

test('marketSummary drops a year-ago week with under half the shows, and computes top-four share', () => {
  const now: Record<string, HistoryRow> = {};
  for (let i = 0; i < 10; i++) now[`s${i}`] = row(1_000_000 + i * 100_000);
  const weeks: HistoryWeeks = {
    '2026-10-04': now,
    '2026-09-27': { s0: row(900_000), s1: row(900_000), s2: row(900_000), s3: row(900_000), s4: row(900_000) },
    '2025-10-05': { s0: row(1_000_000), s1: row(1_000_000), s2: row(1_000_000), s3: row(1_000_000) }, // 4 of 10: partial
  };
  const s = marketSummary(input(weeks), '2026-10-04')!;
  assert.equal(s.gross, 14_500_000);
  assert.equal(s.lastWeekGross, 4_500_000);
  assert.equal(s.lastYearWeek, null);
  assert.equal(s.lastYearPct, null);
  assert.equal(Math.round(s.topFourShare * 1000), Math.round((1.9 + 1.8 + 1.7 + 1.6) / 14.5 * 1000));
});

test('season to date sums week-of-season 1..n and refuses an incomplete earlier season', () => {
  const weeks: HistoryWeeks = {};
  for (let i = 0; i < 3; i++) {
    weeks[addDays('2026-07-05', 7 * i)] = { a: row(1_000_000) };
    weeks[addDays('2025-07-06', 7 * i)] = { a: row(2_000_000) };
  }
  weeks['2024-07-07'] = { a: row(1) }; // 2024-25 has only its first week
  const inp = input(weeks);
  assert.equal(seasonGrossThrough(inp, '2026-2027', 3), 3_000_000);
  assert.equal(seasonGrossThrough(inp, '2025-2026', 3), 6_000_000);
  assert.equal(seasonGrossThrough(inp, '2024-2025', 3), null);
  const s = marketSummary(inp, '2026-07-19')!;
  assert.equal(s.season.weeks, 3);
  assert.deepEqual(s.season.prior, [{ season: '2025-2026', gross: 6_000_000 }, { season: '2024-2025', gross: null }]);
});

test('seasonSeries indexes by week of season and stops at the latest week', () => {
  const weeks: HistoryWeeks = { '2026-07-05': { a: row(1_000_000) }, '2026-07-19': { a: row(3_000_000) } };
  const s = seasonSeries(input(weeks), '2026-2027', '2026-07-19');
  assert.deepEqual(s.gross, [1_000_000, null, 3_000_000]);
  assert.equal(seasonSeries(input({}), '2025-2026').gross.length, 52);
  assert.equal(seasonSeries(input({}), '2018-2019').gross.length, 53);
  assert.deepEqual(seriesRange([{ season: 'x', gross: [1, null] }, { season: 'y', gross: [3, null, 5] }]),
    [{ min: 1, max: 3 }, null, { min: 5, max: 5 }]);
});

test('movers skip a first week, a base under $10K and schedule-only moves, and report per-show change when counts differ', () => {
  const weeks: HistoryWeeks = {
    '2026-09-27': {
      previews: row(700_000, { performances: 7 }), partial: row(300_000, { performances: 3 }), holiday: row(800_000, { performances: 8 }),
      down: row(1_000_000), tiny: row(5_000),
    },
    '2026-10-04': {
      // 7 -> 8 performances: gross up 7%, per show down 6%, so not a gain.
      previews: row(750_000, { performances: 8 }),
      // A 3-performance base week is partial.
      partial: row(900_000, { performances: 8 }),
      // 8 -> 9 performances with per-show takings up too: a real gain.
      holiday: row(1_080_000, { performances: 9 }),
      down: row(800_000), tiny: row(300_000), fresh: row(2_000_000),
    },
  };
  const { gains, drops } = movers(input(weeks), '2026-10-04');
  assert.deepEqual(gains.map((m) => [m.slug, m.pct, m.perShowPct]), [['holiday', 35, 20]]);
  assert.deepEqual(drops.map((m) => [m.slug, m.pct, m.perShowPct]), [['down', -20, null]]);
});

test('movers leave out moves under MOVER_MIN_PCT either way, so the list runs short instead of showing ▼0%', () => {
  const weeks: HistoryWeeks = {
    '2026-09-27': { flat: row(1_000_000), nudge: row(1_000_000), real: row(1_000_000), up: row(1_000_000) },
    '2026-10-04': { flat: row(996_000), nudge: row(985_000), real: row(970_000), up: row(1_015_000) },
  };
  const { gains, drops } = movers(input(weeks), '2026-10-04');
  assert.deepEqual(drops.map((m) => m.slug), ['real']);
  assert.deepEqual(gains, []);
  assert.equal(MOVER_MIN_PCT, 2);
});

test('isScheduleMove and isFullWeek', () => {
  assert.equal(isScheduleMove(93, 3, -17), false);
  assert.equal(isScheduleMove(75, 7, -12.5), false);
  assert.equal(isScheduleMove(12, 8, 1), true);
  assert.equal(isScheduleMove(-20, 8, null), true);
  assert.equal(isFullWeek(row(500_000, { performances: 3 })), false);
  assert.equal(isFullWeek(row(500_000, { performances: 6 })), true);
  assert.equal(isFullWeek(row(500_000, { performances: undefined })), true);
  assert.equal(isFullWeek(undefined), false);
});

test('season to date is null when a week of this season is missing, and a 53rd week never borrows the next season', () => {
  const weeks: HistoryWeeks = { '2026-07-05': { a: row(1_000_000) }, '2026-07-19': { a: row(1_000_000) } };
  assert.equal(marketSummary(input(weeks), '2026-07-19')!.season.gross, null);
  const full: HistoryWeeks = {};
  for (let w = '2017-07-02'; w <= '2019-07-07'; w = addDays(w, 7)) full[w] = { a: row(1_000_000) };
  const inp = input(full);
  assert.equal(seasonGrossThrough(inp, '2018-2019', 53), 53_000_000);
  // 2017-18 has 52 weeks; its "53rd" would be 2018-19's first week.
  assert.equal(seasonGrossThrough(inp, '2017-2018', 53), null);
  assert.equal(seasonGrossThrough(inp, '2017-2018', 52), 52_000_000);
});

test('perSeatTable ranks shows with 4 reported weeks and sets newer ones aside', () => {
  const weeks: HistoryWeeks = {};
  for (let i = 0; i < 4; i++) {
    const w = addDays('2026-10-04', -7 * i);
    weeks[w] = { big: row(2_000_000, { seatsOffered: 16_000 }), small: row(1_000_000, { seatsOffered: 6_000 }) };
  }
  weeks['2026-10-04'].fresh = row(1_500_000, { seatsOffered: 5_000 });
  weeks['2026-10-04'].noSeats = row(900_000, { seatsOffered: null });
  const t = perSeatTable(input(weeks), '2026-10-04');
  assert.equal(t.reporting, 4);
  assert.deepEqual(t.ranked.map((r) => [r.slug, Math.round(r.perSeat), r.grossRank, r.seats]), [['small', 167, 3, 750], ['big', 125, 1, 2000]]);
  assert.deepEqual(t.tooNew.map((r) => [r.slug, r.perSeat, r.weeksUsed]), [['fresh', 300, 1]]);
});

test('sellOutStreak counts weeks at 95% or more, passing a dark week but not a long gap', () => {
  const rows: Record<string, HistoryRow> = {
    '2026-10-04': row(1, { capacity: 101 }),
    '2026-09-27': row(0, { performances: 0 }), // dark
    '2026-09-20': row(1, { capacity: 95 }),
    '2026-09-13': row(1, { capacity: 94.9 }),
  };
  assert.equal(sellOutStreak((w) => rows[w], '2026-10-04'), 2);
  assert.equal(sellOutStreak((w) => rows[w], '2026-09-13'), 0);
  const gap: Record<string, HistoryRow> = { '2021-09-26': row(1, { capacity: 99 }), '2020-03-08': row(1, { capacity: 99 }) };
  assert.equal(sellOutStreak((w) => gap[w], '2021-09-26'), 1);
});

test('premiumPull measures from this week\'s median average ticket and marks new shows', () => {
  const weeks: HistoryWeeks = { '2026-10-04': { a: row(1, { atp: 200 }), b: row(1, { atp: 100 }), c: row(1, { atp: 90 }), d: row(1, { atp: null }) } };
  for (let i = 1; i < 4; i++) weeks[addDays('2026-10-04', -7 * i)] = { a: row(1) };
  const p = premiumPull(input(weeks), '2026-10-04');
  assert.equal(p.median, 100);
  assert.deepEqual(p.above, [{ slug: 'a', atp: 200, over: 100, isNew: false }]);
});

test('weeks of a run count from the week of first preview', () => {
  assert.equal(weekEndingOnOrAfter('2026-10-04'), '2026-10-04');
  assert.equal(weekEndingOnOrAfter('2026-09-29'), '2026-10-04');
  assert.equal(weekOfRun('2026-09-29', '2026-10-04'), 1);
  assert.equal(weekOfRun('2026-09-29', '2026-10-25'), 4);
  assert.equal(isComparableRun(show('x', { previewsStartDate: '2001-12-10' })), false);
  assert.equal(isComparableRun(show('x', { previewsStartDate: null })), false);
  assert.equal(isComparableRun(show('x', { previewsStartDate: '2010-01-01', type: 'special' })), false);
  assert.equal(isComparableRun(show('x', { previewsStartDate: '2010-01-01', type: 'play' })), true);
});

/** `count` runs each with a flat gross per seat, previews starting `start`, plus the market rows. */
function runs(prefix: string, count: number, start: string, perSeat: (i: number) => number, weeks: HistoryWeeks, len = 10, extra: Partial<MarketShow> = {}) {
  const out: MarketShow[] = [];
  for (let i = 0; i < count; i++) {
    const s = show(`${prefix}${i}`, { previewsStartDate: start, ...extra });
    out.push(s);
    for (let k = 0; k < len; k++) {
      const w = addDays(weekEndingOnOrAfter(start), 7 * k);
      (weeks[w] ??= {})[s.slug] = row(perSeat(i) * 8_000);
    }
  }
  return out;
}

test('personalBests: records with their weeks, the latest week beside them, nulls skipped', () => {
  const w = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'];
  const weeks: HistoryWeeks = {
    [w[0]]: { s: row(900_000, { capacity: 70, atp: 90, performances: 0 }) }, // a preview week listed with 0 performances still counts
    [w[1]]: { s: row(1_400_000, { capacity: null, atp: null, attendance: null }) }, // no capacity or attendance
    [w[2]]: { s: row(1_200_000, { capacity: 97, atp: 120 }) },
    [w[3]]: { s: row(1_400_000, { capacity: 95, atp: 130 }) }, // ties the best gross later: the earlier week keeps it
    [w[4]]: { s: row(1_100_000, { capacity: 92, atp: 135 }) },
  };
  const b = personalBests(input(weeks, [show('s', { previewsStartDate: '2026-09-01' })]), 's', w[4])!;
  assert.equal(b.weeks, 5);
  assert.equal(b.latestWeek, w[4]);
  const by = Object.fromEntries(b.rows.map((r) => [r.key, r]));
  assert.deepEqual([by.gross.value, by.gross.week, by.gross.latest, by.gross.latestIsRecord], [1_400_000, w[1], 1_100_000, false]);
  assert.deepEqual([by.capacity.value, by.capacity.week, by.capacity.latest], [97, w[2], 92], 'a null capacity is skipped, never read as 0');
  assert.deepEqual([by.atp.value, by.atp.week, by.atp.latestIsRecord], [135, w[4], true], 'the latest week can be the record');
});

test('personalBests: hidden under the minimum weeks, and a revival never inherits the original run', () => {
  const few: HistoryWeeks = {};
  for (let i = 0; i < BESTS_MIN_WEEKS - 1; i++) few[addDays('2026-09-06', 7 * i)] = { s: row(1_000_000) };
  assert.equal(personalBests(input(few, [show('s')]), 's', '2026-10-04'), null);

  // Rows filed under the revival's slug before its first preview belong to the old run.
  const weeks: HistoryWeeks = { '2019-01-06': { r: row(3_000_000, { capacity: 102, atp: 300 }) } };
  for (let i = 0; i < 4; i++) weeks[addDays('2026-09-13', 7 * i)] = { r: row(1_000_000 + i, { capacity: 80 + i, atp: 100 + i }) };
  const b = personalBests(input(weeks, [show('r', { previewsStartDate: '2026-09-10', isRevival: true })]), 'r', '2026-10-04')!;
  assert.equal(b.weeks, 4);
  for (const r of b.rows) assert.ok(r.week >= '2026-09-13', `${r.key} record from ${r.week}`);
  // No first-preview date: the run starts a few weeks before opening night, not at the slug's oldest row.
  const noPreview = personalBests(input(weeks, [show('r', { openingDate: '2026-10-01' })]), 'r', '2026-10-04')!;
  for (const r of noPreview.rows) assert.ok(r.week >= '2026-09-13', `${r.key} record from ${r.week}`);
  // A long silence ends the engagement: weeks before it never set this run's records.
  const gap: HistoryWeeks = {};
  for (let i = 0; i < 4; i++) gap[addDays('2019-12-08', 7 * i)] = { m: row(2_000_000) };
  for (let i = 0; i < 4; i++) gap[addDays('2025-11-02', 7 * i)] = { m: row(300_000 + i) };
  const g = personalBests(input(gap, [show('m', { previewsStartDate: '1974-05-01' })]), 'm', '2025-11-23')!;
  assert.equal(g.weeks, 4);
  assert.equal(g.rows.find((r) => r.key === 'gross')!.week, '2025-11-23');
  // The COVID shutdown is not a gap: a run that reopened keeps its pre-2020 records.
  const covid: HistoryWeeks = {};
  for (let i = 0; i < 3; i++) covid[addDays('2020-02-16', 7 * i)] = { h: row(3_000_000) };
  for (let i = 0; i < 3; i++) covid[addDays('2021-09-19', 7 * i)] = { h: row(1_000_000) };
  const c = personalBests(input(covid, [show('h', { previewsStartDate: '2015-07-13' })]), 'h', '2021-10-03')!;
  assert.equal(c.weeks, 6);
  assert.equal(c.rows.find((r) => r.key === 'gross')!.week, '2020-02-16');
  // Weeks after the show's latest week are ignored too.
  assert.equal(personalBests(input(weeks, [show('r', { previewsStartDate: '2026-09-10' })]), 'r', '2026-09-27'), null);
});

test('newMusicalCohort leaves out revivals and draws the band only at n >= 15', () => {
  const weeks: HistoryWeeks = {};
  const fresh = runs('m', COHORT_MIN_N, '2020-01-06', (i) => 80 + i, weeks, 3);
  const revivals = runs('r', 5, '2020-01-06', () => 1000, weeks, 3, { isRevival: true });
  const plays = runs('p', 5, '2020-01-06', () => 1000, weeks, 3, { type: 'play' });
  const c = newMusicalCohort(input(weeks, [...fresh, ...revivals, ...plays]), '2026-10-04', 4);
  assert.equal(c.fromYear, 2016);
  assert.equal(c.musicals, COHORT_MIN_N);
  assert.deepEqual(c.band[0], { p25: 83.5, median: 87, p75: 90.5, n: COHORT_MIN_N });
  assert.equal(c.band[3], null); // only 3 weeks of data
  const short = newMusicalCohort(input(weeks, fresh.slice(1)), '2026-10-04', 1);
  assert.equal(short.band[0], null);
});

test('weeklyRecords: run-long records first, then the furthest-reaching "since"; ties, short runs and old runs never count', () => {
  const latest = '2026-10-04';
  const weeks: HistoryWeeks = {};
  const put = (slug: string, grosses: number[]) => grosses.forEach((g, i) => {
    const w = addDays(latest, -7 * (grosses.length - 1 - i));
    (weeks[w] ??= {})[slug] = row(g);
  });
  const flat = (n: number, g: number) => Array.from({ length: n }, () => g);
  put('ever', [...flat(12, 1_000_000), 1_500_000]); // beats all 12 earlier weeks
  put('since', [2_000_000, ...flat(10, 1_000_000), 1_500_000]); // a higher week 11 back
  put('recent', [2_000_000, ...flat(RECORD_MIN_PRIOR_WEEKS, 1_000_000), 1_500_000]); // exactly 8 topped
  put('tooSoon', [2_000_000, ...flat(RECORD_MIN_PRIOR_WEEKS - 1, 1_000_000), 1_500_000]); // only 7 topped
  put('tie', [...flat(12, 1_500_000), 1_500_000]); // equal to every earlier week: not a record
  put('short', [...flat(RECORD_MIN_PRIOR_WEEKS - 1, 1_000_000), 1_500_000]); // fewer than 8 earlier weeks
  // A revival whose slug still carries the original run's bigger weeks from years ago.
  weeks['2018-12-30'] = { ...(weeks['2018-12-30'] ?? {}), revival: row(3_000_000) };
  put('revival', [...flat(9, 1_000_000), 1_200_000]);
  const shows = ['ever', 'since', 'recent', 'tooSoon', 'tie', 'short', 'revival'].map((s) => show(s, s === 'revival' ? { isRevival: true } : {}));
  const got = weeklyRecords(input(weeks, shows), latest);
  assert.deepEqual(got.map((r) => [r.slug, r.ever, r.topped]), [
    ['ever', true, 12],
    ['revival', true, 9],
    ['since', false, 10],
    ['recent', false, RECORD_MIN_PRIOR_WEEKS],
  ]);
  assert.equal(got.find((r) => r.slug === 'since')!.since, addDays(latest, -7 * 11));
});

test('BRO-5057: season totals and market weeks count a preview week listed with 0 performances', () => {
  // days-of-wine-and-roses 2024-01-07..01-21 shape: previews with a gross, 0 performances
  const weeks: HistoryWeeks = {
    '2024-01-07': { a: row(1_000_000), dowar: row(400_000, { performances: 0 }) },
    '2024-01-14': { a: row(1_000_000), dowar: row(450_000, { performances: 0 }), shut: row(0, { performances: 0 }) },
  };
  const inp = input(weeks, [show('a'), show('dowar'), show('shut')]);
  const m = marketWeek(inp, '2024-01-14')!;
  assert.equal(m.shows, 2, 'the 0-gross row stays dark');
  assert.equal(m.gross, 1_450_000);
  // a 0-performance week is never a mover base (partial), so no "gain" from added previews
  const { gains, drops } = movers(input({
    '2024-01-14': { dowar: row(400_000, { performances: 0 }) },
    '2024-01-21': { dowar: row(900_000) },
  }, [show('dowar')]), '2024-01-21');
  assert.equal(gains.length + drops.length, 0);
  // this week listing 0 after a full week: still a mover, but the count is unknown, never "0 shows"
  const after = movers(input({
    '2019-07-21': { s: row(1_000_000) },
    '2019-07-28': { s: row(170_000, { performances: 0 }) },
  }, [show('s')]), '2019-07-28');
  assert.equal(after.drops.length, 1);
  assert.equal(after.drops[0].performances, null);
  assert.equal(after.drops[0].prevPerformances, 8);
  // ownRunWeeks uses the same rule: the preview weeks are weeks of the run, the dark one is not
  const run = input({
    '2024-01-07': { d: row(400_000, { performances: 0 }) },
    '2024-01-14': { d: row(0, { performances: 0 }) },
    '2024-01-21': { d: row(500_000) },
  }, [show('d', { previewsStartDate: '2024-01-02' })]);
  assert.deepEqual(ownRunWeeks(run, 'd', '2024-01-21'), ['2024-01-07', '2024-01-21']);
});
