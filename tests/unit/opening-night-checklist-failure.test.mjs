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
// on both of its auto-scaled attempts. Fix: override PUSH_DEADLINE_SEC +
// PUSH_API_MAX_RETRIES at the call site (per push-with-retry.sh's own
// guidance — never raise the shared default) and widen the job timeout so a
// genuine worst case fails cleanly (conclusion=failure, notify-failure
// fires) instead of being hard-killed by the job timeout (conclusion=
// cancelled, which scripts/health-check.js's repeatFailureResults() does not
// count and which starves if:always() steps of runtime).
//
// This test pins the regression guard structurally against the real
// workflow YAML, mirroring tests/unit/opening-night-checklist-push.test.mjs.

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'opening-night-checklist.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

const MIN_TIMEOUT_MINUTES = 18;
const MIN_PUSH_DEADLINE_SEC = 360;

test('workflow: job timeout-minutes gives the commit step real headroom past the shared push-with-retry.sh default', () => {
  const m = /^jobs:\s*\n\s*checklist:\s*\n(?:[^\n]*\n)*?\s*timeout-minutes:\s*(\d+)/m.exec(workflowText);
  assert.ok(m, 'could not find jobs.checklist.timeout-minutes in opening-night-checklist.yml');
  const timeoutMinutes = Number(m[1]);
  assert.ok(
    timeoutMinutes >= MIN_TIMEOUT_MINUTES,
    `jobs.checklist.timeout-minutes is ${timeoutMinutes}, expected >= ${MIN_TIMEOUT_MINUTES} — the original 10min timeout left no room for the commit step's push retries to fail cleanly before being hard-killed (BRO-369)`
  );
});

test('workflow: the apiFallbackSafe commit step overrides PUSH_DEADLINE_SEC above the shared 240s default', () => {
  const stepMatch = workflowText.match(/name:\s*Commit opening night state \(apiFallbackSafe\)[\s\S]*?(?=\n {6}- name:|\n {4}- name:|$)/);
  assert.ok(stepMatch, 'could not locate the "Commit opening night state (apiFallbackSafe)" step body');
  const stepBody = stepMatch[0];

  const deadlineMatch = stepBody.match(/PUSH_DEADLINE_SEC:\s*['"]?(\d+)['"]?/);
  assert.ok(deadlineMatch, 'apiFallbackSafe step must set env.PUSH_DEADLINE_SEC — without it the step inherits push-with-retry.sh\'s shared 240s default, which BRO-369\'s 3 real failures show is too tight for this workflow\'s commit contention');
  const deadlineSec = Number(deadlineMatch[1]);
  assert.ok(
    deadlineSec >= MIN_PUSH_DEADLINE_SEC,
    `apiFallbackSafe step's PUSH_DEADLINE_SEC is ${deadlineSec}s, expected >= ${MIN_PUSH_DEADLINE_SEC}s`
  );

  const apiRetriesMatch = stepBody.match(/PUSH_API_MAX_RETRIES:\s*['"]?(\d+)['"]?/);
  assert.ok(apiRetriesMatch, 'apiFallbackSafe step must set an explicit env.PUSH_API_MAX_RETRIES so the Git Data API fallback\'s worst case is calculable rather than left to push-with-retry.sh\'s auto-scaling');
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
