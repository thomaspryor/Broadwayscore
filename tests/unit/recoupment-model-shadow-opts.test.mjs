// BRO-4989 shadow/backtest options on the recoupment model: taxCreditCitedOnly
// and asOf. Neither is passed by the live merge, so defaults must not move.
// require()s the real model (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { calculateRecoupment, calculateLifetimeRecoupment } = require('../../scripts/lib/recoupment-model');

const WEEK = 7 * 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const weeksFrom = (base, n) => new Date(base.getTime() + n * WEEK);

const now = new Date();
const first = weeksFrom(now, -100); // past week 78, so a running show has the credit
const show = { slug: 'x', title: 'X', type: 'musical', previewsStartDate: iso(first), openingDate: iso(weeksFrom(first, 4)) };
const comm = { capitalization: 20_000_000, weeklyRunningCost: 800_000, notes: 'Eligible for $3M NY tax credit' };
const weekly = {};
for (let i = 0; i < 99; i++) weekly[iso(weeksFrom(first, i + 0.5))] = { gross: 1_100_000, performances: 8 };

describe('taxCreditCitedOnly', () => {
  test('an uncited credit is excluded and reported; default unchanged', () => {
    const live = calculateRecoupment(show, comm, null, weekly);
    const cited = calculateRecoupment(show, comm, null, weekly, { taxCreditCitedOnly: true });
    assert.equal(live.taxCreditAmount, 3_000_000);
    assert.equal(cited.taxCreditAmount, 0);
    assert.equal(cited.taxCreditExcluded, 3_000_000);
    assert.ok(!('taxCreditExcluded' in live));
    assert.ok(cited.warnings.some((w) => /Not counting an expected NY tax credit of up to \$3\.0M/.test(w)));
    assert.ok(!cited.warnings.some((w) => /program window/.test(w)));
    assert.ok(Math.abs(live.recoupmentPctCentral - cited.recoupmentPctCentral) > 5);
    assert.deepEqual(calculateRecoupment(show, comm, null, weekly, {}), live);
  });
  test('a cited credit still counts', () => {
    const c = { ...comm, notes: 'Received $3M NY state tax credit' };
    const r = calculateRecoupment(show, c, null, weekly, { taxCreditCitedOnly: true });
    assert.equal(r.taxCreditAmount, 3_000_000);
    assert.equal(r.taxCreditExcluded, 0);
  });
  test('lifetime model applies the same rule', () => {
    const allTime = { gross: 1_100_000 * 99, performances: 99 * 8, attendance: 99 * 8 * 1000 };
    const live = calculateLifetimeRecoupment(show, comm, allTime);
    const cited = calculateLifetimeRecoupment(show, comm, allTime, { taxCreditCitedOnly: true });
    assert.ok(live.taxCreditAmount > 0);
    assert.equal(cited.taxCreditAmount, 0);
    assert.equal(cited.taxCreditExcluded, live.taxCreditAmount);
  });
});

describe('asOf (backtest only)', () => {
  test('drops later weekly rows, ends the run at the date, keeps a later-closing show running', () => {
    const closing = { ...show, closingDate: iso(weeksFrom(now, -5)) };
    const at = iso(weeksFrom(first, 40));
    const r = calculateRecoupment(closing, comm, null, weekly, { asOf: at });
    assert.ok(r.totalRunWeeks <= 41 + r.previewWeeks, `run ends at asOf: ${r.totalRunWeeks}`);
    // running at week 40, so no week-78 credit yet and no closing costs
    assert.ok(r.central.cumulativeProfit < calculateRecoupment(closing, comm, null, weekly).central.cumulativeProfit);
  });
  test('rejects a bad date and a date before any grosses', () => {
    assert.ok(calculateRecoupment(show, comm, null, weekly, { asOf: 'nope' }).error);
    assert.ok(calculateRecoupment(show, comm, null, weekly, { asOf: iso(weeksFrom(first, -10)) }).error);
  });
});
