import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's
 * "Commit tracking file" step. Pins the exact shipped value, not a loose
 * "<90" bound (rejected in review on the original fix, commit 0b81edfabe6).
 */
test('process-feedback push step overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value', () => {
  const step = findStep(loadWorkflow('process-feedback.yml'), 'process-feedback', 'Commit tracking file');
  const env = step.env || {};
  assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
  assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
});

test('process-feedback push step still sets its existing PUSH_DEADLINE_SEC override', () => {
  const step = findStep(loadWorkflow('process-feedback.yml'), 'process-feedback', 'Commit tracking file');
  const env = step.env || {};
  assert.equal(env.PUSH_DEADLINE_SEC, '600');
});
