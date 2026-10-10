/**
 * computeDiaryStats — totals, hours in a seat, buckets, streak, drought.
 *
 * Runs the REAL src/lib/stats/diary-stats.ts. The cases that bite here are the
 * ones where a row is present but incomplete: a rating that arrives as the
 * string "4.0", a null rating, a null date_seen, and a show with no runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDiaryStats } from '../../src/lib/stats/diary-stats';
import {
  FALLBACK_RUNTIME_MUSICAL,
  FALLBACK_RUNTIME_PLAY,
  parseRating,
  parseRuntimeMinutes,
  resolveRuntimeMinutes,
} from '../../src/lib/stats/parse';

const META = {
  musical: { type: 'musical', runtime: '2h 30m', venue: 'Booth Theatre', category: 'broadway' },
  play: { type: 'play', runtime: '1h 45m', venue: 'Lyceum Theatre', category: 'broadway' },
  'musical-no-rt': { type: 'musical', venue: 'Booth Theatre', category: 'broadway' },
  'play-no-rt': { type: 'play', venue: 'Palace Theatre', category: 'broadway' },
  'we-show': { type: 'musical', runtime: '2h', venue: 'Palace Theatre', category: 'west-end' },
  'ob-show': { type: 'play', runtime: '90m', venue: 'Public Theater', category: 'off-broadway' },
};
const HOUSES = ['Booth Theatre', 'Lyceum Theatre', 'Palace Theatre'];

const row = (show_id, rating, date_seen) => ({ show_id, rating, date_seen });

test('RATING STRINGS: Supabase numerics arrive as strings and still parse', () => {
  assert.equal(parseRating('4.0'), 4);
  assert.equal(parseRating('3.5'), 3.5);
  assert.equal(parseRating(' 5.0 '), 5);
  assert.equal(parseRating(2.5), 2.5);
  // Off-grid values snap to the nearest half star.
  assert.equal(parseRating('3.7'), 3.5);
  assert.equal(parseRating('4.26'), 4.5);
  // Out of range clamps rather than exploding.
  assert.equal(parseRating('7'), 5);
  assert.equal(parseRating('0.1'), 0.5);
});

test('NULL RATINGS: unusable ratings are null, not 0', () => {
  for (const bad of [null, undefined, '', '   ', 'four stars', NaN, 0, '0', -2]) {
    assert.equal(parseRating(bad), null, JSON.stringify(bad));
  }
});

test('parseRuntimeMinutes handles every shape shows.json emits', () => {
  assert.equal(parseRuntimeMinutes('2h 30m'), 150);
  assert.equal(parseRuntimeMinutes('2h'), 120);
  assert.equal(parseRuntimeMinutes('95m'), 95);
  assert.equal(parseRuntimeMinutes('2 hours 30 minutes'), 150);
  assert.equal(parseRuntimeMinutes('1 hr 45 min'), 105);
  assert.equal(parseRuntimeMinutes('150'), 150);
  assert.equal(parseRuntimeMinutes(150), 150);
  for (const bad of [null, undefined, '', 'TBA', 0, -5]) {
    assert.equal(parseRuntimeMinutes(bad), null, JSON.stringify(bad));
  }
});

test('RUNTIME FALLBACK: 2h30m musical / 2h everything else, flagged as fallback', () => {
  assert.deepEqual(resolveRuntimeMinutes({ type: 'musical', runtime: '1h 20m' }), {
    minutes: 80,
    fallback: false,
  });
  assert.deepEqual(resolveRuntimeMinutes({ type: 'musical' }), {
    minutes: FALLBACK_RUNTIME_MUSICAL,
    fallback: true,
  });
  assert.deepEqual(resolveRuntimeMinutes({ type: 'play' }), {
    minutes: FALLBACK_RUNTIME_PLAY,
    fallback: true,
  });
  // Unknown type is treated as a play, and a missing show entirely still works.
  assert.equal(resolveRuntimeMinutes({ type: 'opera' }).minutes, FALLBACK_RUNTIME_PLAY);
  assert.deepEqual(resolveRuntimeMinutes(undefined), {
    minutes: FALLBACK_RUNTIME_PLAY,
    fallback: true,
  });
  assert.equal(FALLBACK_RUNTIME_MUSICAL, 150);
  assert.equal(FALLBACK_RUNTIME_PLAY, 120);
});

test('FALLBACK SHARE: reported as a share of ALL rows, for the >25% demote rule', () => {
  const rows = [
    row('musical', '4.0', '2026-01-05'),
    row('play', '3.0', '2026-01-06'),
    row('musical-no-rt', '5.0', '2026-01-07'),
    row('play-no-rt', '2.0', '2026-01-08'),
  ];
  const s = computeDiaryStats(rows, META);
  assert.equal(s.runtimeFallbackCount, 2);
  assert.equal(s.runtimeFallbackShare, 0.5);
  assert.equal(s.minutesInSeat, 150 + 105 + 150 + 120);
  assert.equal(s.hoursInSeat, Math.round((525 / 60) * 10) / 10);

  // No fallbacks at all → share 0, and an empty diary must not divide by zero.
  assert.equal(computeDiaryStats([row('musical', '4.0', '2026-01-05')], META).runtimeFallbackShare, 0);
  const empty = computeDiaryStats([], META);
  assert.equal(empty.runtimeFallbackShare, 0);
  assert.equal(empty.total, 0);
  assert.equal(empty.busiestMonth, null);
  assert.equal(empty.currentStreak, 0);
  assert.equal(empty.longestDrought, null);
});

test('null ratings and null dates count toward totals but not toward buckets', () => {
  const rows = [
    row('musical', '4.0', '2026-01-05'),
    row('play', null, '2026-01-06'),
    row('musical', '3.0', null),
  ];
  const s = computeDiaryStats(rows, META);
  assert.equal(s.total, 3);
  assert.equal(s.rated, 2);
  assert.equal(s.unrated, 1);
  assert.equal(s.dated, 2);
  assert.equal(s.undated, 1);
  // The undated row still contributes runtime and its venue.
  assert.equal(s.minutesInSeat, 150 + 105 + 150);
  assert.equal(s.byMonth.reduce((n, b) => n + b.count, 0), 2);
  assert.equal(s.byYear.reduce((n, b) => n + b.count, 0), 2);
  assert.equal(s.firstSeen, '2026-01-05');
  assert.equal(s.lastSeen, '2026-01-06');
});

test('distinct theaters counts venues; Broadway houses are market-gated', () => {
  const rows = [
    row('musical', '4.0', '2026-01-05'), // Booth, broadway
    row('play', '4.0', '2026-01-05'), // Lyceum, broadway
    row('we-show', '4.0', '2026-02-05'), // Palace, WEST END
    row('ob-show', '4.0', '2026-02-06'), // Public Theater, off-broadway
  ];
  const s = computeDiaryStats(rows, META, { houseNames: HOUSES });
  assert.equal(s.distinctTheaters, 4, 'four distinct venue strings');
  assert.equal(
    s.distinctBroadwayHouses,
    2,
    "London's Palace must not count as a Broadway house visit"
  );
});

test('year buckets fill gaps so the bar chart has one bar per year', () => {
  const rows = [row('play', '4.0', '2019-05-01'), row('play', '4.0', '2022-05-01')];
  const s = computeDiaryStats(rows, META);
  assert.deepEqual(s.byYear, [
    { year: 2019, count: 1 },
    { year: 2020, count: 0 },
    { year: 2021, count: 0 },
    { year: 2022, count: 1 },
  ]);
});

test('busiest month is the highest-count month', () => {
  const rows = [
    row('play', '4.0', '2026-01-05'),
    row('play', '4.0', '2026-03-05'),
    row('play', '4.0', '2026-03-15'),
    row('play', '4.0', '2026-03-25'),
  ];
  const s = computeDiaryStats(rows, META);
  assert.deepEqual(s.busiestMonth, { month: '2026-03', count: 3 });
  assert.equal(s.byMonth.length, 3, 'Jan, Feb (empty), Mar');
});

test('current streak counts back from today, with one month of grace', () => {
  const rows = [
    row('play', '4.0', '2026-04-10'),
    row('play', '4.0', '2026-05-10'),
    row('play', '4.0', '2026-06-10'),
  ];
  // Today is in the last month with a show.
  assert.equal(computeDiaryStats(rows, META, { today: '2026-06-20' }).currentStreak, 3);
  // Today is one empty month later — the streak survives.
  assert.equal(computeDiaryStats(rows, META, { today: '2026-07-20' }).currentStreak, 3);
  // Two empty months later it has lapsed.
  assert.equal(computeDiaryStats(rows, META, { today: '2026-08-20' }).currentStreak, 0);
  // A gap inside the run truncates it.
  const gapped = [
    row('play', '4.0', '2026-01-10'),
    row('play', '4.0', '2026-05-10'),
    row('play', '4.0', '2026-06-10'),
  ];
  assert.equal(computeDiaryStats(gapped, META, { today: '2026-06-20' }).currentStreak, 2);
});

test('current streak spans a year boundary', () => {
  const rows = [
    row('play', '4.0', '2025-11-10'),
    row('play', '4.0', '2025-12-10'),
    row('play', '4.0', '2026-01-10'),
  ];
  assert.equal(computeDiaryStats(rows, META, { today: '2026-01-31' }).currentStreak, 3);
});

test('longest drought is the biggest interior gap, not leading or trailing space', () => {
  const rows = [
    row('play', '4.0', '2025-01-10'),
    row('play', '4.0', '2025-03-10'), // 1-month gap (Feb)
    row('play', '4.0', '2025-08-10'), // 4-month gap (Apr–Jul)
    row('play', '4.0', '2025-09-10'),
  ];
  const s = computeDiaryStats(rows, META, { today: '2026-06-01' });
  assert.deepEqual(s.longestDrought, { months: 4, from: '2025-04', to: '2025-07' });
  // Trailing emptiness (Oct 2025 → today) is not a drought.
  assert.ok(s.longestDrought.to < '2025-09');
});

test('a diary with no gaps has no drought', () => {
  const rows = [row('play', '4.0', '2026-01-10'), row('play', '4.0', '2026-02-10')];
  assert.equal(computeDiaryStats(rows, META, { today: '2026-02-20' }).longestDrought, null);
});

test('UNMATCHED VENUES: a show missing from the metadata index degrades gracefully', () => {
  const rows = [row('ghost-show', '4.0', '2026-01-05')];
  const s = computeDiaryStats(rows, {}, { houseNames: HOUSES });
  assert.equal(s.total, 1);
  assert.equal(s.distinctTheaters, 0);
  assert.equal(s.distinctBroadwayHouses, 0);
  assert.equal(s.runtimeFallbackCount, 1, 'unknown show falls back to the play runtime');
  assert.equal(s.minutesInSeat, FALLBACK_RUNTIME_PLAY);
});
