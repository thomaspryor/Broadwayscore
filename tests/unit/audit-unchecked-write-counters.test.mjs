import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findUncheckedWriteCounters, scan } = require('../../scripts/lib/unchecked-write-counters.js');

test('flags a counter right after an unchecked safeWriteReview', () => {
  const src = "safeWriteReview(p, d, { force: true });\nwritten++;\n";
  assert.equal(findUncheckedWriteCounters(src).length, 1);
  assert.equal(findUncheckedWriteCounters("safeWriteReview(p, d);\n\n  stats.written++;").length, 1);
});

test('ignores checked results and calls with no counter', () => {
  assert.equal(findUncheckedWriteCounters("const r = safeWriteReview(p, d);\nif (r.wrote) written++;").length, 0);
  assert.equal(findUncheckedWriteCounters("safeWriteReview(p, d);\nconsole.log('x');\nwritten++;").length, 0);
});

test('no script bumps a counter after an unchecked safeWriteReview', () => {
  assert.deepEqual(scan(), []);
});
