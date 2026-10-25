// Shadow cost split (BRO-5073, opts.costSplit). require()s the real helpers (§15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { splitCosts, costBasis, fixedNutFromBasis, breakEvenRatio, periodGross, EXTRA_VARIABLE } = require('../../scripts/lib/cost-split');
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

test('SVOG is off the cap unless svogCredit; costSourcedOnly is shadow (BRO-5073)', () => {
  const weekly = {};
  for (let i = 0; i < 60; i++) weekly[new Date(Date.UTC(2022, 0, 2 + 7 * i)).toISOString().slice(0, 10)] = { gross: 1200000 };
  const show = { slug: 'six', type: 'musical', previewsStartDate: '2021-12-20', openingDate: '2022-01-10' };
  const comm = { capitalization: 5e6, weeklyRunningCost: 469000, costMethodology: 'industry-estimate' };
  const live = calculateRecoupment(show, comm, null, weekly, { asOf: new Date('2023-03-01') });
  const legacy = calculateRecoupment(show, comm, null, weekly, { asOf: new Date('2023-03-01'), svogCredit: true });
  assert.equal(live.svogGrant, 0);
  assert.equal(legacy.svogGrant, 10000000);
  assert.ok(live.recoupmentPctCentral < legacy.recoupmentPctCentral);
  const sourced = calculateRecoupment(show, comm, null, weekly, { asOf: new Date('2023-03-01'), costSourcedOnly: true });
  assert.equal(live.weeklyFixedCostSource, 'reported');
  assert.equal(sourced.weeklyFixedCostSource, 'unsourced');
  assert.equal(sourced.dataQuality, 'low');
  const cited = { ...comm, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Jan 16, 2020): "Its weekly breakeven, after deductions, is $469,000." https://www.broadwayjournal.com/p/x' };
  assert.equal(calculateRecoupment(show, cited, null, weekly, { asOf: new Date('2023-03-01'), costSourcedOnly: true }).dataQuality, 'high');
});

// The model looks its slug-keyed tables up by `show.slug || show.id` (recoupment-model.js), so check
// keys against that namespace. public/data/search-shows.json is committed, so this runs in CI
// (data/ is not checked out there); data/commercial.json is checked too when present.
const fs = require('fs');
const searchShowsPath = new URL('../../public/data/search-shows.json', import.meta.url);
const commercialPath = new URL('../../data/commercial.json', import.meta.url);
test('every slug-keyed table in the recoupment model names a real show (BRO-5073)', () => {
  const { KNOWN_SVOG, KNOWN_STAR_DEALS } = require('../../scripts/lib/recoupment-model');
  const keys = [...Object.keys(KNOWN_SVOG), ...Object.keys(KNOWN_STAR_DEALS)];
  assert.ok(keys.length > 0);
  const shows = JSON.parse(fs.readFileSync(searchShowsPath, 'utf8'));
  const names = new Set((Array.isArray(shows) ? shows : shows.shows).flatMap((s) => [s.slug, s.id]));
  assert.deepEqual(keys.filter((k) => !names.has(k)), [], 'not a show slug or id');
  if (fs.existsSync(commercialPath)) {
    const records = JSON.parse(fs.readFileSync(commercialPath, 'utf8')).shows;
    assert.deepEqual(keys.filter((k) => !records[k]), [], 'no commercial.json record');
  }
});

