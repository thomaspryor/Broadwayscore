import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's 3
 * push-with-retry.sh call sites, across 3 separate jobs. The "rebuild" job's
 * step had NO env: block at all before this fix (bare push-with-retry.sh
 * call, default MAX_RETRIES=7/PUSH_DEADLINE_SEC=240); it now carries an env:
 * block containing only GIT_NET_TIMEOUT_SEC — PUSH_DEADLINE_SEC is asserted
 * only where an existing override was already present. Pins the exact
 * shipped value, not a loose "<90" bound (rejected in review on the original
 * fix, commit 0b81edfabe6).
 */

const WORKFLOW = 'scrape-new-aggregators.yml';
const STEPS = [
  {
    job: 'scrape-playbill-verdict',
    name: 'Commit Playbill Verdict unmatched-articles audit + candidate staging',
    deadline: '900',
  },
  { job: 'scrape-bww-landing', name: 'Commit BWW unmatched-roundups audit', deadline: '900' },
  { job: 'rebuild', name: 'Commit and push rebuilt reviews.json', deadline: undefined },
];

for (const { job, name, deadline } of STEPS) {
  test(`scrape-new-aggregators job=${job} "${name}" overrides GIT_NET_TIMEOUT_SEC to the shipped 30s value`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), job, name);
    const env = step.env || {};
    assert.ok('GIT_NET_TIMEOUT_SEC' in env, 'GIT_NET_TIMEOUT_SEC must be set on the push step');
    assert.equal(env.GIT_NET_TIMEOUT_SEC, '30');
  });

  if (deadline !== undefined) {
    test(`scrape-new-aggregators job=${job} "${name}" still sets its existing PUSH_DEADLINE_SEC override`, () => {
      const step = findStep(loadWorkflow(WORKFLOW), job, name);
      const env = step.env || {};
      assert.equal(env.PUSH_DEADLINE_SEC, deadline);
    });
  }
}
