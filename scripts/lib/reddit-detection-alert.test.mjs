// BRO-7210: a Reddit posted-detection outage lasting a day becomes a card; blips and recovery do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { nextFailingSince, decideRedditDetectionAlert } = require('./reddit-detection-alert.js');

const T0 = '2026-11-01T00:00:00.000Z';
const at = (h) => Date.parse(T0) + h * 3600000;

test('stamps the first failure, keeps it while failing, clears on success', () => {
  assert.equal(nextFailingSince(undefined, false, T0), T0);
  assert.equal(nextFailingSince(T0, false, '2026-11-02T00:00:00.000Z'), T0);
  assert.equal(nextFailingSince('garbage', false, T0), T0);
  assert.equal(nextFailingSince(T0, true, T0), null);
});
test('blip is silent, a day-long outage routes, recovery resolves', () => {
  assert.equal(decideRedditDetectionAlert(T0, at(3)), null);
  assert.equal(decideRedditDetectionAlert(T0, at(24)).action, 'route');
  assert.equal(decideRedditDetectionAlert(null, at(0)).action, 'resolve');
});
