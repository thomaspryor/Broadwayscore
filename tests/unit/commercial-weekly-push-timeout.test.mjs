import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's 4
 * push-with-retry.sh call sites, spread across 4 separate jobs. Pins the
 * exact shipped value, not a loose "<90" bound (rejected in review on the
 * original fix, commit 0b81edfabe6).
 */

const WORKFLOW = 'commercial-weekly.yml';
const STEPS = [
  { job: 'batch-research', name: 'Commit batch research results', deadline: '600' },
  { job: 'sweep-pending', name: 'Commit sweep results', deadline: '480' },
  { job: 'deep-research', name: 'Commit deep research results', deadline: '600' },
  { job: 'auto-apply', name: 'Commit applied data + audit', deadline: '600' },
];

for (const { job, name, deadline } of STEPS) {
  test(`commercial-weekly job=${job} "${name}" overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), job, name);
    const env = step.env || {};
    assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
    assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
  });

  test(`commercial-weekly job=${job} "${name}" still sets its existing PUSH_DEADLINE_SEC override`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), job, name);
    const env = step.env || {};
    assert.equal(env.PUSH_DEADLINE_SEC, deadline);
  });
}
