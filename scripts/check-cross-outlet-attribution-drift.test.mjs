// parseCount() reads node --test's summary lines. Real gotcha: TAP on Node 20
// prints `# pass N`, spec on Node 22+ prints `ℹ pass N` — a regex anchored to
// only one prefix would silently report null on whichever Node version isn't
// tested locally (same class of bug test.yml's own node-batch runner works
// around for pass/fail counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCount } = require('./check-cross-outlet-attribution-drift.js');

test('parseCount reads TAP-style `# label N` lines', () => {
  const output = 'ℹ tests 5\n# pass 1\n# fail 0\n# skipped 4\n';
  assert.equal(parseCount(output, 'tests'), 5);
  assert.equal(parseCount(output, 'skipped'), 4);
  assert.equal(parseCount(output, 'fail'), 0);
});

test('parseCount reads spec-style `ℹ label N` lines (Node 22+)', () => {
  const output = 'ℹ tests 5\nℹ pass 1\nℹ fail 0\nℹ skipped 4\n';
  assert.equal(parseCount(output, 'tests'), 5);
  assert.equal(parseCount(output, 'skipped'), 4);
});

test('parseCount returns null when the label is absent', () => {
  assert.equal(parseCount('no summary lines here', 'skipped'), null);
});

test('parseCount does not match a substring of another label (e.g. "pass" inside "passed")', () => {
  const output = 'ℹ passed_something 9\nℹ pass 1\n';
  assert.equal(parseCount(output, 'pass'), 1);
});
