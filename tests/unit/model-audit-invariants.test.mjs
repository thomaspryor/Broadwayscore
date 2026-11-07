// Launch audit model invariants (BRO-6217 M01-M04). require()s the real
// helpers (§15). M05 (reserve added on top of a capitalization) stays shadow:
// no record says its raise budgets a reserve, and dropping the reserve made
// the timing backtest worse (recoupment-model.js ALL_LIVE_OPTS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildWeeklySchedule, calculateRecoupment, calcWeeklyProfit, getBaseVariableRate, THEATER_DEAL } = require('../../scripts/lib/recoupment-model');
const { breakEvenRatio, fixedNutFromBasis } = require('../../scripts/lib/cost-split');
const { legacyCostAnchor, withCurrentLegacyTier } = require('../../scripts/lib/cost-history');
const { costForWeek } = require('../../scripts/lib/cost-for-week');

const sum = (s) => s.reduce((a, w) => a + w.gross, 0);

test('M01: an all-time gross spread over the run sums back to that gross', () => {
  const show = { slug: 'x', type: 'musical' };
  for (const [previews, weeks] of [[4, 40], [6, 120], [0, 30], [3, 3]]) {
    const s = buildWeeklySchedule(show, { gross: 50_000_000, performances: weeks * 8 }, null, previews, weeks, []);
    assert.equal(s.length, weeks, `${previews}/${weeks} weeks`);
    assert.ok(Math.abs(sum(s) - 50_000_000) < 1, `${previews}/${weeks}: ${sum(s)}`);
    if (previews && weeks > previews) assert.ok(s[0].gross < s[weeks - 1].gross, 'previews still ramp');
  }
  // decontaminated: the weeks sum to the cleaned total
  const warnings = [];
  const s = buildWeeklySchedule(show, { gross: 60_000_000, performances: 40 * 8 * 2 }, null, 4, 40, warnings);
  assert.ok(warnings.some((w) => /decontaminated/.test(w)));
  assert.ok(Math.abs(sum(s) - 30_000_000) < 1, String(sum(s)));
});

test('M04: the break-even gross makes zero profit in the model week', () => {
  const v = getBaseVariableRate('special');
  for (const nut of [300_000, 561_798, 1_000_000]) {
    const be = nut * breakEvenRatio(v, THEATER_DEAL);
    const { profit } = calcWeeklyProfit(be, nut, v, false, 27, false, null, 52, 'special', 'special');
    assert.ok(Math.abs(profit) < 1, `nut ${nut}: profit ${profit} at ${be}`);
  }
  // below the theater breakpoint the rent is already in the nut
  assert.equal(breakEvenRatio(0.11, THEATER_DEAL), 1 / 0.89);
  // above it the percentage branch applies: G - vG - (pG - rN) - N = 0
  const T = { pctOfGross: 0.2, rentPctOfNut: 0.12 };
  const r = breakEvenRatio(0.11, T);
  assert.ok(Math.abs(r - 0.11 * r - (T.pctOfGross * r - T.rentPctOfNut) - 1) < 1e-12);
  // $500K nut: the old closed form read $536,585
  assert.equal(Math.round(500_000 * breakEvenRatio(0.11, THEATER_DEAL)), 561_798);
  // a breakeven-typed figure inverts to the nut whose break-even it is
  const fx = fixedNutFromBasis({ weeklyRunningCost: 800_000, weeklyRunningCostBasis: 'breakeven' }, 800_000, 0.11, THEATER_DEAL);
  assert.ok(Math.abs(fx.nut * breakEvenRatio(0.11, THEATER_DEAL) - 800_000) < 1e-6);
});