test('fixedNutFromBasis: running unchanged, breakeven inverts the model breakeven, all-in sheds gross-linked costs (BRO-5093)', () => {
  const T = { pctOfGross: 0.07, rentPctOfNut: 0.12 };
  const v = 0.11;
  assert.deepEqual(fixedNutFromBasis({ weeklyRunningCost: 600_000 }, 600_000, v, T), { nut: 600_000, basis: 'running' });
  assert.equal(fixedNutFromBasis({ weeklyRunningCost: 600_000, weeklyRunningCostBasis: 'bogus' }, 600_000, v, T).basis, 'running');
  // breakeven: the model's own breakeven of the nut comes back to the figure
  const be = fixedNutFromBasis({ weeklyRunningCost: 800_000, weeklyRunningCostBasis: 'breakeven' }, 800_000, v, T);
  assert.equal(Math.round(be.nut * breakEvenRatio(v, T)), 800_000); // BRO-6217 M04
  // all-in over a quoted period: E = nut + v G + max(0, pct G - rent share x nut)
  const weekly = {};
  for (let i = 0; i < 60; i++) weekly[new Date(Date.UTC(2025, 2, 16) + i * 7 * 86400000).toISOString().slice(0, 10)] = { gross: 1_500_000 };
  const src = 'BroadwayWorld: "averaged a weekly operating expense of $963,000 in the 52 week period ending March 15, 2026"';
  assert.equal(Math.round(periodGross(src, weekly)), 1_500_000);
  assert.equal(periodGross('no period here', weekly), null);
  const ai = fixedNutFromBasis({ weeklyRunningCost: 963_000, weeklyRunningCostBasis: 'all-in', weeklyRunningCostSource: src }, 963_000, v, T, weekly);
  const back = ai.nut + v * ai.gross + Math.max(0, T.pctOfGross * ai.gross - T.rentPctOfNut * ai.nut);
  assert.equal(Math.round(back), 963_000);
  assert.ok(ai.nut < 963_000 && ai.gross === 1_500_000);
  // no period: taken at a gross equal to the figure
  assert.equal(fixedNutFromBasis({ weeklyRunningCost: 963_000, weeklyRunningCostBasis: 'all-in' }, 963_000, v, T).gross, 963_000);
  // gross-linked part larger than the figure: keep the figure
  assert.deepEqual(fixedNutFromBasis({ weeklyRunningCost: 100_000, weeklyRunningCostBasis: 'all-in', weeklyRunningCostSource: src }, 100_000, v, T, weekly), { nut: 100_000, basis: 'running', rejected: 'all-in' });
  assert.equal(ai.fromPeriod, true);
  assert.equal(costBasis({ weeklyRunningCostBasis: 'breakeven' }), 'all-in');
});

test('calculateRecoupment reads the basis (live since BRO-6217); costBasis: false ignores it (BRO-5093)', () => {
  const WEEK = 7 * 86400000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const first = Date.now() - 40 * WEEK;
  const show = { slug: 'x', title: 'X', type: 'musical', previewsStartDate: iso(first), openingDate: iso(first + 4 * WEEK) };
  const weekly = {};
  for (let i = 0; i < 39; i++) weekly[iso(first + (i + 0.5) * WEEK)] = { gross: 1_000_000, performances: 8 };
  const comm = { capitalization: 15_000_000, weeklyRunningCost: 700_000, weeklyRunningCostBasis: 'breakeven' };
  const { weeklyRunningCostBasis, ...untagged } = comm;
  assert.equal(weeklyRunningCostBasis, 'breakeven');
  const off = calculateRecoupment(show, comm, null, weekly, { costBasis: false });
  assert.deepEqual(off, calculateRecoupment(show, untagged, null, weekly));
  const live = calculateRecoupment(show, comm, null, weekly);
  assert.deepEqual(live, calculateRecoupment(show, comm, null, weekly, { costBasis: true }));
  assert.ok(live.recoupmentPctCentral > off.recoupmentPctCentral);
  assert.ok(live.warnings.some((w) => /breakeven: fixed nut/.test(w)));
  // no cost figure: the estimate is untouched
  const { weeklyRunningCost, ...noCost } = comm;
  assert.equal(weeklyRunningCost, 700_000);
  assert.equal(calculateRecoupment(show, noCost, null, weekly).recoupmentPctCentral, calculateRecoupment(show, noCost, null, weekly, { costBasis: false }).recoupmentPctCentral);
});
