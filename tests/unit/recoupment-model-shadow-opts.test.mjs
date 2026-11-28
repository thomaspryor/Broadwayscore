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
  test('a closed show keeps an uncited credit (it does get paid)', () => {
    const closedShow = { ...show, closingDate: iso(weeksFrom(now, -2)) };
    const live = calculateRecoupment(closedShow, comm, null, weekly);
    const cited = calculateRecoupment(closedShow, comm, null, weekly, { taxCreditCitedOnly: true });
    assert.equal(cited.taxCreditExcluded, 0);
    assert.equal(cited.taxCreditAmount, live.taxCreditAmount);
    assert.equal(cited.recoupmentPctCentral, live.recoupmentPctCentral);
  });
  test('lifetime model applies the same rule', () => {
    const allTime = { gross: 1_100_000 * 99, performances: 99 * 8, attendance: 99 * 8 * 1000 };
    const live = calculateLifetimeRecoupment(show, comm, allTime);
    const cited = calculateLifetimeRecoupment(show, comm, allTime, { taxCreditCitedOnly: true });
    assert.ok(live.taxCreditAmount > 0);
    assert.equal(cited.taxCreditAmount, 0);
    assert.equal(cited.taxCreditExcluded, live.taxCreditAmount);
    const closedShow = { ...show, closingDate: iso(weeksFrom(now, -2)) };
    assert.equal(calculateLifetimeRecoupment(closedShow, comm, allTime, { taxCreditCitedOnly: true }).taxCreditExcluded, 0);
  });
});

