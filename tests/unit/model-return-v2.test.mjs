// BRO-4989 change 1: the SVOG-denominator fix and investor multiple.
// Tests the real module via require() (§15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { modelReturnV2, classifyTier, isClosed, LONG_RUN_WEEKS } = require('../../scripts/lib/model-return-v2');
const { calculateRecoupment, calculateLifetimeRecoupment } = require('../../scripts/lib/recoupment-model');

const NOW = Date.parse('2026-10-01');
const result = (profits, extra = {}) => ({
  capitalization: 10_000_000, svogGrant: 0, reserveFund: 1_000_000,
  pessimistic: { cumulativeProfit: profits[0] },
  central: { cumulativeProfit: profits[1] },
  optimistic: { cumulativeProfit: profits[2] },
  ...extra,
});
const closed = { closingDate: '2025-01-01' };
const running = { closingDate: null };

describe('modelReturnV2', () => {
  it('closed show with no grant: pct is profit over cap', () => {
    const r = modelReturnV2(result([5e6, 10e6, 20e6]), closed, NOW);
    assert.deepStrictEqual(r.recoupmentPctV2, [50, 100, 200]);
    assert.strictEqual(r.recouped, true);
    // 20M distributable: 10M back plus half of the 10M above cap
    assert.deepStrictEqual(r.investorMultiple, [0.5, 1, 1.5]);
  });

  it('counts the SVOG grant as money in, over the full cap', () => {
    const r = modelReturnV2(result([0, 0, 0], { svogGrant: 9_000_000 }), closed, NOW);
    assert.deepStrictEqual(r.recoupmentPctV2, [90, 90, 90]);
    assert.strictEqual(r.recouped, false);
  });

  it('recouped line matches live (profit >= cap - svog) when svog < cap', () => {
    const at = modelReturnV2(result([1e6, 1e6, 1e6], { svogGrant: 9e6 }), closed, NOW);
    const below = modelReturnV2(result([0.99e6, 0.99e6, 0.99e6], { svogGrant: 9e6 }), closed, NOW);
    assert.strictEqual(at.recouped, true);
    assert.strictEqual(below.recouped, false);
  });

  it('grant larger than cap stays proportional', () => {
    const r = modelReturnV2(result([0, 0, 0], { capitalization: 2_500_000, svogGrant: 10_000_000 }), closed, NOW);
    assert.strictEqual(r.recoupmentPctV2[1], 400);
    assert.strictEqual(r.recouped, true);
  });

  it('running show adds the reserve to the denominator and holds it back from investors', () => {
    const r = modelReturnV2(result([11e6, 11e6, 11e6]), running, NOW);
    assert.strictEqual(r.denominator, 11_000_000);
    assert.strictEqual(r.recoupmentPctV2[1], 100);
    assert.strictEqual(r.investorMultiple[1], 1);
  });

  it('losses floor the multiple at 0, not the pct', () => {
    const r = modelReturnV2(result([-20e6, -20e6, -20e6]), closed, NOW);
    assert.strictEqual(r.recoupmentPctV2[1], -200);
    assert.strictEqual(r.investorMultiple[1], 0);
  });

  it('recouped uses the unrounded ratio, like live (99.96% is not recouped)', () => {
    const r = modelReturnV2(result([9_996_000, 9_996_000, 9_996_000]), closed, NOW);
    assert.strictEqual(r.recoupmentPctV2[1], 100);
    assert.strictEqual(r.recouped, false);
  });

  it('future or unparseable closing dates count as running, like live', () => {
    assert.strictEqual(isClosed({ closingDate: '2027-01-01' }, NOW), false);
    assert.strictEqual(isClosed({ closingDate: 'TBD' }, NOW), false);
    assert.strictEqual(isClosed({}, NOW), false);
    assert.strictEqual(isClosed(closed, NOW), true);
  });

  it('returns null without a usable result', () => {
    assert.strictEqual(modelReturnV2(null, closed, NOW), null);
    assert.strictEqual(modelReturnV2({ error: 'x' }, closed, NOW), null);
    assert.strictEqual(modelReturnV2(result([0, 0, 0], { capitalization: 0 }), closed, NOW), null);
  });
});

describe('classifyTier', () => {
  it('needs a cap and grosses', () => {
    assert.strictEqual(classifyTier({}, {}, { gross: 1 }), 'ai-estimated');
    assert.strictEqual(classifyTier({}, { capitalization: 1 }, null), 'ai-estimated');
  });
  it('splits at ten years', () => {
    const open = '2000-01-01';
    const close = new Date(Date.parse(open) + LONG_RUN_WEEKS * 7 * 86400000).toISOString();
    assert.strictEqual(classifyTier({ openingDate: open, closingDate: close }, { capitalization: 1 }, { gross: 1 }), 'simplified-lifetime');
    assert.strictEqual(classifyTier({ openingDate: open, closingDate: '2005-01-01' }, { capitalization: 1 }, { gross: 1 }), 'weekly-model');
  });
});

describe('parity with the live model', () => {
  // Real calculateRecoupment / calculateLifetimeRecoupment outputs: outside the
  // nut-floor band, v2 must give the same recouped call as live. Cases cover
  // both sides of the line, closed and running.
  const weeksFrom = (start) => {
    const weekly = {};
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.parse(start) + i * 7 * 86400000).toISOString().slice(0, 10);
      weekly[d] = { gross: 1_100_000 + (i % 5) * 50_000, capacity: 0.9, atp: 120 };
    }
    return weekly;
  };
  const cases = [
    [{ id: 'p1', title: 'P1', type: 'musical', openingDate: '2023-01-08', closingDate: '2024-03-01' }, weeksFrom('2023-01-08')],
    [{ id: 'p2', title: 'P2', type: 'musical', openingDate: '2025-08-03', closingDate: null }, weeksFrom('2025-08-03')],
  ];
  for (const [show, weekly] of cases) {
    for (const [cap, svog] of [[15e6, 0], [15e6, 5e6], [8e6, 2e6], [30e6, 9e6], [60e6, 9e6]]) {
      it(`${show.id} cap ${cap / 1e6}M svog ${svog / 1e6}M`, () => {
        const comm = { capitalization: cap, svogGrant: svog || undefined, weeklyRunningCost: 700_000 };
        const live = calculateRecoupment(show, comm, { gross: 70e6 }, weekly);
        assert.ok(!live.error, live.error);
        assert.strictEqual(modelReturnV2(live, show, NOW).recouped, live.modelRecouped);
      });
    }
  }
  it('lifetime tier', () => {
    const show = { id: 'p3', title: 'P3', type: 'musical', openingDate: '2005-01-01', closingDate: '2020-03-12' };
    const live = calculateLifetimeRecoupment(show, { capitalization: 12e6 }, { gross: 900e6 });
    assert.ok(!live.error, live.error);
    assert.strictEqual(modelReturnV2(live, show, NOW).recouped, live.modelRecouped);
  });
});
