// BRO-5003: a running show's weeks count to today, not to an announced
// closing date. require()s the real helper and model (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runWindow, weeksInOwnRun } = require('../../scripts/lib/run-window');
const { calculateRecoupment, calculateLifetimeRecoupment } = require('../../scripts/lib/recoupment-model');

const WEEK = 7 * 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const weeksFrom = (base, n) => new Date(base.getTime() + n * WEEK);

describe('runWindow', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const show = { previewsStartDate: '2025-10-11', openingDate: '2025-11-08', closingDate: iso(weeksFrom(now, 10)) };

  test('live counts a running show to its announced closing date', () => {
    const r = runWindow(show, { now });
    assert.equal(r.totalRunWeeks, 52 + 10);
    assert.equal(r.previewWeeks, 4);
  });

  test('playedOnly: a closing date 10 weeks out counts to today', () => {
    assert.equal(runWindow(show, { now, playedOnly: true }).totalRunWeeks, 52);
  });

  test('playedOnly leaves closed shows and open-ended runs alone', () => {
    const closed = { ...show, closingDate: '2026-06-01' };
    assert.deepEqual(runWindow(closed, { now, playedOnly: true }), runWindow(closed, { now }));
    const openEnded = { ...show, closingDate: null };
    assert.deepEqual(runWindow(openEnded, { now, playedOnly: true }), runWindow(openEnded, { now }));
  });

  test('COVID dark weeks are still subtracted', () => {
    const r = runWindow({ previewsStartDate: '2019-10-01', openingDate: '2019-11-01', closingDate: '2022-01-01' }, { now });
    assert.ok(r.darkWeeks > 70);
    assert.equal(r.totalRunWeeks, Math.round((new Date('2022-01-01') - new Date('2019-10-01')) / WEEK) - r.darkWeeks);
  });

  // BRO-5091: an open-ended run counted as of a pre-shutdown date (the timing
  // backtest's as-of runs) took the whole shutdown off and read 0 weeks.
  test('an open-ended run counted as of a date before the shutdown has no dark weeks', () => {
    const hamilton = { previewsStartDate: '2015-07-13', openingDate: '2015-08-06', closingDate: null };
    const asOf = new Date('2016-03-31');
    const r = runWindow(hamilton, { now: asOf, playedOnly: true });
    assert.equal(r.darkWeeks, 0);
    assert.equal(r.totalRunWeeks, Math.round((asOf - new Date('2015-07-13')) / WEEK));
  });

  test('an open-ended run counted as of a date inside the shutdown loses only the dark weeks so far', () => {
    const r = runWindow({ previewsStartDate: '2019-03-22', openingDate: '2019-04-17', closingDate: null }, { now: new Date('2020-06-11') });
    assert.equal(r.darkWeeks, Math.round((new Date('2020-06-11') - new Date('2020-03-12')) / WEEK));
    assert.ok(r.totalRunWeeks > 40);
  });

  test('an open-ended run counted today still loses the whole shutdown', () => {
    const r = runWindow({ previewsStartDate: '2003-10-08', openingDate: '2003-10-30', closingDate: null }, { now });
    assert.equal(r.darkWeeks, Math.round((new Date('2021-09-14') - new Date('2020-03-12')) / WEEK));
  });
});

describe('models with playedWeeksOnly', () => {
  const now = new Date();
  const first = weeksFrom(now, -30);
  const show = {
    slug: 'x', title: 'X', type: 'musical',
    previewsStartDate: iso(first), openingDate: iso(weeksFrom(first, 4)), closingDate: iso(weeksFrom(now, 10)),
  };
  const comm = { capitalization: 20_000_000, weeklyRunningCost: 800_000 };
  const weekly = {};
  for (let i = 0; i < 29; i++) weekly[iso(weeksFrom(first, i + 0.5))] = { gross: 1_200_000, performances: 8 };

  test('weekly model: unplayed weeks are not gap-filled; live default unchanged', () => {
    const live = calculateRecoupment(show, comm, null, weekly);
    const played = calculateRecoupment(show, comm, null, weekly, { playedWeeksOnly: true });
    assert.ok(live.totalRunWeeks >= 39, `live counts to closing: ${live.totalRunWeeks}`);
    assert.ok(played.totalRunWeeks <= 30 + played.previewWeeks, `played stops at today: ${played.totalRunWeeks}`);
    assert.ok(played.recoupmentPctCentral < live.recoupmentPctCentral);
    assert.deepEqual(calculateRecoupment(show, comm, null, weekly, {}), live);
  });

  test('lifetime model: closing date capped at today only with the option', () => {
    const allTime = { gross: 1_200_000 * 26, performances: 26 * 8, attendance: 26 * 8 * 1000 };
    const live = calculateLifetimeRecoupment(show, comm, allTime);
    const played = calculateLifetimeRecoupment(show, comm, allTime, { playedWeeksOnly: true });
    assert.equal(live.totalRunWeeks, 36);
    assert.equal(played.totalRunWeeks, 26);
    assert.deepEqual(calculateLifetimeRecoupment(show, comm, allTime, {}), live);
  });
});

describe('weeksInOwnRun (BRO-4989 ownRunOnly)', () => {
  const rows = { '2001-03-04': { gross: 1 }, '2014-04-06': { gross: 2 }, '2024-04-07': { gross: 3 }, '2024-04-14': { gross: 4 }, '2025-01-05': { gross: 5 } };

  test('drops an earlier production sharing the key, keeps a week inside the 7-day margin', () => {
    const r = weeksInOwnRun(rows, { previewsStartDate: '2024-04-01', closingDate: '2024-12-31' });
    assert.deepEqual(Object.keys(r.weekly), ['2024-04-07', '2024-04-14', '2025-01-05']);
    assert.deepEqual(r.dropped, ['2001-03-04', '2014-04-06']);
  });

  test('open run has no upper bound; opening date is the fallback start', () => {
    const r = weeksInOwnRun(rows, { openingDate: '2014-04-01' });
    assert.deepEqual(r.dropped, ['2001-03-04']);
  });

  test('no start date keeps every row', () => {
    const r = weeksInOwnRun(rows, { closingDate: '2024-12-31' });
    assert.equal(r.weekly, rows);
    assert.deepEqual(r.dropped, []);
  });

  test('model: ownRunOnly ignores the earlier run, live default unchanged', () => {
    const show = { slug: 'x', title: 'X', type: 'musical', previewsStartDate: '2024-03-20', openingDate: '2024-04-10', closingDate: '2024-09-30' };
    const comm = { capitalization: 10_000_000, weeklyRunningCost: 700_000 };
    const weekly = {};
    for (let i = 0; i < 26; i++) weekly[iso(weeksFrom(new Date("2024-03-24"), i))] = { gross: 1_000_000, performances: 8 };
    for (let i = 0; i < 20; i++) weekly[iso(weeksFrom(new Date('2014-03-23'), i))] = { gross: 1_500_000, performances: 8 };
    const live = calculateRecoupment(show, comm, null, weekly);
    const own = calculateRecoupment(show, comm, null, weekly, { ownRunOnly: true });
    assert.ok(own.totalRunWeeks < live.totalRunWeeks, `${own.totalRunWeeks} < ${live.totalRunWeeks}`);
    assert.ok(own.warnings.some((w) => /Dropped 20 weekly rows/.test(w)));
    assert.deepEqual(calculateRecoupment(show, comm, null, weekly, {}), live);
  });
});
