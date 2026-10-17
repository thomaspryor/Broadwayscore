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
