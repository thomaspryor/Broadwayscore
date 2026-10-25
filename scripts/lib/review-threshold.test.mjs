import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { REGIONAL_REVIEW_THRESHOLD, meetsReviewThreshold, decideReviewThresholdPromotion } = require('./review-threshold.js');

test('REGIONAL_REVIEW_THRESHOLD is 3 (owner rule 2026-07-30)', () => {
  assert.equal(REGIONAL_REVIEW_THRESHOLD, 3);
});

test('meetsReviewThreshold: below/at/above the default threshold', () => {
  assert.equal(meetsReviewThreshold(2), false);
  assert.equal(meetsReviewThreshold(3), true);
  assert.equal(meetsReviewThreshold(4), true);
});

test('meetsReviewThreshold: honors a custom threshold', () => {
  assert.equal(meetsReviewThreshold(4, 5), false);
  assert.equal(meetsReviewThreshold(5, 5), true);
});

test('meetsReviewThreshold: fails closed on non-numbers', () => {
  assert.equal(meetsReviewThreshold(null), false);
  assert.equal(meetsReviewThreshold(undefined), false);
  assert.equal(meetsReviewThreshold(NaN), false);
  assert.equal(meetsReviewThreshold('3'), false);
});

test('decideReviewThresholdPromotion: confirms at/above threshold', () => {
  const r = decideReviewThresholdPromotion({ reviewCount: 3 });
  assert.equal(r.confirmed, true);
  assert.match(r.reason, /3 distinct review outlets/);

  const r2 = decideReviewThresholdPromotion({ reviewCount: 5 });
  assert.equal(r2.confirmed, true);
});

test('decideReviewThresholdPromotion: rejects below threshold with a reason naming the count', () => {
  const r = decideReviewThresholdPromotion({ reviewCount: 2 });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /only 2 distinct review outlet/);
  assert.match(r.reason, /needs 3\+/);
});

test('decideReviewThresholdPromotion: fails closed (not confirmed) when reviewCount is missing', () => {
  assert.equal(decideReviewThresholdPromotion({}).confirmed, false);
  assert.equal(decideReviewThresholdPromotion(null).confirmed, false);
  assert.equal(decideReviewThresholdPromotion({ reviewCount: null }).confirmed, false);
  assert.equal(decideReviewThresholdPromotion({ reviewCount: 'three' }).confirmed, false);
});

test('decideReviewThresholdPromotion: honors a custom threshold option', () => {
  assert.equal(decideReviewThresholdPromotion({ reviewCount: 4 }, { threshold: 5 }).confirmed, false);
  assert.equal(decideReviewThresholdPromotion({ reviewCount: 5 }, { threshold: 5 }).confirmed, true);
});

test('decideReviewThresholdPromotion: 0 reviews is rejected, not treated as "unknown"', () => {
  const r = decideReviewThresholdPromotion({ reviewCount: 0 });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /only 0 distinct review outlet/);
});
