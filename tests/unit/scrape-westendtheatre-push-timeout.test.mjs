import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's
 * "Commit data changes" step. Pins the exact shipped value, not a loose
 * "<90" bound (rejected in review on the original fix, commit 0b81edfabe6).
 */
test('scrape-westendtheatre push step overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value', () => {
  const step = findStep(loadWorkflow('scrape-westendtheatre.yml'), 'scrape-westendtheatre', 'Commit data changes');
  const env = step.env || {};
  assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
  assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
});

test('scrape-westendtheatre push step still sets its existing PUSH_DEADLINE_SEC override', () => {
  const step = findStep(loadWorkflow('scrape-westendtheatre.yml'), 'scrape-westendtheatre', 'Commit data changes');
  const env = step.env || {};
  assert.equal(env.PUSH_DEADLINE_SEC, '600');
});
