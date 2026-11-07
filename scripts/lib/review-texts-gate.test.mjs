import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBlockReviewTextsGate, CATASTROPHIC_CHECKS, HEALABLE_CHECKS } = require('./review-texts-gate.js');

const FLOOR = 10;

test('passes when no catastrophic errors and healable churn at/under floor', () => {
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 0, healableErrors: 0, floor: FLOOR }), false);
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 0, healableErrors: 1, floor: FLOOR }), false);
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 0, healableErrors: FLOOR, floor: FLOOR }), false, 'at floor is not over floor');
});

test('blocks on ANY catastrophic error (corrupt JSON / aggregator contamination), even with zero healable', () => {
  // The committed conflict-marker → json_parse class that broke validate-review-texts (commit 09e78a7a).
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 1, healableErrors: 0, floor: FLOOR }), true);
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 1, healableErrors: FLOOR, floor: FLOOR }), true);
});

test('blocks on a duplicate-churn spike past the floor', () => {
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 0, healableErrors: FLOOR + 1, floor: FLOOR }), true);
  assert.equal(shouldBlockReviewTextsGate({ catastrophicErrors: 0, healableErrors: 50, floor: FLOOR }), true);
});

test('the two check-class sets are disjoint (no error counted as both classes)', () => {
  for (const c of CATASTROPHIC_CHECKS) {
    assert.equal(HEALABLE_CHECKS.has(c), false, `${c} must not be in both sets`);
  }
});
