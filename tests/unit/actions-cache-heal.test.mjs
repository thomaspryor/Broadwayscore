// BRO-7506 class guard: an over-budget Actions cache must self-heal, never evicting
// SERP (or any non-rebuildable) caches, and the heal must be wired before the probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectEntriesToEvict } = require('../../scripts/lib/actions-cache-budget.js');
const GIB = 1024 ** 3;
const M = 'refs/heads/main';
const rd = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const rows = [
  { id: 1, key: 'bd-serp-cache-1', ref: M, sizeInBytes: 1 * GIB, createdAt: '2026-01-01' },
  { id: 2, key: 'money-monthly-baseline-x', ref: M, sizeInBytes: 1 * GIB, createdAt: '2026-01-01' },
  { id: 3, key: 'nextjs-cache-Linux-aaaaaaaaaaaaaaaa-1', ref: M, sizeInBytes: 2 * GIB, createdAt: '2026-01-02' },
  { id: 4, key: 'nextjs-cache-Linux-aaaaaaaaaaaaaaaa-2', ref: M, sizeInBytes: 2 * GIB, createdAt: '2026-11-02' },
  { id: 5, key: 'node-cache-Linux-bbbbbbbbbbbbbbbb', ref: 'refs/heads/land/x', sizeInBytes: 2 * GIB, createdAt: '2026-11-01' },
];

test('under target: nothing evicted', () => {
  assert.deepEqual(selectEntriesToEvict(rows, { totalBytes: 5 * GIB }), []);
});
test('orphan non-default-ref entries go first and eviction stops at target', () => {
  assert.deepEqual(selectEntriesToEvict(rows, { totalBytes: 8 * GIB }).map((e) => e.id), [5]);
});
test('never evicts SERP, unlisted families, or the newest entry per family on main', () => {
  const ids = selectEntriesToEvict(rows, { totalBytes: 100 * GIB, targetBytes: 0 }).map((e) => e.id);
  assert.deepEqual(ids.sort(), [3, 5]);
});
test('uses the authoritative total, not the (capped) listing sum', () => {
  assert.equal(selectEntriesToEvict(rows, { totalBytes: 5 * GIB, targetBytes: 6 * GIB }).length, 0);
  assert.ok(selectEntriesToEvict(rows, { totalBytes: 9 * GIB }).length > 0);
});
test('deletions per run are capped', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: i, key: `node-cache-Linux-${i}`, ref: 'refs/heads/land/y', sizeInBytes: GIB, createdAt: '2026-11-01' }));
  assert.equal(selectEntriesToEvict(many, { totalBytes: 80 * GIB }).length, 50);
});
test('daily health check and the pre-probe step both run --heal', () => {
  assert.match(rd('.github/workflows/data-health-check.yml'), /check-actions-cache-budget\.js --heal/);
  const y = rd('.github/workflows/check-corpus-drift.yml');
  const heal = y.indexOf('check-actions-cache-budget.js --heal');
  assert.ok(heal > 0 && heal < y.indexOf('name: Live-data assertions'), 'heal must precede the live-data probe');
  assert.match(y, /actions: write/);
});
