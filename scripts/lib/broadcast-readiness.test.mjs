import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateBroadcastReadiness, BROADWAY_MIN, WEST_END_MIN } = require('./broadcast-readiness.js');

// Helpers to build review fixtures.
const scored = (n, extra = {}) => Array.from({ length: n }, () => ({ assignedScore: 80, ...extra }));
const unscored = (n) => Array.from({ length: n }, () => ({ assignedScore: null }));

test('West End: 12+ scored reviews is ready WITHOUT any aggregator (the core fix)', () => {
  // Beetlejuice-shaped: lots of LLM-scored reviews, zero DTLI/BWW thumbs.
  const v = evaluateBroadcastReadiness(scored(29), 'west-end');
  assert.equal(v.ready, true);
  assert.equal(v.count, 29);
});

test('West End: exactly WEST_END_MIN passes, one below fails', () => {
  assert.equal(evaluateBroadcastReadiness(scored(WEST_END_MIN), 'west-end').ready, true);
  assert.equal(evaluateBroadcastReadiness(scored(WEST_END_MIN - 1), 'west-end').ready, false);
});

test('West End: unscored reviews do not count toward the threshold', () => {
  const v = evaluateBroadcastReadiness([...scored(WEST_END_MIN - 1), ...unscored(10)], 'west-end');
  assert.equal(v.ready, false);
  assert.equal(v.count, WEST_END_MIN - 1);
});

test('Broadway: meets count but lacks aggregator → NOT ready', () => {
  const v = evaluateBroadcastReadiness(scored(BROADWAY_MIN), 'broadway');
  assert.equal(v.ready, false);
  assert.match(v.reason, /aggregator/i);
});

test('Broadway: count + at least one aggregator (DTLI or BWW) → ready', () => {
  assert.equal(evaluateBroadcastReadiness(scored(BROADWAY_MIN, { dtliThumb: 'up' }), 'broadway').ready, true);
  assert.equal(evaluateBroadcastReadiness(scored(BROADWAY_MIN, { bwwThumb: 'up' }), 'broadway').ready, true);
});

test('Broadway: below BROADWAY_MIN fails even with an aggregator', () => {
  const v = evaluateBroadcastReadiness(scored(BROADWAY_MIN - 1, { dtliThumb: 'up' }), 'broadway');
  assert.equal(v.ready, false);
  assert.match(v.reason, /scored reviews/);
});

test('West End threshold (12) is looser than Broadway (15) — distribution-driven', () => {
  // A 13-review WE play is ready; the same 13-review count on Broadway is not.
  assert.equal(evaluateBroadcastReadiness(scored(13), 'west-end').ready, true);
  assert.equal(evaluateBroadcastReadiness(scored(13, { dtliThumb: 'up' }), 'broadway').ready, false);
});

test('Defaults: null/empty reviews → not ready, never throws', () => {
  assert.equal(evaluateBroadcastReadiness(null, 'west-end').ready, false);
  assert.equal(evaluateBroadcastReadiness([], 'broadway').ready, false);
});
