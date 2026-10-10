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
const { displaysModel } = require('../../scripts/lib/model-display-guard');
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
  // The held range is server-only.
  assert.equal('modelHeldRange' in toPublicShowCommercial(young), false);
});

test('a small negative shows as 0% returned, losing money so far', () => {
  const out = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-42, -3, 33] }), running, now);
  assert.deepEqual(out.modelRecoupmentPct, [0, 0, 33]);
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
  assert.deepEqual(applyModelDisplayGuard(ok, running, now), ok);
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
              cases.push({ recouped, designation, status, modelDataQuality, modelMethod, modelRecoupmentPct });
  for (const c of cases) {
    const { status, ...comm } = c;
    assert.equal(displaysModel(comm, { status }), getRecoupmentDisplayMode(c) === 'model', JSON.stringify(c));
  }
});

// The show page reads the public copy (toPublicShowCommercial, a field
// whitelist): every guard output must survive it, or the show-page bar
// shows "~0%" without "losing money so far" (found in visual QA).
test('guard outputs survive the public field filter', () => {
  const below = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-55, -18, 16] }), running, now);
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
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'out-of-bounds' }), 'Estimate unavailable');
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'out-of-bounds', modelBelowCosts: true }), 'Losing money so far');
  assert.equal(getModelHoldLabel({ ...base }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'no-model' }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', recouped: true }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', status: 'closed', designation: 'Flop' }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', designation: 'Nonprofit' }), null);
  assert.equal(getModelHoldLabel({ ...base, modelDisplayHold: 'few-weeks', modelMethod: 'ai-estimated' }), null);
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
