// Unit tests for scripts/lib/commercial-breakeven.js and its wiring into the
// commercial write guard (BRO-4985: operation-mincemeat, schmigadoon and
// cats-the-jellicle-ball kept a break-even below a refreshed weekly cost).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syncBreakevenToCost, breakevenBelowCost } = require('../../scripts/lib/commercial-breakeven.js');
const { createCommercialWriteGuard } = require('../../scripts/lib/commercial-write-guard.js');

test('rescales the break-even when the weekly cost changes after the model ran', () => {
  // Model run on $500K: break-even 536,585. Reddit refresh sets $560K.
  const rec = { weeklyRunningCost: 560_000, modelBreakeven: 536_585, modelCostBasis: 500_000 };
  assert.equal(syncBreakevenToCost(rec), true);
  assert.equal(rec.modelBreakeven, 600_975);
  assert.equal(rec.modelCostBasis, 560_000);
  assert.ok(rec.modelBreakeven >= rec.weeklyRunningCost);
  assert.equal(syncBreakevenToCost(rec), false, 'idempotent');
});

test('leaves records it cannot rescale exactly', () => {
  const noBasis = { weeklyRunningCost: 560_000, modelBreakeven: 536_585 };
  assert.equal(syncBreakevenToCost(noBasis), false);
  const estimatedNut = { weeklyRunningCost: 560_000, modelBreakeven: 536_585, modelCostBasis: null };
  assert.equal(syncBreakevenToCost(estimatedNut), false);
  const noCost = { weeklyRunningCost: null, modelBreakeven: 536_585, modelCostBasis: 500_000 };
  assert.equal(syncBreakevenToCost(noCost), false);
  assert.equal(syncBreakevenToCost(null), false);
});

test('breakevenBelowCost lists stale records only', () => {
  const shows = {
    'operation-mincemeat': { weeklyRunningCost: 560_000, modelBreakeven: 536_585 },
    hamilton: { weeklyRunningCost: 643_000, modelBreakeven: 717_981 },
    stub: { weeklyRunningCost: null, modelBreakeven: 100 },
  };
  assert.deepEqual(breakevenBelowCost(shows), [
    { slug: 'operation-mincemeat', modelBreakeven: 536_585, weeklyRunningCost: 560_000 },
  ]);
});

test('every commercial.json save keeps break-even in step with the cost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-breakeven-'));
  try {
    const file = path.join(dir, 'commercial.json');
    fs.writeFileSync(file, JSON.stringify({
      _meta: {},
      shows: { 'operation-mincemeat': { weeklyRunningCost: 500_000, modelBreakeven: 536_585, modelCostBasis: 500_000 } },
    }));
    const guard = createCommercialWriteGuard(file);
    const data = guard.loadCommercial();
    data.shows['operation-mincemeat'].weeklyRunningCost = 560_000; // what waltzCostPatch writes
    guard.saveCommercial(data);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')).shows['operation-mincemeat'];
    assert.equal(rec.modelBreakeven, 600_975);
    assert.deepEqual(breakevenBelowCost({ x: rec }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
