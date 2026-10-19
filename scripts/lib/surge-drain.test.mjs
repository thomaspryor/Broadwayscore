import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { splitSurge } = require('./surge-drain');

const mk = (n) => Array.from({ length: n }, (_, i) => ({ c: { data: { publishDate: `2026-01-${String(i % 28 + 1).padStart(2, '0')}` }, id: i } }));

describe('splitSurge', () => {
  test('at or under the threshold everything applies', () => {
    const r = splitSurge(mk(50), 50, false);
    assert.equal(r.apply.length, 50);
    assert.equal(r.deferred.length, 0);
  });
  test('over the threshold applies the newest N and defers the rest', () => {
    const d = mk(60);
    const r = splitSurge(d, 50, false);
    assert.equal(r.apply.length, 50);
    assert.equal(r.deferred.length, 10);
    const oldestApplied = Math.min(...r.apply.map((x) => Date.parse(x.c.data.publishDate)));
    const newestDeferred = Math.max(...r.deferred.map((x) => Date.parse(x.c.data.publishDate)));
    assert.ok(oldestApplied >= newestDeferred);
  });
  test('--force-bulk applies everything', () => {
    const r = splitSurge(mk(300), 50, true);
    assert.equal(r.apply.length, 300);
    assert.equal(r.deferred.length, 0);
  });
});
