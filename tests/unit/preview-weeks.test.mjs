// BRO-5002: preview weeks already in the weekly grosses are not estimated
// again. require()s the real helper and model (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { previewWeeksFromWeekly } = require('../../scripts/lib/preview-weeks');
const { calculateRecoupment, buildWeeklySchedule } = require('../../scripts/lib/recoupment-model');

// Week-ending Sundays from first preview (2025-03-02 week) through 30 weeks.
function sundays(from, n) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7); }
  return out;
}

describe('previewWeeksFromWeekly', () => {
  test('weekly rows from first preview cover every preview week', () => {
    const r = previewWeeksFromWeekly(sundays('2025-03-02', 20), '2025-03-27', 4);
    assert.equal(r.covered, 4);
    assert.equal(r.toEstimate, 0);
    assert.deepEqual([...r.previewRowDates], ['2025-03-02', '2025-03-09', '2025-03-16', '2025-03-23']);
  });

  test('weekly rows starting at opening leave every preview week to estimate', () => {
    const r = previewWeeksFromWeekly(sundays('2025-03-30', 20), '2025-03-27', 4);
    assert.equal(r.covered, 0);
    assert.equal(r.toEstimate, 4);
  });

  test('partial coverage estimates only the missing early weeks; never more rows than preview weeks', () => {
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-16', 20), '2025-03-27', 4).toEstimate, 2);
    const long = previewWeeksFromWeekly(sundays('2025-01-05', 30), '2025-03-27', 4);
    assert.equal(long.covered, 4);
    assert.ok(long.previewRowDates.has('2025-03-23') && !long.previewRowDates.has('2025-01-05'));
  });

  test('rows before the first preview (an earlier production) are not counted', () => {
    const dates = ['2015-03-29', ...sundays('2025-03-16', 20)];
    const r = previewWeeksFromWeekly(dates, '2025-03-27', 4, '2025-03-11');
    assert.equal(r.covered, 2);
    assert.ok(!r.previewRowDates.has('2015-03-29'));
    assert.equal(previewWeeksFromWeekly(dates, '2025-03-27', 4).covered, 3, 'without a previews date the old row slips in');
  });

  test('Sunday opening and a timestamped opening date: the opening week is regular', () => {
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-02', 8), '2025-03-23', 3, '2025-03-01').covered, 3);
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-02', 8), '2025-03-23T19:00:00Z', 3, '2025-03-01').covered, 3);
  });

  test('COVID-split previews keep the rows on both sides of the shutdown', () => {
    const dates = ['2020-02-16', '2020-02-23', '2020-03-01', '2020-03-08', '2021-09-19', '2021-09-26', '2021-10-10'];
    const r = previewWeeksFromWeekly(dates, '2021-10-03', 6, '2020-02-13');
    assert.deepEqual([...r.previewRowDates], ['2020-02-16', '2020-02-23', '2020-03-01', '2020-03-08', '2021-09-19', '2021-09-26']);
  });

  test('no opening date or no preview weeks: nothing covered', () => {
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-02', 5), null, 4).toEstimate, 4);
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-02', 5), '2025-03-27', 0).toEstimate, 0);
  });
});

describe('calculateRecoupment schedule', () => {
  const show = { slug: 'x', title: 'X', type: 'musical', previewsStartDate: '2025-02-27', openingDate: '2025-03-27', closingDate: '2025-09-28' };
  const comm = { capitalization: 20_000_000, weeklyRunningCost: 800_000 };
  const weekly = Object.fromEntries(sundays('2025-03-02', 30).map((d) => [d, { gross: 1_200_000, performances: 8 }]));

  test('option off (the old path) still estimates the previews on top of the weekly rows', () => {
    const old = calculateRecoupment(show, comm, null, weekly, { previewsFromWeekly: false });
    assert.equal(old.previewWeeks, 4);
    assert.equal(old.totalRunWeeks, 30 + 4);
  });

  test('option on: weekly rows from first preview get 0 synthetic preview weeks', () => {
    const fixed = calculateRecoupment(show, comm, null, weekly, { previewsFromWeekly: true });
    assert.equal(fixed.totalRunWeeks, 30);
    assert.notEqual(fixed.recoupmentPctCentral, calculateRecoupment(show, comm, null, weekly, { previewsFromWeekly: false }).recoupmentPctCentral);
  });

  test('live: on by default for musicals (BRO-5598), plays and specials (BRO-6217 M02)', () => {
    for (const type of ['musical', 'play', 'special']) {
      const s = { ...show, type };
      assert.equal(calculateRecoupment(s, comm, null, weekly).totalRunWeeks, 30, type);
      assert.deepEqual(calculateRecoupment(s, comm, null, weekly), calculateRecoupment(s, comm, null, weekly, { previewsFromWeekly: true }), type);
    }
  });

  test('shadow option: covered weekly rows are flagged as previews, later rows are not', () => {
    const sched = buildWeeklySchedule(show, null, weekly, 4, 30, [], { previewsFromWeekly: true });
    assert.equal(sched.length, 30);
    assert.deepEqual(sched.slice(0, 5).map((w) => !!w.isPreview), [true, true, true, true, false]);
    assert.ok(sched.every((w) => w._source === 'weekly-history'));
  });

  test('all-time fallback (little weekly coverage) ignores the option', () => {
    const sparse = Object.fromEntries(sundays('2025-03-02', 5).map((d) => [d, { gross: 1_200_000, performances: 8 }]));
    const allTime = { gross: 1_200_000 * 30, performances: 240, attendance: 240_000 };
    const a = calculateRecoupment(show, comm, allTime, sparse);
    const b = calculateRecoupment(show, comm, allTime, sparse, { previewsFromWeekly: true });
    assert.match(a.grossDataSource, /^alltime/);
    assert.deepEqual(b, a);
  });

  test('shadow option: weekly rows starting at opening keep the estimated previews', () => {
    const fromOpening = Object.fromEntries(sundays('2025-03-30', 27).map((d) => [d, { gross: 1_200_000, performances: 8 }]));
    const a = calculateRecoupment(show, comm, null, fromOpening);
    const b = calculateRecoupment(show, comm, null, fromOpening, { previewsFromWeekly: true });
    assert.equal(b.totalRunWeeks, a.totalRunWeeks);
    assert.equal(b.recoupmentPctCentral, a.recoupmentPctCentral);
  });
});
