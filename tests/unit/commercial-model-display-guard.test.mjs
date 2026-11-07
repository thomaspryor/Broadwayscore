/**
 * Site side of the model display guard (BRO-4989 checker #5): the guarded
 * copy every page reads, the below-costs copy, and parity between the
 * scripts mirror (displaysModel) and getRecoupmentDisplayMode. Runs in the
 * tsx batch; imports src TS directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { displaysModel, displaysAnalyst } = require('../../scripts/lib/model-display-guard');
const {
  applyModelDisplayGuard,
  getAtRiskModelRange,
  getRecoupmentDisplayMode,
  getModelRecoupmentLabels,
  getModelHoldLabel,
  toPublicShowCommercial,
} = await import('../../src/lib/commercial-display.ts');

const now = new Date('2026-10-10');
const running = { previewsStartDate: '2025-10-01', openingDate: '2025-11-01' }; // ~53 weeks played
// Closed play with designation TBD: the bar still shows, and the running-show
// launch switch does not apply, so the shown-copy tests use it.
const closedTbd = { ...running, closingDate: '2026-10-01', status: 'closed', type: 'play' };
const rec = (over) => ({ designation: 'TBD', recouped: null, modelMethod: 'weekly-model', modelDataQuality: 'medium', ...over });

test('Schmigadoon -169 is hidden: no number reaches the page', () => {
  const out = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-191, -169, -148] }), running, now);
  assert.equal(out.modelRecoupmentPct, null);
  assert.equal(out.modelDisplayHold, 'out-of-bounds');
  assert.equal(getRecoupmentDisplayMode({ ...out, status: 'open' }), 'none');
  // ...but it stays on the At Risk list, judged as 0% (no negative number).
  assert.equal(out.modelBelowCosts, true);
  assert.deepEqual(getAtRiskModelRange({ ...out, status: 'open' }), [0, 0, 0]);
  assert.equal(getAtRiskModelRange({ ...out, status: 'open', recouped: true }), null);
  const high = applyModelDisplayGuard(rec({ modelRecoupmentPct: [140, 180, 220] }), running, now);
  assert.equal(high.modelBelowCosts, undefined);
  // Held above 150: judged by its held range, which keeps it off At Risk (optimistic >= 30).
  assert.deepEqual(getAtRiskModelRange({ ...high, status: 'open' }), [140, 180, 220]);
});

test('a hidden flop stays on At Risk: too few weeks or estimates disagree', () => {
  const young = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-12, 4, 18] }), { previewsStartDate: '2026-08-20', openingDate: '2026-09-15' }, now);
  assert.equal(young.modelDisplayHold, 'few-weeks');
  assert.deepEqual(getAtRiskModelRange({ ...young, status: 'open' }), [0, 4, 18]);
  assert.equal(getModelHoldLabel({ ...young, status: 'open' }), 'Too early to estimate');
  const split = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-5, 10, 20], estimatedRecoupmentPct: [60, 70], estimatedRecoupmentSource: 'Variety: about two thirds recouped' }), running, now);
  assert.equal(split.modelDisplayHold, 'estimates-disagree');
  assert.deepEqual(getAtRiskModelRange({ ...split, status: 'open' }), [0, 10, 20]);
  // Settled, nonprofit or under the quality floor: never.
  assert.equal(getAtRiskModelRange({ ...young, status: 'closed', designation: 'Flop' }), null);
  assert.equal(getAtRiskModelRange({ ...young, status: 'open', designation: 'Nonprofit' }), null);
  assert.equal(getAtRiskModelRange({ ...young, status: 'open', modelMethod: 'ai-estimated' }), null);
  // The held range is server-only; a page gets only the central figure the
  // analyst + model range uses (publicHeldRange), never a few-weeks hold's.
  assert.equal('modelHeldRange' in toPublicShowCommercial(young), false);
  assert.deepEqual(toPublicShowCommercial(split).modelHeldRange, [10, 10, 10]);
});

test('a small negative shows as 0% returned, losing money so far', () => {
  const out = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-20, -3, 15] }), closedTbd, now);
  assert.deepEqual(out.modelRecoupmentPct, [0, 0, 15]);
  assert.equal(out.modelBelowCosts, true);
  const l = getModelRecoupmentLabels(out.modelRecoupmentPct, { belowCosts: true });
  assert.equal(l.label, '0% returned · losing money so far');
  assert.equal(l.belowCostsNote, 'losing money so far');
  assert.ok(!/-\d/.test(l.ariaLabel));
});

test('fewer than 12 played weeks, or two independent estimates >25 apart, are hidden', () => {
  const early = { previewsStartDate: '2026-08-15' };
  assert.equal(applyModelDisplayGuard(rec({ modelRecoupmentPct: [10, 20, 30] }), early, now).modelDisplayHold, 'few-weeks');
  const bvsc = rec({ modelRecoupmentPct: [38, 90, 133], estimatedRecoupmentPct: [10, 30], estimatedRecoupmentSource: 'Reddit grosses analysis' });
  assert.equal(applyModelDisplayGuard(bvsc, running, now).modelDisplayHold, 'estimates-disagree');
  assert.equal(applyModelDisplayGuard(rec({ modelRecoupmentPct: [10, 20, 30] }), undefined, now).modelDisplayHold, 'few-weeks');
});

test('a normal record passes through unchanged; no model is untouched', () => {
  const ok = rec({ modelRecoupmentPct: [40, 60, 80] });
  assert.deepEqual(applyModelDisplayGuard(ok, closedTbd, now), ok);
  const none = rec({ modelRecoupmentPct: null });
  assert.equal(applyModelDisplayGuard(none, running, now), none);
  assert.equal(getModelRecoupmentLabels([40, 60, 80]).belowCostsNote, null);
});

test('displaysModel mirrors getRecoupmentDisplayMode === "model"', () => {
  const pct = [10, 20, 30];
  const cases = [];
  for (const recouped of [true, false, null])
    for (const designation of ['TBD', 'Flop', 'Nonprofit', undefined])
      for (const status of ['open', 'closed'])
        for (const modelDataQuality of ['high', 'low'])
          for (const modelMethod of ['weekly-model', 'ai-estimated'])
            for (const modelRecoupmentPct of [pct, null])
              for (const productionType of [undefined, 'enhancement'])
                for (const analystRecoupPct of [undefined, [0, 0]])
                  cases.push({ recouped, designation, status, modelDataQuality, modelMethod, modelRecoupmentPct, productionType, analystRecoupPct });
  for (const c of cases) {
    const { status, ...comm } = c;
    assert.equal(displaysModel(comm, { status }), getRecoupmentDisplayMode(c) === 'model', JSON.stringify(c));
    assert.equal(displaysAnalyst(comm, { status }), getRecoupmentDisplayMode(c) === 'analyst', JSON.stringify(c));
  }
});

// The show page reads the public copy (toPublicShowCommercial, a field
// whitelist): every guard output must survive it, or the show-page bar
// shows "~0%" without "losing money so far" (found in visual QA).
test('guard outputs survive the public field filter', () => {
  const below = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-40, -18, 10] }), closedTbd, now);
  assert.equal(below.modelBelowCosts, true);
  const pub = toPublicShowCommercial(below);
  assert.equal(pub.modelBelowCosts, true);
  assert.deepEqual(pub.modelRecoupmentPct, below.modelRecoupmentPct);
  const hidden = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-191, -169, -148] }), running, now);
  assert.equal(toPublicShowCommercial(hidden).modelDisplayHold, 'out-of-bounds');
  assert.equal(toPublicShowCommercial(rec({ modelRecoupmentPct: [10, 40, 70] })).modelBelowCosts, undefined);
});

test('held model says why, never on a settled or untrusted record', () => {
  const base = { recouped: null, designation: 'TBD', status: 'open', modelMethod: 'weekly-model', modelDataQuality: 'medium' };
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks' }), 'Too early to estimate');
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'estimates-disagree' }), 'Estimates disagree');
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'too-uncertain' }), 'Too uncertain to estimate');
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'past-100-unannounced' }), 'Recoupment not announced');
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'out-of-bounds' }), 'Estimate unavailable');
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'out-of-bounds', modelBelowCosts: true }), 'Losing money so far');
  assert.equal(getModelHoldLabel({ ...base }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'no-model' }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', recouped: true }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', status: 'closed', designation: 'Flop' }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', designation: 'Nonprofit' }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', modelMethod: 'ai-estimated' }), null);
});

test('BRO-5020: a closed run is never "too early"', () => {
  const closed = { recouped: null, designation: 'TBD', status: 'closed', modelMethod: 'weekly-model', modelDataQuality: 'medium' };
  assert.equal(getModelHoldLabel({ ...closed, modelDisplayHold: 'few-weeks' }), 'Not enough data to estimate');
  assert.equal(getModelHoldLabel({ ...closed, modelDisplayHold: 'too-uncertain' }), 'Too uncertain to estimate');
});

test('the guard output feeds the hold label end to end', () => {
  const held = applyModelDisplayGuard(
    { recouped: null, designation: 'TBD', modelMethod: 'weekly-model', modelDataQuality: 'medium', modelRecoupmentPct: [-200, -169, -140] },
    { openingDate: '2025-01-01' },
    new Date('2026-10-01')
  );
  assert.equal(held.modelRecoupmentPct, null);
  assert.equal(getModelHoldLabel({ ...toPublicShowCommercial(held), status: 'open' }), 'Losing money so far');
});

// Launch (owner, 2026-10-11, BRO-5073): the running bar is on for plays, and
// for musicals since BRO-5872. A held type (a solo show) still says "Not
// enough reported data yet"; a running play or musical prints the estimate,
// capped at 99.
test('running bar: plays and musicals print an estimate, solo shows stay held', () => {
  const { RUNNING_MODEL_BAR_ENABLED, RUNNING_MODEL_BAR_TYPES } = require('../../scripts/lib/model-display-guard');
  assert.equal(RUNNING_MODEL_BAR_ENABLED, true);
  assert.deepEqual(RUNNING_MODEL_BAR_TYPES, ['play', 'musical']);
  const lostBoys = rec({ modelRecoupmentPct: [-13.9, 0.5, 14] });
  const musical = applyModelDisplayGuard(lostBoys, { ...running, type: 'musical' }, now);
  assert.deepEqual(musical.modelRecoupmentPct, [0, 0.5, 14]);
  assert.equal(getRecoupmentDisplayMode({ ...musical, status: 'open' }), 'model');
  const solo = applyModelDisplayGuard(lostBoys, { ...running, type: 'special' }, now);
  assert.equal(solo.modelRecoupmentPct, null);
  assert.equal(solo.modelDisplayHold, 'awaiting-truth');
  assert.equal(getRecoupmentDisplayMode(solo), 'none');
  assert.equal(getModelHoldLabel({ ...solo, status: 'open' }), 'Not enough reported data yet');
  // A running play prints; a closing date still ahead is running too.
  const play = { ...running, type: 'play' };
  assert.deepEqual(applyModelDisplayGuard(rec({ modelRecoupmentPct: [40, 55, 70] }), play, now).modelRecoupmentPct, [40, 55, 70]);
  const closingLater = { ...play, closingDate: '2027-01-03', status: 'open' };
  assert.deepEqual(applyModelDisplayGuard(rec({ modelRecoupmentPct: [80, 92, 110] }), closingLater, now).modelRecoupmentPct, [80, 92, 99]);
  // Low end at 100%+: the estimated-recouped line, never a 100%+ bar.
  const ahead = applyModelDisplayGuard(rec({ modelRecoupmentPct: [105, 120, 140] }), play, now);
  assert.equal(ahead.modelRecoupmentPct, null);
  assert.equal(getModelHoldLabel({ ...ahead, status: 'open' }), 'Estimated to have recouped, not yet announced');
  const near = applyModelDisplayGuard(rec({ modelRecoupmentPct: [90, 104, 118] }), play, now);
  assert.equal(getModelHoldLabel({ ...near, status: 'open' }), 'Recoupment not announced');
  // Closed and recouped displays are unaffected.
  assert.deepEqual(applyModelDisplayGuard(lostBoys, closedTbd, now).modelRecoupmentPct, [0, 0.5, 14]);
  const recouped = rec({ recouped: true, designation: 'Windfall', modelRecoupmentPct: [90, 110, 130] });
  assert.notEqual(getRecoupmentDisplayMode(applyModelDisplayGuard(recouped, play, now)), 'model');
  assert.equal(getModelHoldLabel({ ...applyModelDisplayGuard(recouped, play, now), status: 'open' }), null);
});

test('running shows are judged on the pre-credit figure now the bar is on (BRO-5073)', () => {
  const out = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-12, 4, 18], modelReturnedExCreditPct: [-10, 2, 14], modelTaxCreditCounted: 0 }), { ...running, type: 'play' }, now);
  assert.deepEqual(out.modelRecoupmentPct, [0, 2, 14]);
  assert.equal(out.modelCreditBasis, 'pre-credit');
  // closed shows keep the live figure
  assert.deepEqual(applyModelDisplayGuard(rec({ modelRecoupmentPct: [10, 20, 30], modelReturnedExCreditPct: [0, 5, 10] }), closedTbd, now).modelRecoupmentPct, [10, 20, 30]);
});
