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
 * BRO-352 (2026-09-14) merged the former "Commit digest snapshot" step into
 * "Commit health check audit snapshots (apiFallbackSafe)". BRO-472
 * (2026-09-14) added a new REST-API step, "Commit lifetime sweep snapshots
 * (apiFallbackSafe)", that this test file previously never covered.
 *
 * BRO-471 follow-up (adversarial-review finding) corrected a wrong assumption
 * this test's prior version made: PUSH_API_REST_REF_UPDATE does NOT mean a
 * step "bypasses git push entirely." PUSH_API_FALLBACK_AFTER_ATTEMPTS=3 means
 * the local retry loop still makes 3 real `git push` attempts (at whatever
 * GIT_NET_TIMEOUT_SEC is set to) before falling back to the REST API — so
 * BOTH REST-opted-in steps now ALSO set GIT_NET_TIMEOUT_SEC=30, and are their
 * own hybrid category below rather than "REST-only, no timeout needed."
 *
 * BRO-3318 (2026-09-14) split the former "Commit health check + triage data"
 * step in two: "Commit triage data" (data/audit/triage/ alone — still
 * genuinely fallback-disqualified, GIT_NET_TIMEOUT_SEC-only, same as before)
 * and "Commit alert router state (apiFallbackMerge)" (alert-ledger.json/
 * alert-digest-queue.json/alert-router-attempts.jsonl — these 3 gained real
 * apiFallbackMerge registration back on 2026-09-04/BRO-2413 but were still
 * bundled with the disqualified triage/ directory until this split, so they
 * never actually reached the REST path they'd been registered for). The new
 * alert-router-state step joins the hybrid category below.
 */

const WORKFLOW = 'data-health-check.yml';
const JOB = 'health-check';
const GIT_NET_TIMEOUT_ONLY_STEPS = [
  { name: 'Commit acceptance recheck ledger', deadline: '900' },
  { name: 'Commit triage data', deadline: '900' },
];
const HYBRID_TIMEOUT_AND_REST_STEPS = [
  { name: 'Commit lifetime sweep snapshots (apiFallbackSafe)', deadline: '900' },
  { name: 'Commit health check audit snapshots (apiFallbackSafe)', deadline: '900' },
  { name: 'Commit alert router state (apiFallbackMerge)', deadline: '900' },
];

for (const { name, deadline } of [...GIT_NET_TIMEOUT_ONLY_STEPS, ...HYBRID_TIMEOUT_AND_REST_STEPS]) {
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

for (const { name } of HYBRID_TIMEOUT_AND_REST_STEPS) {
  test(`data-health-check "${name}" ALSO opts into the REST API fallback on top of GIT_NET_TIMEOUT_SEC`, () => {
    const step = findStep(loadWorkflow(WORKFLOW), JOB, name);
    const env = step.env || {};
    assert.equal(env.PUSH_API_REST_REF_UPDATE, '1', 'expected the REST bypass fix in addition to the timeout tweak');
  });
}
