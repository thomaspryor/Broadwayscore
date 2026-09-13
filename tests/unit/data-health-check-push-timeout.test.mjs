import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3068: apply the BRO-334/BRO-346 push-timeout fix to this workflow's
 * push-with-retry.sh call sites - explicitly named in the card as a
 * CRITICAL-severity workflow whose own inline comment already documented the
 * GIT_NET_TIMEOUT_SEC=90s hang (job-level comment, ~line 102) without the fix
 * ever being applied. Pins the exact shipped value, not a loose "<90" bound
 * (rejected in review on the original fix, commit 0b81edfabe6).
 *
 * Two of the four call sites ("Commit digest snapshot" and "Commit health
 * check audit snapshots") were independently given a STRONGER fix by a
 * concurrent session (BRO-2233/BRO-2951 Phase 2): PUSH_API_REST_REF_UPDATE
 * routes the push through GitHub's REST Git Data API instead of `git push`
 * entirely, so a git-transport timeout is moot there. GIT_NET_TIMEOUT_SEC
 * only applies to the remaining two sites, which still use plain `git push`.
 */

const WORKFLOW = 'data-health-check.yml';
const JOB = 'health-check';
const GIT_NET_TIMEOUT_STEPS = [
  { name: 'Commit acceptance recheck ledger', deadline: '900' },
  { name: 'Commit health check + triage data', deadline: '900' },
];
const REST_API_STEPS = [
  'Commit digest snapshot',
  'Commit health check audit snapshots (apiFallbackSafe)',
];

for (const { name, deadline } of GIT_NET_TIMEOUT_STEPS) {
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

for (const name of REST_API_STEPS) {
  test(`data-health-check "${name}" uses the REST API bypass, not GIT_NET_TIMEOUT_SEC`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.equal(env.PUSH_API_REST_REF_UPDATE, '1', 'expected the REST bypass fix, not a timeout tweak');
    assert.ok(!('GIT_NET_TIMEOUT_SEC' in env), 'GIT_NET_TIMEOUT_SEC would be moot here - REST bypasses git push entirely');
  });
}
