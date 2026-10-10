// Model "% returned" display guard (BRO-4989 checker #5). require()s the real
// helper (§15); the site imports the same file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { modelDisplayGuard, displaysModel, playedWeeks, reportedRange } = require('../../scripts/lib/model-display-guard');

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
  test('more than 25 points outside a reported range is hidden', () => {
    assert.equal(modelDisplayGuard({ pct: [38, 90, 133], playedWeeks: 85, reported: [10, 30] }).reason, 'off-report');
    assert.equal(modelDisplayGuard({ pct: [0, 55, 90], playedWeeks: 85, reported: [10, 30] }).show, true);
    assert.equal(modelDisplayGuard({ pct: [0, 0, 10], playedWeeks: 85, reported: [30, 40] }).show, false);
  });
  test('negative values display as 0 and flag below-costs', () => {
    const g = modelDisplayGuard({ pct: [-42, -3, 33], playedWeeks: 49 });
    assert.deepEqual(g, { show: true, reason: null, shown: [0, 0, 33], belowCosts: true });
    assert.equal(modelDisplayGuard({ pct: [-3, 64, 120], playedWeeks: 132 }).belowCosts, false);
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
  test('reportedRange ignores our own inference and bad shapes', () => {
    assert.deepEqual(reportedRange({ estimatedRecoupmentPct: [30, 10], estimatedRecoupmentSource: 'Reddit analysis' }), [10, 30]);
    assert.equal(reportedRange({ estimatedRecoupmentPct: [70, 85], estimatedRecoupmentSource: 'Estimated: ~$24M cumulative' }), null);
    assert.equal(reportedRange({ estimatedRecoupmentPct: [70, 85] }), null);
    assert.equal(reportedRange({ estimatedRecoupmentPct: [70], estimatedRecoupmentSource: 'x' }), null);
    assert.equal(reportedRange(null), null);
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
    assert.equal(displaysModel({ modelRecoupmentPct: pct, designation: 'TBD' }, { status: 'closed' }), true);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, designation: 'Nonprofit' }, { status: 'open' }), false);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, modelDataQuality: 'low' }, { status: 'open' }), false);
    assert.equal(displaysModel({ modelRecoupmentPct: pct, modelMethod: 'ai-estimated' }, { status: 'open' }), false);
    assert.equal(displaysModel({}, { status: 'open' }), false);
    assert.equal(displaysModel(null, { status: 'open' }), false);
  });
});
