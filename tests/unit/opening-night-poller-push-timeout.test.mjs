import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's 6
 * push-with-retry.sh call sites (all in the `poll` job) — the largest single
 * concentration among the 11 remaining cousins named in the card. 3 of the 6
 * ("Commit collected texts", "Commit combined-review flags", "Commit
 * scores") had NO env: block at all before this fix; they now carry an env:
 * block containing only GIT_NET_TIMEOUT_SEC. PUSH_DEADLINE_SEC is asserted
 * only where an existing override was already present. Pins the exact
 * shipped value, not a loose "<90" bound (rejected in review on the original
 * fix, commit 0b81edfabe6).
 */

const WORKFLOW = 'opening-night-poller.yml';
const JOB = 'poll';
const STEPS = [
  { name: 'Commit poller backoff state', deadline: undefined },
  { name: 'Commit new review files', deadline: '600' },
  { name: 'Commit collected texts', deadline: undefined },
  { name: 'Commit combined-review flags', deadline: undefined },
  { name: 'Commit scores', deadline: undefined },
  { name: 'Commit and push rebuilt data (fast_path)', deadline: '600' },
];

for (const { name, deadline } of STEPS) {
  test(`opening-night-poller "${name}" overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
    assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
  });

  if (deadline !== undefined) {
    test(`opening-night-poller "${name}" still sets its existing PUSH_DEADLINE_SEC override`, () => {
      const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
      const env = step.env || {};
      assert.equal(env.PUSH_DEADLINE_SEC, deadline);
    });
  }
}
