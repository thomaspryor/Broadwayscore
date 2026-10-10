// BRO-5003: a running show's weeks count to today, not to an announced
// closing date. require()s the real helper and model (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runWindow } = require('../../scripts/lib/run-window');
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
