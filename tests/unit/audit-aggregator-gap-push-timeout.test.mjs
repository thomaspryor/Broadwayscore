import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's
 * "Commit audit JSON (public repo)" step, one of the 11 remaining
 * push-with-retry.sh call sites carrying a PUSH_DEADLINE_SEC override with no
 * matching GIT_NET_TIMEOUT_SEC override — the exact gap that let a
 * pre-transfer connection stall burn the full 90s default per attempt with
 * zero transfer progress, leaving only ~4-6 real retries inside the 900s
 * deadline. Pins the exact shipped value, not a loose "<90" bound (rejected
 * in review on the original rebuild-reviews.yml fix, commit 0b81edfabe6).
 */
test('audit-aggregator-gap push step overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value', () => {
  const step = findStep(loadWorkflow('audit-aggregator-gap.yml'), 'audit', 'Commit audit JSON (public repo)');
  const env = step.env || {};
  assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
  assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
});

test('audit-aggregator-gap push step still sets its existing PUSH_DEADLINE_SEC override', () => {
  const step = findStep(loadWorkflow('audit-aggregator-gap.yml'), 'audit', 'Commit audit JSON (public repo)');
  const env = step.env || {};
  assert.equal(env.PUSH_DEADLINE_SEC, '900');
});
