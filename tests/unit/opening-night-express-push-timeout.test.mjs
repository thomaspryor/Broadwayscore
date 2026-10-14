import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's
 * "Commit and push" step — same PUSH_DEADLINE_SEC-without-GIT_NET_TIMEOUT_SEC
 * gap as the other 11 cousins. Pins the exact shipped value, not a loose
 * "<90" bound (rejected in review on the original fix, commit 0b81edfabe6).
 */
test('opening-night-express push step overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value', () => {
  const step = findStep(loadWorkflow('opening-night-express.yml'), 'express', 'Commit and push');
  const env = step.env || {};
  assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
  assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
});

test('opening-night-express push step still sets its existing PUSH_DEADLINE_SEC override', () => {
  const step = findStep(loadWorkflow('opening-night-express.yml'), 'express', 'Commit and push');
  const env = step.env || {};
  assert.equal(env.PUSH_DEADLINE_SEC, '900');
});
