// Guard (BRO-3674): a table cell that calls stopPropagation() on every click
// makes any unlinked text in it dead on an expandable row (the SRO "$40" chip
// on /discount-tickets drew rage clicks for months). Stop propagation on the
// <a> inside the cell instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

test('no <td> swallows every click with stopPropagation', () => {
  const hits = [];
  for (const file of walk('src')) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/<td\b[^>]*onClick=\{\(?e\)? => e\.stopPropagation\(\)\}/.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