test('M04: calculateRecoupment reports the gross its own week breaks even at', () => {
  const WEEK = 7 * 86400000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const first = Date.now() - 40 * WEEK;
  const weekly = {};
  for (let i = 0; i < 39; i++) weekly[iso(first + (i + 0.5) * WEEK)] = { gross: 700_000, performances: 8 };
  const show = { slug: 'x', title: 'X', type: 'special', previewsStartDate: iso(first), openingDate: iso(first + 2 * WEEK) };
  const r = calculateRecoupment(show, { capitalization: 5_000_000, weeklyRunningCost: 500_000 }, null, weekly);
  const v = getBaseVariableRate('special');
  const { profit } = calcWeeklyProfit(r.weeklyBreakeven, r.weeklyFixedCosts, v, false, 27, false, null, 52, 'special', 'special');
  assert.ok(Math.abs(profit) < 2, `profit ${profit} at ${r.weeklyBreakeven}`);
});

test('M03: a typed cost basis survives the legacy anchor and the stored copy', () => {
  const show = { openingDate: '2024-03-21' };
  const be = { weeklyRunningCost: 960_000, weeklyRunningCostBasis: 'breakeven', costMethodology: 'trade-reported', weeklyRunningCostSource: 'Broadway Journal (Nov 6, 2023)' };
  assert.equal(legacyCostAnchor(be, show).kind, 'break-even');
  const allIn = { ...be, weeklyRunningCostBasis: 'all-in' };
  assert.equal(legacyCostAnchor(allIn, show).kind, 'running-cost');
  assert.equal(legacyCostAnchor(allIn, show).basis, 'all-in');
  assert.equal(legacyCostAnchor({ ...be, weeklyRunningCostBasis: 'running' }, show).basis, undefined);
  // a stored migrated copy takes the record's current type
  const stored = [{ asOf: '2024-03-21', amount: 960_000, kind: 'running-cost', sourceType: 'trade', dateBasis: 'migrated' }];
  assert.equal(withCurrentLegacyTier(stored, be)[0].kind, 'break-even');
  assert.equal(withCurrentLegacyTier(stored, allIn)[0].basis, 'all-in');
  assert.equal(withCurrentLegacyTier(stored, { ...be, weeklyRunningCost: 900_000 })[0].kind, 'running-cost', 'a stale copy is left alone');
});

test('M03: the model charges the nut behind a break-even figure, not the figure', () => {
  // Water for Elephants: a $960K break-even anchor beside its migrated copy
  const record = {
    weeklyRunningCost: 960_000,
    weeklyRunningCostBasis: 'breakeven',
    costMethodology: 'trade-reported',
    costHistory: [
      { asOf: '2024-03-21', amount: 960_000, kind: 'break-even', sourceType: 'trade' },
      { asOf: '2024-03-21', amount: 960_000, kind: 'running-cost', sourceType: 'trade', dateBasis: 'migrated' },
    ],
  };
  const cw = costForWeek(record, '2024-03-21', { show: { openingDate: '2024-03-21' }, category: 'musical' });
  const nut = 960_000 / breakEvenRatio(getBaseVariableRate('musical'), THEATER_DEAL);
  assert.ok(Math.abs(cw.cost - nut) < 1, `cost ${cw.cost}, nut ${nut}`);
  assert.ok(Math.abs(cw.breakEven - 960_000) < 1, `breakEven ${cw.breakEven}`);
});

test('M02: real pre-opening rows are the previews for plays too', () => {
  const WEEK = 7 * 86400000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const first = Date.now() - 40 * WEEK;
  const weekly = {};
  for (let i = 0; i < 39; i++) weekly[iso(first + (i + 0.5) * WEEK)] = { gross: 600_000, performances: 8 };
  const show = { slug: 'x', title: 'X', type: 'play', previewsStartDate: iso(first), openingDate: iso(first + 4 * WEEK) };
  const comm = { capitalization: 5_000_000, weeklyRunningCost: 400_000 };
  const live = calculateRecoupment(show, comm, null, weekly);
  const old = calculateRecoupment(show, comm, null, weekly, { previewsFromWeekly: false });
  assert.ok(live.recoupmentPctCentral > old.recoupmentPctCentral, `${live.recoupmentPctCentral} vs ${old.recoupmentPctCentral}`);
});
