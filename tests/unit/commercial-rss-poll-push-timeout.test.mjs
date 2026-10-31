import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's 2
 * push-with-retry.sh call sites. Pins the exact shipped value, not a loose
 * "<90" bound (rejected in review on the original fix, commit 0b81edfabe6).
 */

const WORKFLOW = 'commercial-rss-poll.yml';
const JOB = 'poll-and-apply';
const STEPS = [
  { name: 'Commit breaker state', deadline: '300' },
  { name: 'Commit data changes', deadline: '420' },
];

for (const { name, deadline } of STEPS) {
  test(`commercial-rss-poll "${name}" overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
    assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
  });

  test(`commercial-rss-poll "${name}" still sets its existing PUSH_DEADLINE_SEC override`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.equal(env.PUSH_DEADLINE_SEC, deadline);
  });
}
