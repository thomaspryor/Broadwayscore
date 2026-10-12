// Model "% returned" display guard (BRO-4989 checker #5). require()s the real
// helper (§15); the site imports the same file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { modelDisplayGuard, displayBasis, displaysModel, playedWeeks, independentEstimate, isRunning, RUNNING_MODEL_BAR_ENABLED, RUNNING_MODEL_BAR_TYPES } = require('../../scripts/lib/model-display-guard');

describe('modelDisplayGuard', () => {
  test('Schmigadoon -169 is hidden, not printed', () => {
    assert.equal(modelDisplayGuard({ pct: [-191.2, -169.3, -148.1], playedWeeks: 27 }).reason, 'out-of-bounds');
    assert.equal(modelDisplayGuard({ pct: [100, 151, 200], playedWeeks: 27 }).reason, 'out-of-bounds');
  });
  test('bounds are inclusive at -25 and 150', () => {
    assert.equal(modelDisplayGuard({ pct: [-40, -25, 0], playedWeeks: 20 }).show, true);
    assert.equal(modelDisplayGuard({ pct: [120, 150, 170], playedWeeks: 20 }).show, true);
  });
  test('fewer than 12 played weeks is hidden', () => {
    assert.equal(modelDisplayGuard({ pct: [10, 20, 30], playedWeeks: 11 }).reason, 'few-weeks');
    assert.equal(modelDisplayGuard({ pct: [10, 20, 30], playedWeeks: 12 }).show, true);
    assert.equal(modelDisplayGuard({ pct: [10, 20, 30], playedWeeks: NaN }).reason, 'few-weeks');
  });
  test('two independent estimates more than 25 points apart: hidden', () => {
    assert.equal(modelDisplayGuard({ pct: [38, 90, 133], playedWeeks: 85, independent: [10, 30] }).reason, 'estimates-disagree');
    assert.equal(modelDisplayGuard({ pct: [30, 55, 80], playedWeeks: 85, independent: [10, 30] }).show, true);
    assert.equal(modelDisplayGuard({ pct: [0, 0, 10], playedWeeks: 85, independent: [30, 40] }).show, false);
  });
  test('negative values display as 0 and flag below-costs', () => {
    const g = modelDisplayGuard({ pct: [-20, -3, 15], playedWeeks: 49 });
    assert.deepEqual(g, { show: true, reason: null, shown: [0, 0, 15], belowCosts: true });
    assert.equal(modelDisplayGuard({ pct: [30, 64, 85], playedWeeks: 132 }).belowCosts, false);
  });
  test('a range more than 60 points wide is too uncertain to print', () => {
    // Gatsby today: one 64% over a -3..120 range overclaims.
    assert.equal(modelDisplayGuard({ pct: [-2.7, 63.6, 120.1], playedWeeks: 132 }).reason, 'too-uncertain');
    assert.equal(modelDisplayGuard({ pct: [-42, -3, 33], playedWeeks: 49 }).reason, 'too-uncertain');
    assert.equal(modelDisplayGuard({ pct: [10, 40, 70], playedWeeks: 49 }).show, true);
    assert.equal(modelDisplayGuard({ pct: [10, 40, 70.1], playedWeeks: 49 }).reason, 'too-uncertain');
    // A disagreement is the more useful reason when both hold.
    assert.equal(modelDisplayGuard({ pct: [38, 90, 133], playedWeeks: 85, independent: [10, 30] }).reason, 'estimates-disagree');
  });
  test('a running show is held while the launch switch is off; other reasons win', () => {
    assert.equal(modelDisplayGuard({ pct: [-14, 1, 14], playedWeeks: 28, running: true, runningEnabled: false }).reason, 'awaiting-truth');
    assert.equal(modelDisplayGuard({ pct: [-14, 1, 14], playedWeeks: 28, running: true, runningEnabled: true }).show, true);
    assert.equal(modelDisplayGuard({ pct: [-14, 1, 14], playedWeeks: 28, running: false }).show, true);
    assert.equal(modelDisplayGuard({ pct: [-14, 1, 14], playedWeeks: 5, running: true, runningEnabled: false }).reason, 'few-weeks');
  });
  test('a running show never prints 100%+ before it announces recoupment (BRO-5073)', () => {
    const on = { playedWeeks: 69, running: true, runningEnabled: true };
    assert.equal(modelDisplayGuard({ ...on, pct: [130, 144, 150] }).reason, 'estimated-recouped');
    assert.equal(modelDisplayGuard({ ...on, pct: [95, 100, 110] }).reason, 'past-100-unannounced');
    // low end at 100%+: "Estimated to have recouped, not yet announced" (owner, BRO-5073)
    assert.equal(modelDisplayGuard({ ...on, pct: [100, 120, 140] }).reason, 'estimated-recouped');
    assert.equal(modelDisplayGuard({ ...on, pct: [99.5, 120, 140] }).reason, 'past-100-unannounced');
    // still out of bounds above 150 central
    assert.equal(modelDisplayGuard({ ...on, pct: [120, 155, 180] }).reason, 'out-of-bounds');
    assert.deepEqual(modelDisplayGuard({ ...on, pct: [80, 92, 110] }).shown, [80, 92, 99]);
    // the launch switch still wins while it is off; a closed show is unaffected
    assert.equal(modelDisplayGuard({ ...on, runningEnabled: false, pct: [130, 144, 150] }).reason, 'awaiting-truth');
    assert.deepEqual(modelDisplayGuard({ ...on, running: false, pct: [80, 92, 110] }).shown, [80, 92, 110]);
  });
  test('per-type running switch: on for plays only (owner, 2026-10-11, BRO-5073)', () => {
    assert.equal(RUNNING_MODEL_BAR_ENABLED, true);
    assert.deepEqual(RUNNING_MODEL_BAR_TYPES, ['play']);
    const on = { pct: [40, 55, 70], playedWeeks: 30, running: true, runningEnabled: true };
    assert.equal(modelDisplayGuard({ ...on, showType: 'play' }).show, true);
    assert.equal(modelDisplayGuard({ ...on, showType: 'musical' }).reason, 'awaiting-truth');
    assert.equal(modelDisplayGuard({ ...on, showType: null }).reason, 'awaiting-truth');
    assert.equal(modelDisplayGuard({ ...on, showType: 'musical', runningTypes: ['play', 'musical'] }).show, true);
    // flag off: plays are held too; closed shows ignore the switch
    assert.equal(modelDisplayGuard({ ...on, runningEnabled: false, showType: 'play' }).reason, 'awaiting-truth');
    assert.equal(modelDisplayGuard({ ...on, running: false, showType: 'musical' }).show, true);
  });
  test('isRunning: open, or closing date still ahead', () => {
    const now = new Date('2026-10-10');
    assert.equal(isRunning({ status: 'open' }, now), true);
    assert.equal(isRunning({ status: 'open', closingDate: '2027-01-03' }, now), true);
    assert.equal(isRunning({ status: 'open', closingDate: '2026-10-01' }, now), false);
    assert.equal(isRunning({ status: 'closed' }, now), false);
    assert.equal(isRunning(undefined, now), false);
  });
  test('missing or malformed model is no-model', () => {
    for (const pct of [null, undefined, [1, 2], [1, NaN, 3], 'x']) assert.equal(modelDisplayGuard({ pct, playedWeeks: 50 }).reason, 'no-model');
  });
});

