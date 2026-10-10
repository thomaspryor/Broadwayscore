// BRO-4989: shadow investor-return model and the owner-approved designation
// rule ("Re trickle. Yes, A"). Tests the real modules via require() (§15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { calculateInvestorReturn } = require('../../scripts/lib/investor-return-model');
const { calculateRecoupment } = require('../../scripts/lib/recoupment-model');
const { proposeDesignation, MODEL_TIEBREAKER } = require('../../scripts/lib/designation-rule');

const NOW = Date.parse('2026-10-01');

/** Weekly grosses for a synthetic run, Sundays from start for n weeks. */
function weeklyGrosses(start, n, gross) {
  const out = {};
  let t = Date.parse(start);
  while (new Date(t).getUTCDay() !== 0) t += 86400000;
  for (let i = 0; i < n; i++, t += 7 * 86400000) out[new Date(t).toISOString().slice(0, 10)] = { gross };
  return out;
}

describe('investor-return model', () => {
  const show = { id: 'test-show', slug: 'test-show', title: 'Test', type: 'musical', openingDate: '2022-01-09', previewsStartDate: '2022-01-09' };
  const weekly = weeklyGrosses('2022-01-09', 230, 1_100_000);
  const comm = {
    capitalization: 2_500_000,
    costHistory: [{ asOf: '2023-01-08', amount: 700_000, kind: 'running-cost', sourceType: 'trade', sourceUrl: 'https://x.test/a' }],
    notes: 'Received SVOG: $10 million.',
  };

  it('an SVOG grant bigger than the capitalization does not blow up the return (the 95,786% bug)', () => {
    const live = calculateRecoupment(show, comm, null, weekly);
    const r = calculateInvestorReturn(show, comm, null, weekly, { now: NOW });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.svogGrant, 10_000_000);
    // Live % divides by (cap - SVOG + reserve), about the reserve fund alone.
    assert.ok(live.recoupmentPctCentral > 1000, `live ${live.recoupmentPctCentral}`);
    // New multiple: investor return over the actual cap, after the 50/50 split.
    const m = r.investorMultipleRange[1];
    const producerMultiple = r.central.producerProfit / comm.capitalization;
    assert.ok(m < producerMultiple, 'investors get half of profit after recoupment');
    assert.ok(m <= 1 + (producerMultiple - 1) / 2 + 0.01, `multiple ${m}`);
  });

  it('reports a range with pessimistic <= central <= optimistic', () => {
    const r = calculateInvestorReturn(show, comm, null, weekly, { now: NOW });
    const [p, c, o] = r.investorMultipleRange;
    assert.ok(p <= c && c <= o, JSON.stringify(r.investorMultipleRange));
  });

  it('flags an implausible multiple', () => {
    const r = calculateInvestorReturn(show, { ...comm, capitalization: 300_000, notes: '' }, null, weekly, { now: NOW });
    assert.ok(r.sanityFlags.length >= 1, JSON.stringify(r.investorMultipleRange));
  });

  it('a flop that never covers costs returns little and does not recoup', () => {
    const flopWeekly = weeklyGrosses('2024-03-03', 12, 400_000);
    const flop = { ...show, openingDate: '2024-03-03', previewsStartDate: '2024-03-03', closingDate: '2024-05-26' };
    const r = calculateInvestorReturn(flop, { capitalization: 15_000_000, costHistory: comm.costHistory }, null, flopWeekly, { now: NOW });
    assert.strictEqual(r.modelRecouped, false);
    assert.ok(r.central.recoupedPct < 30, `${r.central.recoupedPct}`);
  });
});

