import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const { loadCursor, saveCursor, rotateAfter } = createRequire(import.meta.url)('./rotating-cursor.js');
test('rotates after last processed id', () => assert.deepEqual(rotateAfter(['a','b','c','d'], 'b'), ['c','d','a','b']));
test('null cursor / cursor past end leaves order', () => {
  assert.deepEqual(rotateAfter(['a','b'], 'zz'), ['a','b']);
  assert.deepEqual(rotateAfter(['a','b'], null), ['a','b']);
});
test('cursor whose show left the list resumes at next id (no restart from top)', () => {
  assert.deepEqual(rotateAfter(['a','c','d','e'], 'b'), ['c','d','e','a']);
});
test('successive budgeted runs cover every show (no starvation)', () => {
  const all = Array.from({ length: 10 }, (_, i) => 's' + i);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cur-')), 'c.json');
  const seen = new Set();
  for (let run = 0; run < 4; run++) {
    const order = rotateAfter(all, loadCursor(f).lastShowId);
    const done = order.slice(0, 3); done.forEach(x => seen.add(x));
    saveCursor(f, { lastShowId: done.at(-1) });
  }
  assert.equal(seen.size, 10);
});
