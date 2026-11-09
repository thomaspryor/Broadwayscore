/**
 * BRO-7246 Closing Watch: tested against the real functions (CLAUDE.md §15).
 * Runs in the tsx batch (tests/unit-test-manifest-tsx.txt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateClosingWatch,
  closingBandFor,
  isOnClosingWatch,
  addWeeks,
  weeksBelowBreakEven,
  quantile,
  CLOSING_WATCH_MIN_SAMPLE,
  type ClosingWatchInput,
} from '../../src/lib/closing-watch';

const base: ClosingWatchInput = {
  status: 'open',
  designation: 'TBD',
  closingDate: null,
  today: '2026-11-09',
  avgGross: 750_000,
  breakEven: 935_000,
  reportedWeeks: 40,
};

test('watch: running, no closing announced, 4-week average under break-even (Maybe Happy Ending shape)', () => {
  assert.equal(isOnClosingWatch(base), true);
  assert.equal(isOnClosingWatch({ ...base, status: 'previews' }), true);
  // A recouped hit that slips under break-even can still close.
  assert.equal(isOnClosingWatch({ ...base, designation: 'Recouped' }), true);
});

test('watch: an announced closing still ahead takes the show off (nothing left to predict)', () => {
  assert.equal(isOnClosingWatch({ ...base, closingDate: '2027-01-03' }), false);
  assert.equal(isOnClosingWatch({ ...base, closingDate: '2026-11-09' }), false);
  // A passed date on an open show is not an announcement.
  assert.equal(isOnClosingWatch({ ...base, closingDate: '2026-06-01' }), true);
});

test('watch: closed, nonprofit and tour-stop runs, new shows and shows at or over break-even are off', () => {
  assert.equal(isOnClosingWatch({ ...base, status: 'closed' }), false);
  assert.equal(isOnClosingWatch({ ...base, designation: 'Nonprofit' }), false);
  assert.equal(isOnClosingWatch({ ...base, designation: 'Tour Stop' }), false);
  assert.equal(isOnClosingWatch({ ...base, reportedWeeks: 5 }), false);
  assert.equal(isOnClosingWatch({ ...base, avgGross: 935_000 }), false);
  assert.equal(isOnClosingWatch({ ...base, avgGross: null }), false);
  assert.equal(isOnClosingWatch({ ...base, breakEven: 0 }), false);
});

test('calibration: weeks left are counted from the first week a show enters each band', () => {
  // 10 healthy weeks at break-even 100, then 4 weeks at 50: the 4-week average
  // first drops to 0.875 at index 10, 0.75 (band 75-90%) at 11, 0.625 at 12, 0.5 at 13.
  const g = [...Array(10).fill(100), 50, 50, 50, 50];
  const cal = calibrateClosingWatch([{ grossesOldestFirst: g, breakEven: 100 }]);
  assert.deepEqual(cal.map((b) => b.sample), [1, 1, 1, 0]);
  assert.equal(cal[0].median, 0); // under 60% first at the last week
  assert.equal(cal[1].median, 1); // 60-75% at index 12
  assert.equal(cal[2].median, 3); // 75-90% at index 10
});

test('calibration: shows with no break-even or too few weeks are skipped', () => {
  const cal = calibrateClosingWatch([
    { grossesOldestFirst: Array(20).fill(10), breakEven: 0 },
    { grossesOldestFirst: Array(5).fill(10), breakEven: 100 },
  ]);
  assert.ok(cal.every((b) => b.sample === 0));
});

test('band lookup needs enough past shows before it prints a window', () => {
  const shows = Array.from({ length: CLOSING_WATCH_MIN_SAMPLE }, (_, k) => ({
    grossesOldestFirst: [...Array(10).fill(100), ...Array(k + 3).fill(80)],
    breakEven: 100,
  }));
  const cal = calibrateClosingWatch(shows);
  const band = closingBandFor(0.8, cal);
  assert.ok(band);
  assert.equal(band!.min, 0.75);
  assert.equal(closingBandFor(0.5, cal), null); // empty band
  assert.equal(closingBandFor(1.1, cal), null); // over break-even
});

test('helpers: quantile, addWeeks, consecutive weeks under break-even', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.equal(addWeeks('2026-11-01', 10), '2027-01-10');
  assert.equal(weeksBelowBreakEven([80, 90, 120, 50], 100), 2);
  assert.equal(weeksBelowBreakEven([null, 80], 100), 0);
});
