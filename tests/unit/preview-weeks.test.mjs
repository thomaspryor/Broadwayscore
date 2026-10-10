// BRO-5002: preview weeks already in the weekly grosses are not estimated
// again. require()s the real helper and model (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { previewWeeksFromWeekly } = require('../../scripts/lib/preview-weeks');
const { calculateRecoupment } = require('../../scripts/lib/recoupment-model');

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

  test('no opening date or no preview weeks: nothing covered', () => {
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-02', 5), null, 4).toEstimate, 4);
    assert.equal(previewWeeksFromWeekly(sundays('2025-03-02', 5), '2025-03-27', 0).toEstimate, 0);
  });
});

describe('calculateRecoupment schedule', () => {
  const show = { slug: 'x', title: 'X', type: 'musical', previewsStartDate: '2025-02-27', openingDate: '2025-03-27', closingDate: '2025-09-28' };
  const comm = { capitalization: 20_000_000, weeklyRunningCost: 800_000 };
  const weekly = Object.fromEntries(sundays('2025-03-02', 30).map((d) => [d, { gross: 1_200_000, performances: 8 }]));

  test('live (default) still estimates the previews on top of the weekly rows', () => {
    const live = calculateRecoupment(show, comm, null, weekly);
    assert.equal(live.previewWeeks, 4);
    assert.equal(live.totalRunWeeks, 30 + 4);
  });

  test('shadow option: weekly rows from first preview get 0 synthetic preview weeks', () => {
    const fixed = calculateRecoupment(show, comm, null, weekly, { previewsFromWeekly: true });
    assert.equal(fixed.totalRunWeeks, 30);
    assert.notEqual(fixed.recoupmentPctCentral, calculateRecoupment(show, comm, null, weekly).recoupmentPctCentral);
  });

  test('shadow option: weekly rows starting at opening keep the estimated previews', () => {
    const fromOpening = Object.fromEntries(sundays('2025-03-30', 27).map((d) => [d, { gross: 1_200_000, performances: 8 }]));
    const a = calculateRecoupment(show, comm, null, fromOpening);
    const b = calculateRecoupment(show, comm, null, fromOpening, { previewsFromWeekly: true });
    assert.equal(b.totalRunWeeks, a.totalRunWeeks);
    assert.equal(b.recoupmentPctCentral, a.recoupmentPctCentral);
  });
});
