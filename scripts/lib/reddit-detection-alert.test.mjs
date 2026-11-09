// BRO-7210: persistent Reddit posted-detection outage becomes a card; blips and recovery do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { nextFailureStreak, decideRedditDetectionAlert, DETECTION_FAILURE_THRESHOLD } = require('./reddit-detection-alert.js');

test('streak counts consecutive skips and resets on success', () => {
  assert.equal(nextFailureStreak(undefined, false), 1);
  assert.equal(nextFailureStreak(2, false), 3);
  assert.equal(nextFailureStreak(5, true), 0);
  assert.equal(nextFailureStreak('x', false), 1);
});
test('blip is silent, threshold routes, recovery resolves', () => {
  assert.equal(decideRedditDetectionAlert(1), null);
  assert.equal(decideRedditDetectionAlert(DETECTION_FAILURE_THRESHOLD - 1), null);
  assert.equal(decideRedditDetectionAlert(DETECTION_FAILURE_THRESHOLD).action, 'route');
  assert.equal(decideRedditDetectionAlert(0).action, 'resolve');
});
