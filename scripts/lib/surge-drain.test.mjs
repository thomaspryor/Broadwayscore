import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { splitSurge } = require('./surge-drain');

const mk = (n) => Array.from({ length: n }, (_, i) => ({ c: { data: { publishDate: `2026-01-${String(i % 28 + 1).padStart(2, '0')}` }, id: i } }));

describe('splitSurge', () => {
  test('apply is a copy: emptying the input must not empty the apply list (BRO-5672)', () => {
    const input = mk(5);
    for (const [threshold, force] of [[50, false], [50, true], [3, false]]) {
      const r = splitSurge(input.slice(), threshold, force);
      assert.notEqual(r.apply, input);
      const inp = input.slice();
      const r2 = splitSurge(inp, threshold, force);
      inp.length = 0;
      assert.ok(r2.apply.length > 0);
    }
  });
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
  test('a priority key keeps old prior-run clears ahead of newer ones', () => {
    const d = mk(60).map((x, i) => ({ ...x, kind: i < 5 ? 'prior' : 'other', c: { ...x.c, data: { publishDate: i < 5 ? '2010-01-01' : x.c.data.publishDate } } }));
    const r = splitSurge(d, 50, false, (x) => (x.kind === 'prior' ? 0 : 1));
    assert.equal(r.apply.filter((x) => x.kind === 'prior').length, 5);
  });
  test('--force-bulk applies everything', () => {
    const r = splitSurge(mk(300), 50, true);
    assert.equal(r.apply.length, 300);
    assert.equal(r.deferred.length, 0);
  });
});