describe('datedCosts (checker #3, shadow)', () => {
  const anchored = (amount) => ({
    ...comm,
    costHistory: [{ asOf: iso(first), amount, kind: 'running-cost', sourceType: 'trade', sourceUrl: 'https://example.com/a' }],
  });
  // Live for musicals since BRO-5598; { datedCosts: false } is the old path
  // (and what a play still gets by default).
  const OFF = { datedCosts: false };
  test('weekly: each week priced by costForWeek; musical default on, play default off', () => {
    const live = calculateRecoupment(show, anchored(800_000), null, weekly, OFF);
    const dated = calculateRecoupment(show, anchored(800_000), null, weekly, { datedCosts: true });
    assert.deepEqual(calculateRecoupment(show, anchored(800_000), null, weekly, {}), dated);
    const play = { ...show, type: 'play' };
    assert.deepEqual(calculateRecoupment(play, anchored(800_000), null, weekly), calculateRecoupment(play, anchored(800_000), null, weekly, OFF));
    assert.notEqual(dated.recoupmentPctCentral, live.recoupmentPctCentral);
    // The anchor drives each week's cost: a higher one returns less.
    const pricier = calculateRecoupment(show, anchored(900_000), null, weekly, { datedCosts: true });
    assert.ok(pricier.recoupmentPctCentral < dated.recoupmentPctCentral);
  });
  test('lifetime: run-average dated cost; musical default on', () => {
    const long = { ...show, previewsStartDate: '2015-01-01', openingDate: '2015-02-01' };
    const all = { gross: 400_000_000, performances: 3000 };
    const live = calculateLifetimeRecoupment(long, anchored(800_000), all, OFF);
    const dated = calculateLifetimeRecoupment(long, anchored(800_000), all, { datedCosts: true });
    assert.deepEqual(calculateLifetimeRecoupment(long, anchored(800_000), all, {}), dated);
    assert.ok(Number.isFinite(dated.recoupmentPctCentral));
    assert.notEqual(dated.recoupmentPctCentral, live.recoupmentPctCentral);
  });
  // Guard (checker, Cinderella 2013 false recoup): with no cost figure at all
  // the category estimate is never carried back by the index; the model keeps
  // the live flat era deflator.
  test('no cost anchor: weekly and lifetime keep the live nut', () => {
    const { weeklyRunningCost, ...noAnchor } = comm;
    assert.equal(weeklyRunningCost, 800_000);
    const strip = (r) => ({ ...r, warnings: r.warnings.filter((w) => !/No reported cost anchor/.test(w)) });
    const live = calculateRecoupment(show, noAnchor, null, weekly, OFF);
    const dated = calculateRecoupment(show, noAnchor, null, weekly, { datedCosts: true });
    assert.ok(dated.warnings.includes('No reported cost anchor (producer, SEC or trade): dated costs off, flat era deflator kept'));
    assert.deepEqual(strip(dated), live);
    const long = { ...show, previewsStartDate: '2013-01-15', openingDate: '2013-03-03' };
    const all = { gross: 400_000_000, performances: 3000 };
    const liveL = calculateLifetimeRecoupment(long, noAnchor, all, OFF);
    assert.deepEqual(strip(calculateLifetimeRecoupment(long, noAnchor, all, { datedCosts: true })), liveL);
  });

  test('a reddit or industry estimate is not an anchor', () => {
    const strip = (r) => ({ ...r, warnings: r.warnings.filter((w) => !/No reported cost anchor/.test(w)) });
    for (const costMethodology of ['reddit-standard', 'industry-estimate', undefined]) {
      const guess = { ...comm, weeklyRunningCost: 800_000, costMethodology };
      const live = calculateRecoupment(show, guess, null, weekly, OFF);
      const dated = calculateRecoupment(show, guess, null, weekly, { datedCosts: true });
      assert.ok(dated.warnings.some((w) => /No reported cost anchor/.test(w)), String(costMethodology));
      assert.deepEqual(strip(dated), live);
    }
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

describe('musicals-only variable-cost shapes (BRO-5091, shadow)', () => {
  const pct = (s, opts) => calculateRecoupment(s, comm, null, weekly, opts).recoupmentPctCentral;
  test('a play is untouched; the ramp sits between live and the full band', () => {
    const play = { ...show, type: 'play' };
    for (const o of ['varOverageMusicals', 'varBandMusicalsRamp']) assert.equal(pct(play, { [o]: true }), pct(play));
    const live = pct(show);
    const full = pct(show, { varBandMusicals: true });
    const ramp = pct(show, { varBandMusicalsRamp: true });
    assert.ok(full < ramp && ramp < live, `${full} < ${ramp} < ${live}`);
    assert.ok(pct(show, { varOverageMusicals: true }) < live);
  });
  test('the ramp adds nothing before week 26', () => {
    const at = iso(weeksFrom(first, 20));
    assert.equal(pct(show, { varBandMusicalsRamp: true, asOf: at }), pct(show, { asOf: at }));
  });
});

describe('varBandMusicalsCited (BRO-5598, live for musicals)', () => {
  const cited = { ...comm, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Jan 9, 2024): "weekly running costs of $800,000" https://www.broadwayjournal.com/p/example' };
  const pct = (s, c, opts) => calculateRecoupment(s, c, null, weekly, opts).recoupmentPctCentral;
  test('a cited running cost on a musical takes the band by default', () => {
    // varBandMusicalsReported (BRO-5872) also bands a reported cost, so turn it off to see this one.
    assert.ok(pct(show, cited) < pct(show, cited, { varBandMusicalsCited: false, varBandMusicalsReported: false }));
    assert.equal(pct(show, cited), pct(show, cited, { varBandMusicals: true, varBandMusicalsCited: false }));
  });
  test('an uncited, all-in or breakeven cost, and any play, skip it', () => {
    assert.equal(pct(show, comm), pct(show, comm, { varBandMusicalsCited: false }));
    for (const weeklyRunningCostBasis of ['all-in', 'breakeven']) {
      const c = { ...cited, weeklyRunningCostBasis };
      assert.equal(pct(show, c), pct(show, c, { varBandMusicalsCited: false }), weeklyRunningCostBasis);
    }
    const play = { ...show, type: 'play' };
    assert.equal(pct(play, cited, { varBandMusicalsCited: true }), pct(play, cited));
  });
});

describe('varBandMusicalsWaltz (BRO-5872, live for musicals)', () => {
  const waltz = { ...comm, costMethodology: 'reddit-standard', weeklyRunningCostSource: 'Estimate by u/Boring_Waltz_9545 on r/Broadway, "GROSSES ANALYSIS"' };
  const bySource = { ...comm, weeklyRunningCostSource: 'Section C: Reddit Grosses Analysis' };
  const pct = (s, c, opts) => calculateRecoupment(s, c, null, weekly, opts).recoupmentPctCentral;
  test('on by default: a Reddit cost takes the band; false keeps the flat deduction', () => {
    assert.ok(pct(show, waltz) < pct(show, waltz, { varBandMusicalsWaltz: false }));
    assert.equal(pct(show, waltz), pct(show, waltz, { varBandMusicalsWaltz: true }));
  });
  test('on: a Reddit cost on a musical takes the same band as a cited one', () => {
    assert.equal(pct(show, waltz, { varBandMusicalsWaltz: true }), pct(show, waltz, { varBandMusicals: true }));
    assert.equal(pct(show, bySource, { varBandMusicalsWaltz: true }), pct(show, bySource, { varBandMusicals: true }));
  });
  test('on: an uncited non-Reddit cost, an all-in Reddit cost, and plays skip it', () => {
    assert.equal(pct(show, comm, { varBandMusicalsWaltz: true }), pct(show, comm));
    const allIn = { ...waltz, weeklyRunningCostBasis: 'all-in' };
    assert.equal(pct(show, allIn, { varBandMusicalsWaltz: true }), pct(show, allIn));
    const play = { ...show, type: 'play' };
    assert.equal(pct(play, waltz, { varBandMusicalsWaltz: true }), pct(play, waltz));
  });
  test('on: a play breakeven and a solo show are untouched (musicals only)', () => {
    const run = (s, opts) => calculateRecoupment(s, waltz, null, weekly, opts);
    const play = { ...show, type: 'play' };
    assert.equal(run(play, { varBandMusicalsWaltz: true }).weeklyBreakeven, run(play).weeklyBreakeven);
    const solo = { ...show, type: 'special' };
    assert.equal(run(solo, { varBandMusicalsWaltz: true }).recoupmentPctCentral, run(solo).recoupmentPctCentral);
  });
  test('a cited cost is unchanged by it, and it works with the cited band off', () => {
    const cited = { ...comm, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Jan 9, 2024): "weekly running costs of $800,000" https://www.broadwayjournal.com/p/example' };
    assert.equal(pct(show, cited, { varBandMusicalsWaltz: true }), pct(show, cited));
    assert.equal(pct(show, waltz, { varBandMusicalsWaltz: true, varBandMusicalsCited: false }), pct(show, waltz, { varBandMusicalsWaltz: true }));
  });
});

describe('varBandMusicalsReported (BRO-5872, live for musicals)', () => {
  const uncited = { ...comm, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Industry sources' };
  const pct = (s, c, opts) => calculateRecoupment(s, c, null, weekly, opts).recoupmentPctCentral;
  const banded = (s, c) => pct(s, c, { varBandMusicals: true });
  test('an uncited trade or SEC-filing cost on a musical takes the band by default', () => {
    assert.ok(pct(show, uncited) < pct(show, uncited, { varBandMusicalsReported: false }));
    assert.equal(pct(show, uncited), banded(show, uncited));
    const sec = { ...uncited, costMethodology: 'sec-filing' };
    assert.equal(pct(show, sec), banded(show, sec));
  });
  test('a flagged estimate, our own methodologies, no methodology, all-in and breakeven keep the flat deduction', () => {
    const flat = (c) => assert.equal(pct(show, c), pct(show, c, { varBandMusicalsReported: false }));
    flat({ ...uncited, isEstimate: { weeklyRunningCost: true } });
    flat({ ...uncited, costMethodology: 'industry-estimate' });
    flat({ ...uncited, costMethodology: 'deep-research' });
    flat(comm);
    for (const weeklyRunningCostBasis of ['all-in', 'breakeven']) flat({ ...uncited, weeklyRunningCostBasis });
  });
  test('plays and solo shows are untouched', () => {
    for (const type of ['play', 'special']) {
      const s = { ...show, type };
      assert.equal(pct(s, uncited), pct(s, uncited, { varBandMusicalsReported: false }), type);
    }
  });
  test('the live musical defaults are pinned', () => {
    const { MUSICAL_LIVE_OPTS, ALL_LIVE_OPTS } = require('../../scripts/lib/recoupment-model');
    assert.deepEqual({ ...ALL_LIVE_OPTS }, { previewsFromWeekly: true, costBasis: true });
    assert.deepEqual({ ...MUSICAL_LIVE_OPTS }, { datedCosts: true, varBandMusicalsCited: true, varBandMusicalsWaltz: true, varBandMusicalsReported: true, capScaledMusicals: true });
  });
});
