import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessBatchClearGate, DEFAULT_GATE_THRESHOLDS } = require('./autoclear-batch-gate.js');

test('shadow evidence insufficient → blocked (current real state)', () => {
  const r = assessBatchClearGate({ enableAllowed: false, scoringDelta: { flips: 0, t1Flips: 0 } });
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'shadow-evidence-insufficient');
});

test('shadow clean but scoring-delta not run → blocked', () => {
  const r = assessBatchClearGate({ enableAllowed: true, scoringDelta: null });
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'scoring-delta-not-run');
});

test('INDUCED THRESHOLD: any T1 flip aborts even with clean shadow', () => {
  const r = assessBatchClearGate({ enableAllowed: true, scoringDelta: { flips: 1, t1Flips: 1 } });
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'scoring-delta-t1-flip');
});

test('INDUCED THRESHOLD: >5 total flips aborts even with clean shadow', () => {
  const r = assessBatchClearGate({ enableAllowed: true, scoringDelta: { flips: 6, t1Flips: 0 } });
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'scoring-delta-total-flips-exceeded');
});

test('both gates pass → proceed', () => {
  const r = assessBatchClearGate({ enableAllowed: true, scoringDelta: { flips: 3, t1Flips: 0 } });
  assert.equal(r.proceed, true);
  assert.equal(r.reason, 'both-gates-pass');
  assert.equal(r.checks.totalFlips, 3);
});

test('exactly at total-flip threshold (5) still proceeds', () => {
  const r = assessBatchClearGate({ enableAllowed: true, scoringDelta: { flips: 5, t1Flips: 0 } });
  assert.equal(r.proceed, true);
});

test('thresholds mirror scoring-delta (0 T1 / 5 total)', () => {
  assert.equal(DEFAULT_GATE_THRESHOLDS.maxT1Flips, 0);
  assert.equal(DEFAULT_GATE_THRESHOLDS.maxTotalFlips, 5);
});

test('BRO-2833: unmeasurable delta (flips:0 + drift / cannotAutoVerify) → blocked', () => {
  for (const scoringDelta of [
    { flips: 0, t1Flips: 0, reason: 'data-input-drift', cannotAutoVerify: true },
    { flips: 0, t1Flips: 0, dataInputDrift: true },
    { flips: 0, t1Flips: 0, cannotAutoVerify: true },
  ]) {
    const r = assessBatchClearGate({ enableAllowed: true, scoringDelta });
    assert.equal(r.proceed, false);
    assert.equal(r.reason, 'scoring-delta-cannot-verify');
  }
});

test('BRO-2609 retro: LLM scoring input change (flips:0) → blocked', () => {
  for (const scoringDelta of [
    { flips: 0, t1Flips: 0, llmInputChanged: ['scripts/lib/text-quality.js'] },
    { flips: 0, t1Flips: 0, reason: 'llm-input-changed', llmInputChanged: ['scripts/lib/excerpt-fields.js'] },
    { flips: 0, t1Flips: 0, significant: true },
  ]) {
    const r = assessBatchClearGate({ enableAllowed: true, scoringDelta });
    assert.equal(r.proceed, false);
    assert.equal(r.reason, 'scoring-delta-cannot-verify');
  }
  // An empty list is not a change.
  const ok = assessBatchClearGate({ enableAllowed: true, scoringDelta: { flips: 0, t1Flips: 0, llmInputChanged: [], significant: false } });
  assert.equal(ok.proceed, true);
});