describe('inputs', () => {
  test('playedWeeks counts from first preview to today, never past it', () => {
    const now = new Date('2026-10-10');
    assert.equal(playedWeeks({ previewsStartDate: '2026-07-11', closingDate: '2027-01-01' }, now), 13);
    assert.equal(playedWeeks({ openingDate: '2026-07-11' }, now), 13);
    assert.equal(playedWeeks({}, now), 0);
    assert.equal(playedWeeks({ previewsStartDate: '2026-12-01' }, now), 0);
  });
  test('independentEstimate counts a Reddit range, ignores our own inference and bad shapes', () => {
    assert.deepEqual(independentEstimate({ estimatedRecoupmentPct: [30, 10], estimatedRecoupmentSource: 'Reddit analysis' }), [10, 30]);
    assert.equal(independentEstimate({ estimatedRecoupmentPct: [70, 85], estimatedRecoupmentSource: 'Estimated: ~$24M cumulative' }), null);
    assert.equal(independentEstimate({ estimatedRecoupmentPct: [70, 85] }), null);
    // Notes stand in only when they state the money returned or lost (checker (c)).
    assert.deepEqual(independentEstimate({ estimatedRecoupmentPct: [55, 65], notes: 'Producer J.J. Powell confirmed $6M loss (~40% of cap).' }), [55, 65]);
    assert.equal(independentEstimate({ estimatedRecoupmentPct: [20, 30], notes: 'No trade report of the capitalization. Avg 61.6% capacity made recoupment impossible.' }), null);
    assert.equal(independentEstimate({ estimatedRecoupmentPct: [10, 20], notes: 'Produced by two investors only.' }), null);
    assert.equal(independentEstimate({ estimatedRecoupmentPct: [70], estimatedRecoupmentSource: 'x' }), null);
    assert.equal(independentEstimate(null), null);
  });
});

