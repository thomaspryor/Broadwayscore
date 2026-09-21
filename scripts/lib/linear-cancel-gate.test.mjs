// Pure-function tests for scripts/lib/linear-cancel-gate.js (BRO-3435).
// The CLI wiring — exit 7, LINEAR_CANCEL_GATE_DISABLED=1, "state actually
// moves once a reason is given" — is proved separately in a real subprocess
// by tests/unit/linear-brain-cancel-gate.test.mjs, mirroring the duplicate
// gate's own two-layer test split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CANCELED_STATE_TYPE, MIN_REASON_LENGTH, checkLinearCancelTransition } = require('./linear-cancel-gate.js');

test('not gated: any non-canceled target state passes untouched', () => {
  for (const type of ['completed', 'duplicate', 'started', 'unstarted', 'backlog', undefined]) {
    const v = checkLinearCancelTransition({ targetStateType: type, cancelReason: undefined });
    assert.equal(v.gated, false, `type=${type} must not be gated`);
    assert.equal(v.allowed, true);
  }
});

test('refused: canceled-type move with no reason at all', () => {
  const v = checkLinearCancelTransition({ targetStateType: CANCELED_STATE_TYPE });
  assert.equal(v.gated, true);
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, 'no-cancel-reason');
  assert.match(v.reason, /--cancel-reason/);
});

test('refused: reason shorter than the minimum', () => {
  const v = checkLinearCancelTransition({ targetStateType: CANCELED_STATE_TYPE, cancelReason: 'too short' });
  assert.equal('too short'.length < MIN_REASON_LENGTH, true, 'fixture must actually be under the floor');
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, 'no-cancel-reason');
});

test('refused: a valueless --cancel-reason parses to boolean true, not the literal string "true"', () => {
  // Same shape --force / --duplicate-of already guard against elsewhere in
  // this file's siblings — a trailing flag with no value parses to `true`.
  const v = checkLinearCancelTransition({ targetStateType: CANCELED_STATE_TYPE, cancelReason: true });
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, 'no-cancel-reason');
});

test('refused: an all-whitespace reason does not satisfy the floor even if it is long enough raw', () => {
  const v = checkLinearCancelTransition({
    targetStateType: CANCELED_STATE_TYPE,
    cancelReason: '                    ', // 20 spaces, trims to empty
  });
  assert.equal(v.allowed, false);
});

test('allowed: a reason at exactly the minimum length passes', () => {
  const reason = 'x'.repeat(MIN_REASON_LENGTH);
  const v = checkLinearCancelTransition({ targetStateType: CANCELED_STATE_TYPE, cancelReason: reason });
  assert.equal(v.gated, true);
  assert.equal(v.allowed, true);
  assert.equal(v.verdict, 'cancel-reason-recorded');
  assert.equal(v.reason, reason);
});

test('allowed: a real-shaped reason well over the minimum passes', () => {
  const v = checkLinearCancelTransition({
    targetStateType: CANCELED_STATE_TYPE,
    cancelReason: 'Superseded by BRO-9999 which covers the same fix with a cleaner design.',
  });
  assert.equal(v.allowed, true);
});
