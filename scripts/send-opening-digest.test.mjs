// BRO-2531: the 2026-08-27 opening digest never sent. Root cause was in the
// workflow, not the script — actions/checkout@v5 stalled on a transient
// runner hiccup and consumed the entire `timeout-minutes: 8` job budget
// (normal end-to-end runtime is ~1 minute), so the job was cancelled before
// "Send opening digest" ever ran. Because a job-timeout cancellation reports
// step conclusions as `cancelled`, not `failure` (.github/workflows/CLAUDE.md
// "Actionlint" section), the `if: failure()` on "Notify on failure" also
// never fired — the miss surfaced 4 days later only via the independent
// scripts/monitor-scheduled-email-count.js Resend-history check.
//
// This pins the two workflow-level fixes so neither regresses silently:
//   1. The job timeout has real margin above normal runtime (was 8min with
//      ~0 margin over a ~1min job; raised to 15min).
//   2. The failure-notification step also fires on cancellation, matching the
//      documented `failure() || cancelled()` pattern used elsewhere in this
//      repo (e.g. test.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'opening-digest.yml');

function loadWorkflow() {
  return yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf-8'));
}

test('opening-digest.yml job timeout has real margin over normal runtime', () => {
  const wf = loadWorkflow();
  const job = wf.jobs['send-digest'];
  assert.ok(job, 'send-digest job must exist in opening-digest.yml');
  // Normal end-to-end runtime is ~1 minute (checkout + setup-node + core-data
  // checkout + send, observed across successful runs). A too-tight timeout
  // turns any transient checkout/runner hiccup into a full silent miss with
  // no email sent and no in-flight failure signal.
  assert.ok(
    job['timeout-minutes'] >= 15,
    `job timeout-minutes (${job['timeout-minutes']}) must stay >= 15 — the 2026-08-27 miss happened at 8min with a ~1min normal runtime`,
  );
});

test('opening-digest.yml notifies on both failure and cancellation', () => {
  const wf = loadWorkflow();
  const job = wf.jobs['send-digest'];
  const notifyStep = (job.steps || []).find((s) => s.name === 'Notify on failure');
  assert.ok(notifyStep, '"Notify on failure" step must exist');
  // A bare `if: failure()` never fires when the job is cancelled by its own
  // timeout-minutes — exactly what happened 2026-08-27. Require cancelled()
  // to be part of the condition so a future timeout still reaches the alert
  // step (belt-and-suspenders alongside the independent Resend-history
  // monitor in scripts/monitor-scheduled-email-count.js, which is what
  // actually caught this incident).
  const condition = String(notifyStep.if || '');
  assert.match(
    condition,
    /cancelled\(\)/,
    `"Notify on failure" if-condition ("${condition}") must include cancelled(), not just failure()`,
  );
});
