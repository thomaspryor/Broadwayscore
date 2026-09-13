import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's 4
 * push-with-retry.sh call sites — explicitly named in the card as a
 * CRITICAL-severity workflow whose own inline comment already documented the
 * GIT_NET_TIMEOUT_SEC=90s hang (job-level comment, ~line 102) without the fix
 * ever being applied. Pins the exact shipped value, not a loose "<90" bound
 * (rejected in review on the original fix, commit 0b81edfabe6).
 */

const WORKFLOW = 'data-health-check.yml';
const JOB = 'health-check';
const STEPS = [
  { name: 'Commit digest snapshot', deadline: '900' },
  { name: 'Commit health check audit snapshots (apiFallbackSafe)', deadline: '900' },
  { name: 'Commit acceptance recheck ledger', deadline: '900' },
  { name: 'Commit health check + triage data', deadline: '900' },
];

for (const { name, deadline } of STEPS) {
  test(`data-health-check "${name}" overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
    assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
  });

  test(`data-health-check "${name}" still sets its existing PUSH_DEADLINE_SEC override`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.equal(env.PUSH_DEADLINE_SEC, deadline);
  });
}
