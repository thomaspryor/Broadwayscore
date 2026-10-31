import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldBlockAudienceBuzzContaminationGate,
  DIVERGENCE_SPIKE_FLOOR,
} = require('./audience-buzz-contamination-gate.js');

test('the live flap passes: one borderline REDDIT_SCORE_DIVERGENCE does NOT block', () => {
  // run f8abff972 (2026-06-30) reddened main on glengarry-glen-ross-west-end-2026
  // diff=exactly-40. With the spike floor a single divergence rides the digest.
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 1 }), false);
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 0 }), false);
});

test('spike floor defaults to 2 — two divergences still ride, three+ blocks', () => {
  assert.equal(DIVERGENCE_SPIKE_FLOOR, 2);
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 2 }), false, 'at floor is not over floor');
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 3 }), true);
});

test('blocks on a scraper-regression spike (many shows misrouted at once)', () => {
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 20 }), true);
});

test('floor is overridable', () => {
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 1, floor: 0 }), true);
  assert.equal(shouldBlockAudienceBuzzContaminationGate({ gateHits: 5, floor: 5 }), false);
});
