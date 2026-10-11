// Shadow cost split (BRO-5073, opts.costSplit). require()s the real helpers (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { splitCosts, costBasis, EXTRA_VARIABLE } = require('../../scripts/lib/cost-split');
const { calculateRecoupment, costPathFactor } = require('../../scripts/lib/recoupment-model');

test('costBasis: explicit field wins, then the source text, default running', () => {
  assert.equal(costBasis({ weeklyRunningCostBasis: 'all-in', weeklyRunningCostSource: 'excluding royalties' }), 'all-in');
  assert.equal(costBasis({ weeklyRunningCostSource: 'Variety: $1.3M a week all-in' }), 'all-in');
  assert.equal(costBasis({ weeklyRunningCostSource: 'weekly cost, includes royalties' }), 'all-in');
  assert.equal(costBasis({ weeklyRunningCostSource: 'pure operating nut ~$1.0-1.1M; earlier figure included amortization' }), 'running');
  assert.equal(costBasis({ weeklyRunningCostSource: 'Early weeks roughly broke even at ~$944K net' }), 'running');
  assert.equal(costBasis({}), 'running');
});

test('splitCosts: a running cost stays fixed; an all-in cost sheds its gross-linked share', () => {
  const run = splitCosts({}, 'musical', 1e6, 0.11, 0.07);
  assert.equal(run.varRate, 0.11 + EXTRA_VARIABLE.musical);
  assert.equal(run.fixedNut, 1e6);
  const allIn = splitCosts({ weeklyRunningCostBasis: 'all-in' }, 'musical', 1e6, 0.11, 0.07);
  assert.ok(Math.abs(allIn.fixedNut - 1e6 * (1 - 0.16 - 0.07)) < 1e-6);
  assert.equal(splitCosts({}, 'play', 5e5, 0.12, 0.07).varRate, 0.12);
});

test('calculateRecoupment ignores the split unless opts.costSplit is set', () => {
  const weekly = {};
  for (let i = 0; i < 60; i++) weekly[new Date(Date.UTC(2017, 0, 1 + 7 * i)).toISOString().slice(0, 10)] = { gross: 1600000 };
  const show = { slug: 'x', type: 'musical', previewsStartDate: '2016-12-20', openingDate: '2017-01-10', closingDate: '2018-02-01' };
  const comm = { capitalization: 12e6, weeklyRunningCost: 700000 };
  const live = calculateRecoupment(show, comm, null, weekly);
  const again = calculateRecoupment(show, comm, null, weekly, {});
  const shadow = calculateRecoupment(show, comm, null, weekly, { costSplit: true });
  assert.equal(live.recoupmentPctCentral, again.recoupmentPctCentral);
  assert.ok(shadow.recoupmentPctCentral < live.recoupmentPctCentral);
  assert.equal(shadow.weeklyFixedCosts, live.weeklyFixedCosts);
});

test('costPathFactor: shadow cost paths (stepSmall, stepLate, costGrowth)', () => {
  const live = (w) => (w > 104 ? 0.88 : w > 52 ? 0.93 : 1);
  for (const w of [1, 52, 53, 104, 105, 300]) assert.equal(costPathFactor(w, {}), live(w));
  assert.equal(costPathFactor(60, { stepSmall: true }), 0.96);
  assert.equal(costPathFactor(120, { stepSmall: true }), 0.93);
  assert.equal(costPathFactor(60, { stepLate: true }), 1);
  assert.equal(costPathFactor(100, { stepLate: true }), 0.93);
  assert.equal(costPathFactor(157, { stepLate: true }), 0.88);
  assert.ok(Math.abs(costPathFactor(53, { costGrowth: true }) - 1.035 * 0.93) < 1e-9);
});

test('extraVariableCost: shadow gross-band and overage deductions (BRO-5073)', () => {
  const { extraVariableCost } = require('../../scripts/lib/recoupment-model');
  const nut = 1e6;
  assert.equal(extraVariableCost(1.5e6, nut, 0.11 * 1.5e6, null), 0, 'live path adds nothing');
  // varBand: 12% below 0.9x cost, 23.5% at 1.5x and up, minus what live already deducts.
  assert.equal(Math.round(extraVariableCost(0.8e6, nut, 0.11 * 0.8e6, { varBand: true })), Math.round(0.01 * 0.8e6));
  assert.equal(Math.round(extraVariableCost(1.5e6, nut, 0.11 * 1.5e6, { varBand: true })), Math.round(0.125 * 1.5e6));
  assert.equal(Math.round(extraVariableCost(1.2e6, nut, 0.11 * 1.2e6, { varBand: true })), Math.round((0.1775 - 0.11) * 1.2e6));
  // varOverage: matches varBand at 1.5x, nothing at or below cost.
  assert.equal(extraVariableCost(0.9e6, nut, 0, { varOverage: true }), 0);
  assert.equal(Math.round(extraVariableCost(1.5e6, nut, 0, { varOverage: true })), Math.round(0.125 * 1.5e6));
});
