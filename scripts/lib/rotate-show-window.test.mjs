import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { rotateShowWindow } = createRequire(import.meta.url)('./rotate-show-window.js');

const list = (n) => Array.from({ length: n }, (_, i) => i);

test('step 0 and invalid inputs leave the order alone', () => {
  assert.deepEqual(rotateShowWindow(list(5), 2, 0), list(5));
  assert.deepEqual(rotateShowWindow(list(5), 0, 3), list(5));
  assert.deepEqual(rotateShowWindow(list(5), 2, NaN), list(5));
  assert.deepEqual(rotateShowWindow([], 2, 1), []);
});

test('successive steps walk the whole list, including when n is a multiple of 2*limit', () => {
  for (const n of [100, 150, 37, 40]) {
    const seen = new Set();
    for (let step = 0; step < n; step++) rotateShowWindow(list(n), 25, step).slice(0, 25).forEach((x) => seen.add(x));
    assert.equal(seen.size, n, `n=${n} fully covered`);
  }
});
