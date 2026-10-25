import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldBlockCriticConsensusContaminationGate,
  GATE_SIGNALS,
} = require('./critic-consensus-contamination-gate.js');

test('passes with no structural orphans (floor 0, the steady state)', () => {
  assert.equal(shouldBlockCriticConsensusContaminationGate({ gateHits: 0 }), false);
});

test('blocks on ANY orphan consensus key (resolves to no shows.json id)', () => {
  assert.equal(shouldBlockCriticConsensusContaminationGate({ gateHits: 1 }), true);
});

test('only SHOW_NOT_IN_DB gates — staleness drift is demoted to the digest', () => {
  assert.ok(GATE_SIGNALS.has('SHOW_NOT_IN_DB'));
  // REVIEWCOUNT_DRIFT / MEANSCORE_DRIFT fire on opening nights and self-heal on
  // regeneration; they must NOT red the trunk.
  assert.ok(!GATE_SIGNALS.has('REVIEWCOUNT_DRIFT'));
  assert.ok(!GATE_SIGNALS.has('MEANSCORE_DRIFT'));
});

test('floor is configurable', () => {
  assert.equal(shouldBlockCriticConsensusContaminationGate({ gateHits: 1, floor: 1 }), false);
  assert.equal(shouldBlockCriticConsensusContaminationGate({ gateHits: 2, floor: 1 }), true);
});
