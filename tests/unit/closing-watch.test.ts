/**
 * BRO-7246 Closing Watch: tested against the real functions (CLAUDE.md §15).
 * Runs in the tsx batch (tests/unit-test-manifest-tsx.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOnClosingWatch,
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
  assert.deepEqual(obs[3], [{ weeks: 3, closed: true, under: 1, cushion: null }, { weeks: 1, closed: true, under: 1, cushion: null }]);
  // Under 90%: once, at index 4.
  assert.deepEqual(obs[2], [{ weeks: 1, closed: true, under: 1, cushion: null }]);
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
  for (let w = 41; w <= 60; w++) cal[2].push({ weeks: w, closed: true, cushion: 0.9 }); // banked: 41..60
  const ratios = [...Array(10).fill(1.05), 0.85];
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 0.05])!.cushion, 'thin');
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 0.05])!.median, 10);
  assert.equal(estimateClosing(ratios, cal, [...Array(10).fill(0), 0.8])!.median, 50);
  // No capitalization: pooled.
  const pooled = estimateClosing(ratios, cal)!;
  assert.equal(pooled.cushion, null);
  assert.equal(pooled.sample, 40);
  // Too few on its own side: pooled.
  const thinOnly = cal.map((c) => c.filter((o) => o.cushion! < 0.5 || o.weeks > 55));
  assert.equal(estimateClosing(ratios, thinOnly, [...Array(10).fill(0), 0.8])!.cushion, null);
});
