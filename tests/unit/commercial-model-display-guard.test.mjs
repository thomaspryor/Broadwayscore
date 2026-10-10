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
  assert.equal(getAtRiskModelRange({ ...high, status: 'open' }), null);
});

test('a small negative shows as 0% returned, running below its costs', () => {
  const out = applyModelDisplayGuard(rec({ modelRecoupmentPct: [-42, -3, 33] }), running, now);
  assert.deepEqual(out.modelRecoupmentPct, [0, 0, 33]);
  assert.equal(out.modelBelowCosts, true);
  const l = getModelRecoupmentLabels(out.modelRecoupmentPct, { belowCosts: true });
  assert.equal(l.label, '0% returned · running below its costs');
  assert.equal(l.belowCostsNote, 'running below its costs');
  assert.ok(!/-\d/.test(l.ariaLabel));
});

test('fewer than 12 played weeks and >25 outside a reported range are hidden', () => {
  const early = { previewsStartDate: '2026-08-15' };
  assert.equal(applyModelDisplayGuard(rec({ modelRecoupmentPct: [10, 20, 30] }), early, now).modelDisplayHold, 'few-weeks');
  const bvsc = rec({ modelRecoupmentPct: [38, 90, 133], estimatedRecoupmentPct: [10, 30], estimatedRecoupmentSource: 'Reddit grosses analysis' });
  assert.equal(applyModelDisplayGuard(bvsc, running, now).modelDisplayHold, 'off-report');
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
