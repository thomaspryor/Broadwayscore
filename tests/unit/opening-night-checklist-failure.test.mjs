import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// BRO-369: opening-night-checklist.yml failed 3x in 24h (runs 33925219166,
// 33934756338, 33992585696) with conclusion=failure — the "Commit opening
// night state (apiFallbackSafe)" step ran on push-with-retry.sh's shared
// 240s PUSH_DEADLINE_SEC default, which its own sizing comment (task #458)
// says fits only ~1.3 real fetch-rebase-merge cycles under this repo's high
// main-branch commit churn. All 3 failures show the same shape: local push
// exhausted after ~2 attempts, then the Git Data API fallback ALSO timed out
// on both of its auto-scaled attempts.
//
// Fix (workflow-YAML only — never raise push-with-retry.sh's shared
// default, per its own comment): both commit steps now set
// PUSH_DEADLINE_SEC/PUSH_API_MAX_RETRIES AND wrap the push-with-retry.sh
// call in an explicit `timeout -k 10 N` — a Codex adversarial-review finding
// caught that the env vars alone don't bound a step's total wall time (the
// Git Data API fallback's retries run OUTSIDE PUSH_DEADLINE_SEC), so the
// outer `timeout` is the actual enforced ceiling. The job's timeout-minutes
// was sized from those two hard ceilings, not from the env vars alone.
//
// This test pins the regression guard structurally against the real
// workflow YAML, mirroring tests/unit/opening-night-checklist-push.test.mjs.
// Bounds are deliberately tight (not just "greater than the old broken
// value") so a future edit that silently drifts the contract (e.g. cranks
// PUSH_API_MAX_RETRIES up unboundedly, or drops the outer timeout wrapper
// while leaving the env vars in place) fails here.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'opening-night-checklist.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

function getStepBody(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stepMatch = workflowText.match(new RegExp(`name:\\s*${escaped}[\\s\\S]*?(?=\\n {6}- name:|\\n {4}- name:|$)`));
  assert.ok(stepMatch, `could not locate the "${name}" step body`);
  return stepMatch[0];
}

function assertBoundedPushBudget(stepBody, label, { minDeadline, maxDeadline, minRetries, maxRetries, minTimeoutSec, maxTimeoutSec }) {
  const deadlineMatch = stepBody.match(/PUSH_DEADLINE_SEC:\s*['"]?(\d+)['"]?/);
  assert.ok(deadlineMatch, `${label}: must set env.PUSH_DEADLINE_SEC — without it the step inherits push-with-retry.sh's shared 240s default, too tight for this workflow's commit contention (BRO-369)`);
  const deadlineSec = Number(deadlineMatch[1]);
  assert.ok(deadlineSec >= minDeadline && deadlineSec <= maxDeadline, `${label}: PUSH_DEADLINE_SEC is ${deadlineSec}s, expected between ${minDeadline}-${maxDeadline}s`);

  const apiRetriesMatch = stepBody.match(/PUSH_API_MAX_RETRIES:\s*['"]?(\d+)['"]?/);
  assert.ok(apiRetriesMatch, `${label}: must set an explicit env.PUSH_API_MAX_RETRIES so the Git Data API fallback's worst case is calculable rather than left to push-with-retry.sh's auto-scaling`);
  const apiRetries = Number(apiRetriesMatch[1]);
  assert.ok(apiRetries >= minRetries && apiRetries <= maxRetries, `${label}: PUSH_API_MAX_RETRIES is ${apiRetries}, expected between ${minRetries}-${maxRetries} — 0 disables the fallback entirely, and an unbounded value defeats the point of setting this explicitly`);

  // Codex adversarial review finding: PUSH_DEADLINE_SEC only bounds
  // push-with-retry.sh's LOCAL retry loop — the Git Data API fallback's own
  // retries run OUTSIDE that budget — so an outer OS-enforced `timeout` is
  // the actual ceiling on this step's total wall time, not the env vars.
  const timeoutMatch = stepBody.match(/timeout\s+-k\s+\d+\s+(\d+)\s+bash\s+scripts\/lib\/push-with-retry\.sh/);
  assert.ok(timeoutMatch, `${label}: the push-with-retry.sh call must be wrapped in an outer \`timeout -k <grace> <secs>\` — PUSH_DEADLINE_SEC alone does not bound the Git Data API fallback's retry time`);
  const timeoutSec = Number(timeoutMatch[1]);
  assert.ok(timeoutSec >= minTimeoutSec && timeoutSec <= maxTimeoutSec, `${label}: outer timeout is ${timeoutSec}s, expected between ${minTimeoutSec}-${maxTimeoutSec}s`);
}

test('workflow: job timeout-minutes is sized between the fixed floor and a sane ceiling', () => {
  const m = /^jobs:\s*\n\s*checklist:\s*\n(?:[^\n]*\n)*?\s*timeout-minutes:\s*(\d+)/m.exec(workflowText);
  assert.ok(m, 'could not find jobs.checklist.timeout-minutes in opening-night-checklist.yml');
  const timeoutMinutes = Number(m[1]);
  assert.ok(
    timeoutMinutes >= 18 && timeoutMinutes <= 30,
    `jobs.checklist.timeout-minutes is ${timeoutMinutes}, expected 18-30 — below 18 reproduces BRO-369 (no room for push retries to fail cleanly before being hard-killed), above 30 is unjustified padding and increases the documented 3-deep concurrency-queue cancellation exposure for no measured benefit`
  );
});

test('workflow: the apiFallbackSafe state commit step has a bounded, provable push budget', () => {
  const stepBody = getStepBody('Commit opening night state (apiFallbackSafe)');
  assertBoundedPushBudget(stepBody, 'apiFallbackSafe step', {
    minDeadline: 300, maxDeadline: 600,
    minRetries: 1, maxRetries: 3,
    minTimeoutSec: 300, maxTimeoutSec: 600,
  });
});

test('workflow: the shared audit telemetry commit step also has a bounded, provable push budget', () => {
  // Codex adversarial review finding: this step was left with NO override in
  // the first draft of this fix, reasoning it "almost always has nothing to
  // commit" — but under the SAME high-churn window that breaks the sibling
  // step, this one could too, and unbounded it could blow the job timeout
  // stacked after the sibling step's own worst case. It's biased toward
  // failing fast (small budget) rather than the sibling's "worth waiting
  // longer" bias, because this data is recoverable next hour.
  const stepBody = getStepBody('Commit shared audit telemetry');
  assertBoundedPushBudget(stepBody, 'shared audit telemetry step', {
    minDeadline: 60, maxDeadline: 240,
    minRetries: 1, maxRetries: 2,
    minTimeoutSec: 60, maxTimeoutSec: 300,
  });
});

test('workflow: PUSH_DEADLINE_SEC is not raised on the shared push-with-retry.sh script itself', () => {
  const pushRetryPath = path.join(repoRoot, 'scripts', 'lib', 'push-with-retry.sh');
  const pushRetryText = fs.readFileSync(pushRetryPath, 'utf8');
  const m = /PUSH_DEADLINE_SEC=\$\{PUSH_DEADLINE_SEC:-(\d+)\}/.exec(pushRetryText);
  assert.ok(m, 'could not find the shared PUSH_DEADLINE_SEC default in push-with-retry.sh');
  assert.equal(
    Number(m[1]),
    240,
    'the shared push-with-retry.sh default must stay at 240s — its own sizing comment (task #458) explicitly says not to raise it, since ~15 other callers with 5-10min job timeouts rely on the tight default to fail fast; BRO-369\'s fix overrides the deadline per-caller in the workflow YAML instead'
  );
});