describe('designation rule', () => {
  const running = { openingDate: '2019-01-01' };
  const decade = { openingDate: '2010-01-01' };
  const model = (pess, central, opt, recouped = true) => ({ investorMultipleRange: [pess, central, opt], modelRecouped: recouped, central: { recoupedPct: 100 }, sanityFlags: [] });

  it('a reported return wins: Harry Potter 1.06x is Trickle whatever the model says', () => {
    const r = proposeDesignation({ record: { designation: 'Trickle', recouped: true, investorMultiple: 1.06 }, show: running, model: model(1.9, 2.4, 2.8), now: NOW });
    assert.strictEqual(r.designation, 'Trickle');
    assert.strictEqual(r.basis, 'reported');
    assert.strictEqual(r.changed, false);
  });

  it('model-only moves are off by default: no change, not even a proposal', () => {
    assert.strictEqual(MODEL_TIEBREAKER, false);
    const r = proposeDesignation({ record: { designation: 'Windfall', recouped: true }, show: running, model: model(1.1, 1.2, 1.3), now: NOW });
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.basis, 'no-evidence');
    const closedTbd = proposeDesignation({ record: { designation: 'TBD' }, show: { openingDate: '2019-01-01', closingDate: '2020-01-01' }, model: model(0, 0.2, 0.4, false), now: NOW });
    assert.strictEqual(closedTbd.changed, false);
  });

  it('a reported figure near a line is low confidence', () => {
    const closed = { openingDate: '2019-01-01', closingDate: '2020-01-01' };
    assert.strictEqual(proposeDesignation({ record: { designation: 'TBD', recouped: false, estimatedRecoupmentPct: [85, 93] }, show: closed, model: null, now: NOW }).confidence, 'low');
    assert.strictEqual(proposeDesignation({ record: { designation: 'TBD', recouped: false, estimatedRecoupmentPct: [0, 10] }, show: closed, model: null, now: NOW }).confidence, 'normal');
    assert.strictEqual(proposeDesignation({ record: { designation: 'TBD', recouped: true, investorMultiple: 1.05 }, show: running, model: null, now: NOW }).confidence, 'low');
  });

  // With the tiebreaker switched on (a later, separately reviewed change):
  const on = { modelTiebreaker: true };
  it('tiebreaker on: recouped under 1.5x is Trickle; 1.5x or more is Windfall', () => {
    assert.strictEqual(proposeDesignation({ record: { designation: 'Windfall', recouped: true }, show: running, model: model(1.1, 1.2, 1.3), now: NOW, ...on }).designation, 'Trickle');
    assert.strictEqual(proposeDesignation({ record: { designation: 'Trickle', recouped: true }, show: running, model: model(1.8, 2.2, 2.6), now: NOW, ...on }).designation, 'Windfall');
  });

  it('tiebreaker on: keeps the current designation when the model range straddles 1.5x', () => {
    const r = proposeDesignation({ record: { designation: 'Windfall', recouped: true }, show: running, model: model(1.2, 1.45, 1.7), now: NOW, ...on });
    assert.strictEqual(r.designation, 'Windfall');
    assert.strictEqual(r.basis, 'model-uncertain');
  });

  it('decade-plus Miracles stay Miracle; Easy Winner and Nonprofit are untouched', () => {
    assert.strictEqual(proposeDesignation({ record: { designation: 'Miracle', recouped: true }, show: decade, model: model(1.1, 1.2, 1.3), now: NOW }).designation, 'Miracle');
    assert.strictEqual(proposeDesignation({ record: { designation: 'Easy Winner', recouped: true }, show: running, model: model(1.1, 1.2, 1.3), now: NOW }).designation, 'Easy Winner');
    assert.strictEqual(proposeDesignation({ record: { designation: 'Nonprofit' }, show: running, model: null, now: NOW }).designation, 'Nonprofit');
  });

  it('a model with a sanity flag is not used', () => {
    const flagged = { ...model(80, 90, 100), sanityFlags: ['too big'] };
    const r = proposeDesignation({ record: { designation: 'Trickle', recouped: true }, show: running, model: flagged, now: NOW, ...on });
    assert.strictEqual(r.changed, false);
  });

  it('a running unrecouped show is never moved', () => {
    const r = proposeDesignation({ record: { designation: 'TBD', recouped: false }, show: running, model: model(0, 0.4, 0.8, false), now: NOW });
    assert.strictEqual(r.changed, false);
  });
});
