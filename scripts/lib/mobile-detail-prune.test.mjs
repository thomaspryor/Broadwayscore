import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadPriorIndexIds, planPrune } = require('./mobile-detail-prune.js');

test('orphan absent from prior index is pruned on a cold-cache run', () => {
  const r = planPrune({ orphanIds: ['gone'], previousCandidates: {}, priorIndexIds: new Set(['live']), showCount: 1000 });
  assert.deepEqual(r.toPrune, ['gone']);
  assert.deepEqual(r.nextCandidates, {});
});

test('newly invisible show still listed in prior index is kept and armed', () => {
  const r = planPrune({ orphanIds: ['fresh'], previousCandidates: {}, priorIndexIds: new Set(['fresh']), showCount: 1000 });
  assert.deepEqual(r.toPrune, []);
  assert.deepEqual(r.nextCandidates, { fresh: true });
});

test('cache candidate still prunes (OR) even if listed in prior index', () => {
  const r = planPrune({ orphanIds: ['a'], previousCandidates: { a: true }, priorIndexIds: new Set(['a']), showCount: 1000 });
  assert.deepEqual(r.toPrune, ['a']);
});

test('missing prior index gives no grace evidence', () => {
  const r = planPrune({ orphanIds: ['a'], previousCandidates: {}, priorIndexIds: null, showCount: 1000 });
  assert.deepEqual(r.toPrune, []);
  assert.deepEqual(r.nextCandidates, { a: true });
});

test('ceiling holds: oversized batch is skipped and stays armed', () => {
  const ids = Array.from({ length: 51 }, (_, i) => `x${i}`);
  const r = planPrune({ orphanIds: ids, previousCandidates: {}, priorIndexIds: new Set(), showCount: 100 });
  assert.equal(r.skipped, true);
  assert.deepEqual(r.toPrune, []);
  assert.equal(Object.keys(r.nextCandidates).length, 51);
});

test('loadPriorIndexIds: reads ids; unreadable/empty index returns null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-'));
  const good = path.join(d, 'i.json');
  fs.writeFileSync(good, JSON.stringify({ shows: [{ id: 'a' }, { id: 'b' }] }));
  assert.deepEqual([...loadPriorIndexIds(good)].sort(), ['a', 'b']);
  fs.writeFileSync(path.join(d, 'e.json'), JSON.stringify({ shows: [] }));
  assert.equal(loadPriorIndexIds(path.join(d, 'e.json')), null);
  assert.equal(loadPriorIndexIds(path.join(d, 'nope.json')), null);
});

test('hidden-category (tour) absent from index is NOT grace evidence', () => {
  const r = planPrune({ orphanIds: ['tour', 'gone'], previousCandidates: {}, priorIndexIds: new Set(), indexCovers: id => id !== 'tour', showCount: 1000 });
  assert.deepEqual(r.toPrune, ['gone']);
  assert.deepEqual(r.nextCandidates, { tour: true });
});

test('skipped result reports the real count', () => {
  const ids = Array.from({ length: 51 }, (_, i) => `x${i}`);
  assert.equal(planPrune({ orphanIds: ids, priorIndexIds: new Set(), showCount: 100 }).skippedCount, 51);
});

// BRO-7118: a tour is never in the app index, so only a candidate carried
// between runs can prune it. The committed ledger is that carrier.
test('tour orphan arms on run 1, prunes on run 2 through the ledger alone', () => {
  const { loadLedger, saveLedger } = require('./mobile-detail-prune.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-ledger-'));
  const file = path.join(dir, 'ledger.json');
  const tourOnly = { indexCovers: () => false, priorIndexIds: new Set(['live']), showCount: 1000 };
  const t0 = Date.parse('2026-11-08T00:00:00Z');
  const H = 3600e3;
  const run1 = planPrune({ orphanIds: ['annie-tour-2022'], previousCandidates: loadLedger(file, t0), ...tourOnly });
  assert.deepEqual(run1.toPrune, []);
  saveLedger(file, run1.nextCandidates, t0);
  // A second workflow minutes later is not a second cycle.
  const soon = planPrune({ orphanIds: ['annie-tour-2022'], previousCandidates: loadLedger(file, t0 + 600e3), ...tourOnly });
  assert.deepEqual(soon.toPrune, []);
  saveLedger(file, soon.nextCandidates, t0 + 600e3);
  const run2 = planPrune({ orphanIds: ['annie-tour-2022'], previousCandidates: loadLedger(file, t0 + 4 * H), ...tourOnly });
  assert.deepEqual(run2.toPrune, ['annie-tour-2022']);
  saveLedger(file, run2.nextCandidates, t0 + 4 * H);
  assert.deepEqual(loadLedger(file, t0 + 9 * H), {});
});

test('ledger missing or corrupt reads as empty and an unchanged save does not rewrite', () => {
  const { loadLedger, saveLedger } = require('./mobile-detail-prune.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-ledger-')), 'l.json');
  assert.deepEqual(loadLedger(file), {});
  fs.writeFileSync(file, '{nope');
  assert.deepEqual(loadLedger(file), {});
  saveLedger(file, { a: true }, 1);
  const m1 = fs.statSync(file).mtimeMs;
  saveLedger(file, { a: true }, 99999);
  assert.equal(fs.statSync(file).mtimeMs, m1);
});

// Guard: the generator must actually wire the ledger in (the lib alone prunes nothing).
test('generator reads and writes the committed prune ledger', () => {
  const src = fs.readFileSync(new URL('../generate-mobile-show-details.js', import.meta.url), 'utf8');
  assert.match(src, /loadLedger\(PRUNE_LEDGER\)/);
  assert.match(src, /saveLedger\(PRUNE_LEDGER, nextCandidates\)/);
  assert.match(src, /process\.env\.CI\) saveLedger/);
});
