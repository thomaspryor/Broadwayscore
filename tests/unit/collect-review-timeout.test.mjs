// BRO-5243: collect-review-texts per-review timeout override for a targeted retry run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reviewTimeoutMs } = require('../../scripts/collect-review-texts.js');

test('unset or unreadable keeps the 90s default', () => {
  assert.equal(reviewTimeoutMs(undefined), 90000);
  assert.equal(reviewTimeoutMs(''), 90000);
  assert.equal(reviewTimeoutMs('abc'), 90000);
});
test('a set value is used, clamped to 30-300s', () => {
  assert.equal(reviewTimeoutMs('180'), 180000);
  assert.equal(reviewTimeoutMs('5'), 30000);
  assert.equal(reviewTimeoutMs('9999'), 300000);
});
