/**
 * BRO-7246 Closing Watch: tested against the real functions (CLAUDE.md §15).
 * Runs in the tsx batch (tests/unit-test-manifest-tsx.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOnClosingWatch,
  isNearBreakEven,
  isNewNearOrBelowBreakEven,
  isNewShow,
  splitStruggling,
  isBoxOfficeDriven,
  finalRunStart,
  seasonalIndexSeries,
  adjustedRatioSeries,
  spellObservations,
  calibrateClosingWatch,
  kaplanMeierQuantile,
  weeksUnderThreshold,
  estimateClosing,
  addWeeks,
  bankedShareSeries,
  holdsAtLowerBreakEven,
  weeksBelowBreakEven,
  CLOSING_WATCH_MIN_WEEKS,
  type ClosingWatchInput,
  type ClosingObservation,
} from '../../src/lib/closing-watch';
import { formatMonthYear } from '../../src/lib/biz-format';

const base: ClosingWatchInput = {
  status: 'open',
  designation: 'TBD',
  closingDate: null,
  today: '2026-11-09',
  avgGross: 750_000,
  breakEven: 935_000,
  adjustedRatio: 0.8,
};

test('watch: running, no closing announced, under break-even as printed and season-adjusted', () => {
  assert.equal(isOnClosingWatch(base), true);
  assert.equal(isOnClosingWatch({ ...base, status: 'previews' }), true);
  assert.equal(isOnClosingWatch({ ...base, designation: 'Recouped' }), true);
});

test('watch: a January dip alone (adjusted ratio at or over 1) does not list a hit', () => {
  assert.equal(isOnClosingWatch({ ...base, designation: 'Recouped', adjustedRatio: 1.04 }), false);
  assert.equal(isOnClosingWatch({ ...base, adjustedRatio: null }), false);
});

test('watch: announced closing ahead, closed, nonprofit, tour stop, limited run, at or over break-even are off', () => {
  assert.equal(isOnClosingWatch({ ...base, closingDate: '2027-01-03' }), false);
  assert.equal(isOnClosingWatch({ ...base, closingDate: '2026-11-09' }), false);
  assert.equal(isOnClosingWatch({ ...base, closingDate: '2026-06-01' }), true); // a passed date is no announcement
  assert.equal(isOnClosingWatch({ ...base, status: 'closed' }), false);
  assert.equal(isOnClosingWatch({ ...base, designation: 'Nonprofit' }), false);
  assert.equal(isOnClosingWatch({ ...base, designation: 'Tour Stop' }), false);
  assert.equal(isOnClosingWatch({ ...base, limitedRun: true }), false);
  assert.equal(isOnClosingWatch({ ...base, avgGross: 935_000 }), false);
  assert.equal(isOnClosingWatch({ ...base, breakEven: 0 }), false);
  assert.equal(isBoxOfficeDriven('Flop', false), true);
});

test('final run: a long gap (the 2020-21 shutdown) starts a new run; a skipped week does not', () => {
  assert.equal(finalRunStart([5, 6, null, null, null, null, null, 7, 8]), 7);
  assert.equal(finalRunStart([5, null, 6, 7]), 0);
  assert.equal(finalRunStart([null, null]), -1);
});

test('seasonal index: a week below the market year average reads under 1; too little history reads 1', () => {
  const market = [...Array(48).fill(100), 70, 70, 70, 70];
  const idx = seasonalIndexSeries(market);
  assert.equal(idx[10], 1); // fewer than 26 weeks of history
  assert.ok(idx[51] < 0.8);
});

test('adjusted ratio: null until the run has enough weeks, then 4-week average / break-even / season', () => {
  const weekly = Array(10).fill(80);
  const r = adjustedRatioSeries(weekly, Array(10).fill(1), 100);
  assert.equal(r.slice(0, CLOSING_WATCH_MIN_WEEKS - 1).every((x) => x === null), true);
  assert.equal(r[9], 0.8);
  // A January market at 0.8 of its year: the same gross reads as break-even.
  assert.equal(adjustedRatioSeries(weekly, Array(10).fill(0.8), 100)[9], 1);
});

test('spells: one observation per drop under each threshold, weeks to the end, recoveries counted again', () => {
  const ratios = [null, 1.1, 0.95, 1.05, 0.85, 0.85];
  const obs = spellObservations(ratios, true);
  // Under 100%: dropped at index 2 and again at 4 (end = 5).
  assert.deepEqual(obs[3], [{ weeks: 3, closed: true, under: 1, cushion: null, age: 2 }, { weeks: 1, closed: true, under: 1, cushion: null, age: 4 }]);
  // Under 90%: once, at index 4.
  assert.deepEqual(obs[2], [{ weeks: 1, closed: true, under: 1, cushion: null, age: 4 }]);
  assert.deepEqual(obs[0], []);
  assert.equal(calibrateClosingWatch([{ ratios, closed: false }])[3][0].closed, false);
});

test('Kaplan-Meier: running shows (censored) push the median out instead of being ignored', () => {
  const closedOnly: ClosingObservation[] = [2, 4, 6, 8].map((w) => ({ weeks: w, closed: true }));
  assert.equal(kaplanMeierQuantile(closedOnly, 0.5), 4);
  const withSurvivors = [...closedOnly, ...[3, 5, 30, 40].map((w) => ({ weeks: w, closed: false }))];
  assert.equal(kaplanMeierQuantile(withSurvivors, 0.5), 8);
  assert.equal(kaplanMeierQuantile([{ weeks: 5, closed: false }], 0.5), null);
});

test('estimate: conditions on how long the show has already been under, so the clock does not restart', () => {
  const cal: ClosingObservation[][] = [[], [], [], []];
  // 30 past spells under 90%: closed after 1..30 weeks.
  for (let w = 1; w <= 30; w++) cal[2].push({ weeks: w, closed: true });
  const fresh = [...Array(10).fill(1.05), 0.85];
  const est = estimateClosing(fresh, cal);
  assert.ok(est);
  assert.equal(est!.weeksUnder, 0);
  assert.equal(est!.median, 15);
  // Under 90% for 10 weeks already: only spells lasting 10+ weeks count, shifted by 10.
  const long = [...Array(10).fill(1.05), ...Array(11).fill(0.85)];
  assert.equal(weeksUnderThreshold(long, 0.9), 10);
  const est2 = estimateClosing(long, cal)!;
  assert.equal(est2.sample, 21);
  assert.equal(est2.median, 10);
  // A past spell that recovered quickly is not the same position as one stuck under.
  const recovered = cal.map((c) => c.map((o) => ({ ...o, under: 2 })));
  assert.equal(estimateClosing(long, recovered), null);
  // Not enough history behind it: no estimate.
  assert.equal(estimateClosing([...Array(10).fill(1.05), ...Array(30).fill(0.85)], cal), null);
});

test('helpers: addWeeks, consecutive weeks under break-even over the full run, month formatting', () => {
  assert.equal(addWeeks('2026-11-01', 10), '2027-01-10');
  assert.equal(weeksBelowBreakEven([80, 90, 120, 50], 100), 2);
  assert.equal(weeksBelowBreakEven([80, null, 90, 70, 70, 70, 70, 70, 70, 70, 110], 100), 9);
  assert.equal(formatMonthYear('2027-01-24'), 'Jan 2027');
  assert.equal(formatMonthYear(null), null);
});

test('cushion: banked profit splits the comparison when that side has enough history, else everyone counts', () => {
  // 100 a week against break-even 80 for 10 weeks, then 50: banked share of a 400 capitalization.
  const banked = bankedShareSeries([...Array(10).fill(100), 50, 50], 80, 400);
  assert.equal(banked[9], 0.5);
  assert.equal(banked[11], (200 - 60) / 400);
  assert.deepEqual(bankedShareSeries([100], 80, null), []);
  const obs = spellObservations([null, 1.1, 0.8, 0.8], true, [0, 0.1, 0.6, 0.5]);
  assert.equal(obs[2][0].cushion, 0.6);

  const cal: ClosingObservation[][] = [[], [], [], []];
  for (let w = 1; w <= 20; w++) cal[2].push({ weeks: w, closed: true, cushion: 0.1 }); // thin: close within 1..20
  for (let w = 41; w <= 60; w++) cal[2].push({ weeks: w, closed: true, cushion: 1.3 }); // banked: 41..60
  const ratios = [...Array(10).fill(1.05), 0.85];
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 0.05])!.cushion, 'thin');
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 0.05])!.median, 10);
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 1.2])!.median, 50);
  // Half earned back is still thin (Buena Vista Social Club, Nov 2026: 0.50 banked, closed 12 weeks later).
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 0.5])!.cushion, 'thin');
  // No capitalization: pooled.
  const pooled = estimateClosing(ratios, cal)!;
  assert.equal(pooled.cushion, null);
  assert.equal(pooled.sample, 40);
  // Too few on its own side: pooled.
  const thinOnly = cal.map((c) => c.filter((o) => o.cushion! < 1 || o.weeks > 55));
  assert.equal(estimateClosing(ratios, thinOnly, [...Array(10).fill(0), 1.2])!.cushion, null);
});

test('show age: a first-year show is compared with first-year spells, an established one with established spells', () => {
  const cal: ClosingObservation[][] = [[], [], [], []];
  for (let w = 1; w <= 20; w++) cal[2].push({ weeks: w, closed: true, age: 10 }); // young flops: 1..20
  for (let w = 61; w <= 80; w++) cal[2].push({ weeks: w, closed: true, age: 200 }); // long runners: 61..80
  const youngShow = estimateClosing([...Array(10).fill(1.05), 0.85], cal)!;
  assert.equal(youngShow.young, true);
  assert.equal(youngShow.median, 10);
  const oldShow = estimateClosing([...Array(100).fill(1.05), 0.85], cal)!;
  assert.equal(oldShow.young, false);
  assert.equal(oldShow.median, 70);
  // Without age on the history (or too few on its side): everyone counts.
  assert.equal(estimateClosing([...Array(10).fill(1.05), 0.85], cal.map((c) => c.map(({ age: _a, ...o }) => o)))!.young, null);
});

test('break-even margin: a show far enough under stays under if our break-even is 10% too high', () => {
  assert.equal(holdsAtLowerBreakEven(747, 935, 0.82), true); // 841 at 10% lower: still under
  assert.equal(holdsAtLowerBreakEven(880, 935, 0.94), false);
  assert.equal(holdsAtLowerBreakEven(800, 935, 0.92), false); // raw under, season-adjusted not
});

test('watch: a repeatedly extended run (2+) has no announced closing even with a future closingDate (BRO-7252)', () => {
  const future = { ...base, closingDate: '2027-07-04' };
  assert.equal(isOnClosingWatch(future), false);
  assert.equal(isOnClosingWatch({ ...future, closingExtensionCount: 1 }), false);
  assert.equal(isOnClosingWatch({ ...future, closingExtensionCount: 12 }), true);
  assert.equal(isOnClosingWatch({ ...future, closingExtensions: [{}, {}] }), true);
});

test('close to break-even: just above, or under only after the season adjustment; never also on the watch', () => {
  const near = { ...base, avgGross: 1_000_000, adjustedRatio: 1.07 }; // 107% of 935K
  assert.equal(isNearBreakEven(near), true);
  assert.equal(isNearBreakEven({ ...near, avgGross: 935_000 * 1.1 }), true);
  assert.equal(isNearBreakEven({ ...near, avgGross: 935_000 * 1.11 }), false); // comfortably above
  // Two Strangers, Oct 2026: 95% raw, 105% season-adjusted. Off the watch, on this list.
  const twoStrangers = { ...base, avgGross: 888_000, adjustedRatio: 1.05 };
  assert.equal(isOnClosingWatch(twoStrangers), false);
  assert.equal(isNearBreakEven(twoStrangers), true);
  // On the watch: not listed twice.
  assert.equal(isNearBreakEven(base), false);
  assert.equal(isNearBreakEven({ ...near, closingDate: '2027-04-04' }), false);
  // Extended twice or more: that date is not a real closing (BRO-7252), so it can still be "close".
  assert.equal(isNearBreakEven({ ...near, closingDate: '2027-04-04', closingExtensionCount: 3 }), true);
  assert.equal(isNearBreakEven({ ...near, designation: 'Nonprofit' }), false);
  assert.equal(isNearBreakEven({ ...near, status: 'closed' }), false);
  assert.equal(isNearBreakEven({ ...near, breakEven: null }), false);
  // A show in its first weeks (no adjusted figure yet) at 75% is neither listed nor near (Wanted, Nov 2026).
  assert.equal(isNearBreakEven({ ...base, avgGross: 700_000, adjustedRatio: null }), false);
  // Far under on raw grosses, lifted over 1 only by a deep January index: not "close".
  assert.equal(isNearBreakEven({ ...base, avgGross: 700_000, adjustedRatio: 1.02 }), false);
  assert.equal(isNearBreakEven({ ...base, avgGross: 842_000, adjustedRatio: 1.02 }), true); // 90%
});

test('struggling shows with an announced closing are "closing before recouping", not "at risk"', () => {
  const shows = [
    { slug: 'stranger-things', closingDate: '2027-01-03' },
    { slug: 'no-closing', closingDate: null },
    { slug: 'two-strangers', closingDate: '2026-11-29' },
    { slug: 'schmigadoon', closingDate: '2027-04-04', closingExtensionCount: 3 },
  ];
  const { closing, atRisk } = splitStruggling(shows);
  assert.deepEqual(closing.map((s) => s.slug), ['stranger-things', 'two-strangers']);
  assert.deepEqual(atRisk.map((s) => s.slug), ['no-closing', 'schmigadoon']);
});

test('new show too early to judge: fewer than 4 weeks, under or near break-even, listed as New (owner 2026-11-10)', () => {
  // Wanted, Nov 2026: 3 preview weeks averaging ~$528K vs ~$700K, no season-adjusted figure yet.
  const wanted = { ...base, avgGross: 528_000, breakEven: 700_000, adjustedRatio: null, weeksBelow: 3 };
  assert.equal(isNewNearOrBelowBreakEven(wanted), true);
  assert.equal(isNearBreakEven(wanted), false); // the established rule still needs 4 weeks
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, avgGross: 700_000 * 1.2 }), false); // comfortably above
  // Still New with a 4th week: the tag lasts NEW_SHOW_WEEKS after opening, not until a 4th week posts.
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, adjustedRatio: 0.75, openingDate: '2026-11-08', today: '2026-11-24' }), true);
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, openingDate: '2026-11-08', today: '2027-01-10' }), false); // 9 weeks in
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, closingDate: '2027-01-03' }), false); // announced closing
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, limitedRun: true }), false);
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, status: 'closed' }), false);
  // Opened Nov 8, 2026: New. A long-running show back from a break with few weeks: not New.
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, openingDate: '2026-11-08', today: '2026-11-10' }), true);
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, openingDate: '2019-03-01', today: '2026-11-10' }), false);
  assert.equal(isNewNearOrBelowBreakEven({ ...wanted, openingDate: null }), true); // still in previews
});

test('isNewShow: within 8 weeks of opening or not yet opened', () => {
  assert.equal(isNewShow('2026-11-08', '2027-01-03'), true);
  assert.equal(isNewShow('2026-11-08', '2027-01-04'), false);
  assert.equal(isNewShow(null, '2026-11-10'), true);
});
