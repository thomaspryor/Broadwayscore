import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockNonReviewGate } = require('./non-review-gate.js');

test('passes when there are zero definitive wrong-page hits among scored reviews', () => {
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 0 }), false);
});

test('blocks on ANY definitive wrong-page (weather/sports) — zero tolerance, 0 FP across 34k', () => {
  // The LA Times weather page scored 88 / Chicago Tribune sports page scored 72 class.
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 1 }), true);
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 5 }), true);
});

test('default floor is 0 (explicit floor still respected if ever raised)', () => {
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 2, floor: 2 }), false);
  assert.equal(shouldBlockNonReviewGate({ definitiveHits: 3, floor: 2 }), true);
});
