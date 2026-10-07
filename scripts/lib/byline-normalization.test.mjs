/**
 * byline-normalization regression tests.
 *
 * Per CLAUDE.md rule 15 this require()s the real function — no logic copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeBylineCapture } = require('./byline-normalization.js');

test('strips a leading job-title prefix from a byline capture', () => {
  assert.equal(normalizeBylineCapture('Senior Editor Jane Doe'), 'Jane Doe');
  assert.equal(normalizeBylineCapture('Contributing Critic John Smith'), 'John Smith');
  assert.equal(normalizeBylineCapture('Chief Theatre Critic Sarah Lee'), 'Sarah Lee');
});

test('leaves an ordinary two-word name untouched', () => {
  assert.equal(normalizeBylineCapture('Franco Milazzo'), 'Franco Milazzo');
});

test('does not strip when the job-title word is the only token before a single-word remainder', () => {
  // "Chief Editor" with no name after it isn't a byline this normalizer can fix —
  // require a 2+ word remainder so it doesn't eat a real one-word capture.
  assert.equal(normalizeBylineCapture('Chief Editor'), 'Chief Editor');
});

test('still title-cases an ALL-CAPS name after stripping a job-title prefix', () => {
  assert.equal(normalizeBylineCapture('SENIOR EDITOR JANE DOE'), 'Jane Doe');
});
