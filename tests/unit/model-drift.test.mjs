// BRO-5004: stored model values that a fresh run no longer reproduces are
// caught. require()s the real helpers and model (§15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { liveModelRun, modelDrift } = require('../../scripts/lib/model-drift');
const { makeGrossesLookup } = require('../../scripts/lib/grosses-lookup');

// A running musical, two years of weekly grosses, closing date announced.
const WEEK = 7 * 86400000;
const first = new Date(Date.UTC(2024, 2, 3)); // a Sunday
const iso = (d) => d.toISOString().slice(0, 10);
const show = { slug: 'x', id: 'x', title: 'X', type: 'musical', previewsStartDate: '2024-02-27', openingDate: '2024-03-27', closingDate: null };
const weeks = {};
for (let i = 0; i < 100; i++) weeks[iso(new Date(first.getTime() + i * WEEK))] = { x: { gross: 1_300_000, performances: 8 } };
const lookup = makeGrossesLookup({ shows: { x: { allTime: { gross: 130_000_000, performances: 800, attendance: 800_000 } } } }, { weeks });

// What merge-model-recoupment.js stores after a run.
function storedAfterRun(comm, day) {
  const { tier, result } = liveModelRun(show, comm, lookup);
  return {
    ...comm,
    modelMethod: tier,
    modelRecoupmentPct: [result.recoupmentPctLow, result.recoupmentPctCentral, result.recoupmentPctHigh],
    modelBreakeven: result.weeklyBreakeven,
    modelCostBasis: comm.weeklyRunningCost,
    modelLastRun: day,
  };
}

describe('modelDrift', () => {
  const base = { capitalization: 25_000_000, weeklyRunningCost: 850_000 };

  test('a fresh run on the same inputs reproduces the stored values', () => {
    const stored = storedAfterRun(base, '2026-10-05');
    assert.equal(modelDrift(stored, liveModelRun(show, stored, lookup), '2026-10-05'), null);
    assert.equal(modelDrift(stored, liveModelRun(show, stored, lookup), '2026-10-09'), null);
  });

  test('the Gatsby case: a cost raised after the run is flagged, with the cost change', () => {
    const stored = storedAfterRun(base, '2026-10-05');
    // The recoupment range keeps the old cost until the next run.
    // (commercial-write-guard also moves modelCostBasis to the new cost, so in
    // real data the cost note may be absent; the range is flagged either way.)
    const edited = { ...stored, weeklyRunningCost: 1_000_000 };
    const d = modelDrift(edited, liveModelRun(show, edited, lookup), '2026-10-09');
    assert.equal(d.kind, 'drift');
    assert.ok(d.fresh < d.stored, `${d.fresh} < ${d.stored}`);
    assert.match(d.detail, /weekly cost 850000 -> 1000000/);
  });

  test('same day: any difference beyond rounding means the run did not stick', () => {
    const stored = storedAfterRun(base, '2026-10-10');
    const edited = { ...stored, weeklyRunningCost: 870_000 };
    const d = modelDrift(edited, liveModelRun(show, edited, lookup), '2026-10-10');
    assert.equal(d.kind, 'same-day');
  });

  test('small moves between runs are not flagged', () => {
    const stored = storedAfterRun(base, '2026-10-05');
    const nudged = { ...stored, modelRecoupmentPct: stored.modelRecoupmentPct.map((v) => v + 2) };
    assert.equal(modelDrift(nudged, liveModelRun(show, nudged, lookup), '2026-10-09'), null);
  });

  test('a stored tier that no longer matches is flagged', () => {
    const stored = { ...storedAfterRun(base, '2026-10-05'), modelMethod: 'simplified-lifetime' };
    assert.equal(modelDrift(stored, liveModelRun(show, stored, lookup), '2026-10-09').kind, 'method');
  });

  test('records never modelled, or that a run would not model, are skipped', () => {
    assert.equal(modelDrift({ ...base }, liveModelRun(show, base, lookup), '2026-10-09'), null);
    assert.equal(liveModelRun(show, { weeklyRunningCost: 1 }, lookup).result, null);
  });
});
