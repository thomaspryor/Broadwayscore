import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectCacheEntriesToPrune } = require('./actions-cache-prune.js');

test('keeps newest N, returns the rest oldest-first for deletion', () => {
  const entries = [
    { key: 'a', createdAt: '2026-09-20T00:00:00Z' },
    { key: 'b', createdAt: '2026-09-22T00:00:00Z' },
    { key: 'c', createdAt: '2026-09-24T00:00:00Z' },
    { key: 'd', createdAt: '2026-09-25T00:00:00Z' },
  ];
  const toDelete = selectCacheEntriesToPrune(entries, { keepNewest: 2 });
  assert.deepEqual(toDelete.map((e) => e.key), ['a', 'b']);
});

test('under-threshold list deletes nothing', () => {
  assert.deepEqual(
    selectCacheEntriesToPrune([{ key: 'x', createdAt: '2026-09-20T00:00:00Z' }], { keepNewest: 2 }),
    [],
  );
});

test('empty list deletes nothing', () => {
  assert.deepEqual(selectCacheEntriesToPrune([], { keepNewest: 2 }), []);
});

test('default keepNewest is 2', () => {
  const entries = [1, 2, 3, 4].map((n) => ({ key: String(n), createdAt: `2026-09-2${n}T00:00:00Z` }));
  const toDelete = selectCacheEntriesToPrune(entries);
  assert.equal(toDelete.length, 2);
  assert.deepEqual(toDelete.map((e) => e.key), ['1', '2']);
});

test('does not mutate the input array', () => {
  const entries = [
    { key: 'a', createdAt: '2026-09-20T00:00:00Z' },
    { key: 'b', createdAt: '2026-09-25T00:00:00Z' },
  ];
  const snapshot = JSON.stringify(entries);
  selectCacheEntriesToPrune(entries, { keepNewest: 1 });
  assert.equal(JSON.stringify(entries), snapshot);
});