describe('displaysModel (mirrors getRecoupmentDisplayMode === "model")', () => {
  const pct = [10, 20, 30];
  test('shows a running record with a good model', () => {
    assert.equal(displaysModel({ modelRecoupmentPct: pct }, { status: 'open' }), true);
  });
  test('announced, final closed, nonprofit, low quality and ai-estimated do not', () => {
    assert.equal(displaysModel({ modelRecoupmentPct: pct, recouped: true }, { status: 'open' }), false);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, designation: 'Flop' }, { status: 'closed' }), false);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, designation: 'TBD' }, { status: 'closed' }), false); // BRO-5020
    assert.equal(displaysModel({ modelRecoupmentPct: pct, designation: 'TBD' }, { status: 'open' }), true);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, designation: 'Nonprofit' }, { status: 'open' }), false);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, modelDataQuality: 'low' }, { status: 'open' }), false);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, modelMethod: 'ai-estimated' }, { status: 'open' }), false);
    assert.equal(displaysModel({}, { status: 'open' }), false);
    assert.equal(displaysModel(null, { status: 'open' }), false);
  });
});

test('displayBasis: running shows use the pre-credit figure once running bars are on (BRO-5073)', () => {
  const pct = [80, 90, 100];
  const ex = [60, 70, 80];
  // Bar off: live figure, no basis.
  assert.deepEqual(displayBasis({ pct, exCreditPct: ex, creditCounted: 0, running: true, runningEnabled: false }), { pct, creditBasis: null });
  assert.deepEqual(displayBasis({ pct, exCreditPct: ex, creditCounted: 0, running: true, runningEnabled: true }), { pct: ex, creditBasis: 'pre-credit' });
  assert.deepEqual(displayBasis({ pct, exCreditPct: ex, creditCounted: 3e6, running: true, runningEnabled: true }), { pct: ex, creditBasis: 'post-credit' });
  // Closed shows and records without the run keep the live figure.
  assert.deepEqual(displayBasis({ pct, exCreditPct: ex, running: false, runningEnabled: true }), { pct, creditBasis: null });
  assert.deepEqual(displayBasis({ pct, exCreditPct: null, running: true, runningEnabled: true }), { pct, creditBasis: null });
  // A stale run without the counted field: pre-credit figure, basis not claimed.
  assert.deepEqual(displayBasis({ pct, exCreditPct: ex, running: true, runningEnabled: true }), { pct: ex, creditBasis: null });
});
