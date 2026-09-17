import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyJob, parseJobTimeouts } = require('./lib/cron-health.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// BRO-2534: "Weekly Video Reviews" went cron-health-chronic (no successful
// run in 3+ consecutive daily checks) because its "Commit and push" step ran
// on push-with-retry.sh's shared 240s/5-retry default despite the job
// declaring a 180-minute (10800s) timeout — scripts/cron-health-chronic-
// orchestrator.js's real-run diagnosis showed 13 of the last 20 runs failing
// there, always push-contention, never a script bug (audit-push-retry-
// budgets.js independently confirmed 97.8% of the job's timeout margin sat
// unused). This file covers the two things that failure required understanding:
// (1) the pure timeout parser the diagnosis leans on, and (2) the actual
// workflow config now stays fixed — a regression guard, not just the parser.

test('parseJobTimeouts reads timeout-minutes per top-level job from workflow YAML', () => {
  const yaml = `
name: Example Workflow
on:
  schedule:
    - cron: '0 4 * * 1'
jobs:
  video-reviews:
    name: Discover, collect, score and publish new video reviews
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
  other-job:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Some step
        run: echo hi
`;
  assert.deepEqual(parseJobTimeouts(yaml), { 'video-reviews': 180, 'other-job': 15 });
});

test('parseJobTimeouts ignores timeout-minutes lines before the jobs: block', () => {
  const yaml = `
name: Example Workflow
# timeout-minutes: 999 (a comment, not real YAML, before jobs: even starts)
jobs:
  only-job:
    timeout-minutes: 30
`;
  assert.deepEqual(parseJobTimeouts(yaml), { 'only-job': 30 });
});

test('parseJobTimeouts returns an empty map for a workflow with no timeout-minutes declared', () => {
  const yaml = `
jobs:
  bare-job:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  assert.deepEqual(parseJobTimeouts(yaml), {});
});

test('classifyJob reproduces the exact push-contention shape observed on the BRO-2534 run (34829164294, 2026-09-14)', () => {
  const job = {
    name: 'Discover, collect, score and publish new video reviews',
    conclusion: 'failure',
    steps: [
      { name: 'Checkout repository', conclusion: 'success' },
      { name: 'Discover videos', conclusion: 'success' },
      { name: 'Commit and push', conclusion: 'failure' },
      { name: 'Notify on failure', conclusion: 'success' },
    ],
  };
  assert.equal(classifyJob(job, { 'video-reviews': 180 }), 'push-contention (failed step: "Commit and push")');
});

// Regression guard for the actual fix: weekly-video-reviews.yml's "Commit and
// push" step must keep a PUSH_DEADLINE_SEC override sized for the job's real
// timeout headroom, and enough retries for that budget to matter. If either
// regresses back to push-with-retry.sh's shared 240s/5-retry default, this
// cron will go chronically stale again the same way.
test('weekly-video-reviews.yml "Commit and push" step keeps its PUSH_DEADLINE_SEC / retry budget fix', () => {
  const workflowPath = path.join(REPO_ROOT, '.github', 'workflows', 'weekly-video-reviews.yml');
  const text = fs.readFileSync(workflowPath, 'utf8');

  const timeouts = parseJobTimeouts(text);
  assert.ok(timeouts['video-reviews'] >= 60, 'video-reviews job should keep a generous timeout-minutes');

  const stepStart = text.indexOf('- name: Commit and push');
  assert.notEqual(stepStart, -1, 'expected a "Commit and push" step in weekly-video-reviews.yml');
  const nextStepStart = text.indexOf('- name:', stepStart + 1);
  const stepText = text.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart);

  const deadlineMatch = stepText.match(/PUSH_DEADLINE_SEC:\s*'?(\d+)'?/);
  assert.ok(deadlineMatch, 'Commit and push step should override PUSH_DEADLINE_SEC (shared default of 240s is undersized for a 180min job)');
  assert.ok(
    parseInt(deadlineMatch[1], 10) >= 900,
    `PUSH_DEADLINE_SEC should be >= 900s to fund real retry attempts against main-branch contention, got ${deadlineMatch[1]}`
  );

  const retryMatch = stepText.match(/push-with-retry\.sh\s+(\d+)\s+main/);
  assert.ok(retryMatch, 'Commit and push step should call push-with-retry.sh with an explicit retry count');
  assert.ok(
    parseInt(retryMatch[1], 10) >= 15,
    `push-with-retry.sh retry count should be >= 15 to match the PUSH_DEADLINE_SEC budget, got ${retryMatch[1]}`
  );
});
