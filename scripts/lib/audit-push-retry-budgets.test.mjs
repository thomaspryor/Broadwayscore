import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeBackoffSum,
  parseWorkflow,
  findPushRetryCalls,
  evaluateStep,
  auditWorkflowText,
  estimateCronIntervalMinutes,
  touchesManagedFile,
  managedFileInfo,
  DEFAULT_MAX_RETRIES,
  DEFAULT_DEADLINE_SEC,
} = require('./audit-push-retry-budgets.js');

// ── computeBackoffSum: N^2+4N, push-with-retry.sh's WAIT=3+i*2+jitter summed ──

test('computeBackoffSum: default MAX_RETRIES=7 sums to 77s', () => {
  assert.equal(computeBackoffSum(7), 77);
});

test('computeBackoffSum: card #1891\'s verified 20 and 25 attempt sizings', () => {
  assert.equal(computeBackoffSum(20), 480);
  assert.equal(computeBackoffSum(25), 725);
});

test('computeBackoffSum: N=0 sums to 0', () => {
  assert.equal(computeBackoffSum(0), 0);
});

// ── findPushRetryCalls ──

test('findPushRetryCalls: bare invocation defaults MAX_RETRIES to 7, not soft-fail', () => {
  const calls = findPushRetryCalls('bash scripts/lib/push-with-retry.sh\n');
  assert.deepEqual(calls, [{ inlineDeadlineSec: null, maxRetries: 7, softFail: false }]);
});

test('findPushRetryCalls: positional retries + branch arg', () => {
  const calls = findPushRetryCalls('bash scripts/lib/push-with-retry.sh 25 main\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxRetries, 25);
});

test('findPushRetryCalls: trailing || echo marks the call softFail (tolerated failure)', () => {
  const calls = findPushRetryCalls('bash scripts/lib/push-with-retry.sh 5 main || echo "::warning::failed"\n');
  assert.equal(calls[0].maxRetries, 5);
  assert.equal(calls[0].softFail, true);
});

test('findPushRetryCalls: trailing || true also marks softFail', () => {
  const calls = findPushRetryCalls('bash scripts/lib/push-with-retry.sh 3 main || true\n');
  assert.equal(calls[0].softFail, true);
});

test('findPushRetryCalls: a bash comment merely MENTIONING push-with-retry.sh is not a call (card #1910 review finding)', () => {
  const runText = [
    '# a `cd data` cwd would make it look for a nonexistent push-with-retry.sh',
    '# caller; this comment is prose, not an invocation',
    'echo "nothing to push here"',
  ].join('\n');
  assert.deepEqual(findPushRetryCalls(runText), []);
});

test('findPushRetryCalls: a real call is still found even when a misleading comment precedes it', () => {
  const runText = [
    '# see push-with-retry.sh docs for details',
    'bash scripts/lib/push-with-retry.sh 5 main',
  ].join('\n');
  const calls = findPushRetryCalls(runText);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxRetries, 5);
});

test('findPushRetryCalls: no call present returns empty', () => {
  assert.deepEqual(findPushRetryCalls('git commit -m "no push here"\n'), []);
});

// ── evaluateStep: margin + retry/deadline flags ──

test('evaluateStep: shared defaults (7 retries / 240s deadline) flag retries-undersized-vs-deadline', () => {
  const r = evaluateStep({ maxRetries: DEFAULT_MAX_RETRIES, deadlineSec: DEFAULT_DEADLINE_SEC, jobTimeoutMinutes: 60 });
  assert.ok(r.flags.includes('retries-undersized-vs-deadline'));
  assert.equal(r.backoffSum, 77);
});

test('evaluateStep: card #1891 sizing (25 retries / 900s deadline) does not flag retries-undersized', () => {
  const r = evaluateStep({ maxRetries: 25, deadlineSec: 900, jobTimeoutMinutes: 60 });
  assert.ok(!r.flags.includes('retries-undersized-vs-deadline'));
});

test('evaluateStep: tight job timeout flags job-timeout-margin-undersized (rebuild-reviews.yml pre-follow-up-fix shape)', () => {
  // 25 retries / 900s deadline, 30min (1800s) job, one other step with an
  // explicit 12min (720s) timeout — the exact numbers from commit 6a4a47f40f3's
  // description: 900+720=1620s of 1800s consumed, 180s (10%) margin.
  const r = evaluateStep({ maxRetries: 25, deadlineSec: 900, jobTimeoutMinutes: 30, otherStepsBudgetSec: 720 });
  assert.equal(r.marginSec, 180);
  assert.equal(Math.round(r.marginRatio * 1000) / 1000, 0.1);
  assert.ok(r.flags.includes('job-timeout-margin-undersized'));
});

test('evaluateStep: same shape at 40min job timeout (the actual #1891 follow-up fix) clears the flag', () => {
  const r = evaluateStep({ maxRetries: 25, deadlineSec: 900, jobTimeoutMinutes: 40, otherStepsBudgetSec: 720 });
  assert.equal(r.marginSec, 780);
  assert.equal(r.marginRatio, 0.325);
  assert.ok(!r.flags.includes('job-timeout-margin-undersized'));
});

test('evaluateStep: backoffSum exceeding deadlineSec becomes the step budget (misconfigured-high-retries case)', () => {
  // 50 retries sums to 2700s, far past a 300s deadline — the loop would be cut
  // by the deadline in practice, but stepBudgetSec should reflect the LARGER
  // configured number since that's what a caller relying on retries completing
  // would need job-timeout headroom for.
  const r = evaluateStep({ maxRetries: 50, deadlineSec: 300, jobTimeoutMinutes: 60 });
  assert.equal(r.stepBudgetSec, 2700);
});

// ── touchesManagedFile / managedFileInfo / estimateCronIntervalMinutes ──

test('touchesManagedFile: detects a MANAGED core-data basename in run text', () => {
  assert.equal(touchesManagedFile('git add -u data/audit/scraper-spend-ledger.jsonl'), true);
  assert.equal(touchesManagedFile('git add -u data/some-unrelated-file.json'), false);
});

test('managedFileInfo: apiFallbackSafe reflects the registry\'s own claim for the exact file touched', () => {
  // audit/imageless-scored-shows.json is registry-verified apiFallbackSafe: true;
  // scraper-spend-ledger.jsonl is NOT (genuinely multi-writer, no safe fallback).
  assert.deepEqual(managedFileInfo('git add data/audit/imageless-scored-shows.json'), { touches: true, apiFallbackSafe: true });
  assert.deepEqual(managedFileInfo('git add data/audit/scraper-spend-ledger.jsonl'), { touches: true, apiFallbackSafe: false });
});

test('managedFileInfo: a basename that is a SUBSTRING of another managed basename does not false-positive-match the other (card #1910 review regression)', () => {
  // 'shows.json' is a real managed basename and is also a literal substring of
  // 'audit/imageless-scored-shows.json' — naive runText.includes(base) matching
  // wrongly credited/blamed the wrong file's apiFallbackSafe value here.
  const r = managedFileInfo('git add data/audit/imageless-scored-shows.json');
  assert.equal(r.apiFallbackSafe, true, 'must reflect imageless-scored-shows.json\'s own true, not shows.json\'s false');
});

test('managedFileInfo: plain shows.json (not the imageless-scored variant) is correctly NOT apiFallbackSafe', () => {
  assert.deepEqual(managedFileInfo('git add data/shows.json'), { touches: true, apiFallbackSafe: false });
});

test('estimateCronIntervalMinutes: */15 * * * * -> 15 minutes', () => {
  const text = "on:\n  schedule:\n    - cron: '*/15 * * * *'\n";
  assert.equal(estimateCronIntervalMinutes(text), 15);
});

test('estimateCronIntervalMinutes: fixed daily time treated as low-frequency', () => {
  const text = "on:\n  schedule:\n    - cron: '30 6 * * *'\n";
  assert.equal(estimateCronIntervalMinutes(text), 1440);
});

test('estimateCronIntervalMinutes: no schedule trigger returns null', () => {
  assert.equal(estimateCronIntervalMinutes('on:\n  workflow_dispatch:\n'), null);
});

// ── parseWorkflow + auditWorkflowText end-to-end against a fixture ──

const FIXTURE_UNDERSIZED = `
name: Fixture Undersized
on:
  schedule:
    - cron: '*/10 * * * *'
jobs:
  fixture:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Extract pull quotes for new reviews
        timeout-minutes: 12
        run: |
          node scripts/extract-pull-quotes.js
      - name: Commit and push changes
        env:
          PUSH_DEADLINE_SEC: '900'
        run: |
          git add -u data/audit/scraper-spend-ledger.jsonl
          bash scripts/lib/push-with-retry.sh 25 main
`;

test('auditWorkflowText: end-to-end fixture reproduces the #1891 job-timeout-margin flag', () => {
  const results = auditWorkflowText(FIXTURE_UNDERSIZED, 'fixture-undersized.yml');
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.job, 'fixture');
  assert.equal(r.step, 'Commit and push changes');
  assert.equal(r.maxRetries, 25);
  assert.equal(r.deadlineSec, 900);
  assert.equal(r.otherStepsBudgetSec, 720);
  assert.equal(r.marginSec, 180);
  assert.ok(r.flags.includes('job-timeout-margin-undersized'));
  assert.equal(r.touchesManagedFile, true);
  assert.equal(r.cronIntervalMinutes, 10);
  assert.ok(r.contentionScore >= 4); // managed(+2) + frequent-cron(+2) + margin-flag(+2), retries not flagged here
});

const FIXTURE_BARE_DEFAULT = `
name: Fixture Bare Default
on:
  workflow_dispatch: {}
jobs:
  fixture:
    runs-on: ubuntu-latest
    steps:
      - name: Commit and push changes
        run: |
          git add -u data/some-report.json
          bash scripts/lib/push-with-retry.sh
`;

test('auditWorkflowText: bare invocation with no overrides flags retries-undersized-vs-deadline', () => {
  const results = auditWorkflowText(FIXTURE_BARE_DEFAULT, 'fixture-bare-default.yml');
  assert.equal(results.length, 1);
  assert.equal(results[0].maxRetries, DEFAULT_MAX_RETRIES);
  assert.equal(results[0].deadlineSec, DEFAULT_DEADLINE_SEC);
  assert.ok(results[0].flags.includes('retries-undersized-vs-deadline'));
  assert.equal(results[0].touchesManagedFile, false);
});

const FIXTURE_NO_PUSH_STEP = `
name: Fixture No Push
on:
  workflow_dispatch: {}
jobs:
  fixture:
    runs-on: ubuntu-latest
    steps:
      - name: Just does something else
        run: |
          echo "nothing to push here"
`;

test('auditWorkflowText: workflow with no push-with-retry.sh call returns no results', () => {
  assert.deepEqual(auditWorkflowText(FIXTURE_NO_PUSH_STEP, 'fixture-no-push.yml'), []);
});

test('parseWorkflow: malformed/no jobs: key returns empty jobs array instead of throwing', () => {
  assert.deepEqual(parseWorkflow('name: not-a-real-workflow\n'), { jobs: [] });
});

test('parseWorkflow: job timeout-minutes defaults to GitHub Actions\' own 360 when omitted', () => {
  const parsed = parseWorkflow(FIXTURE_BARE_DEFAULT);
  assert.equal(parsed.jobs[0].timeoutMinutes, 360);
});

// ── sibling push-step margin aggregation (card #1910 review finding) ──
// A job with SEVERAL push-with-retry.sh steps can exhaust its timeout on the
// SUM of all of them even when none is individually flagged — the first
// draft only summed explicit-timeout-minutes siblings into otherStepsBudgetSec,
// missing every sibling push step's own (undeclared) budget.

const FIXTURE_MULTI_PUSH_JOB = `
name: Fixture Multi Push
on:
  workflow_dispatch: {}
jobs:
  fixture:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Commit A
        env:
          PUSH_DEADLINE_SEC: '600'
        run: |
          bash scripts/lib/push-with-retry.sh 25 main
      - name: Commit B
        env:
          PUSH_DEADLINE_SEC: '600'
        run: |
          bash scripts/lib/push-with-retry.sh 25 main
`;

test('auditWorkflowText: sibling push steps in the same job are summed into each other\'s margin check', () => {
  const results = auditWorkflowText(FIXTURE_MULTI_PUSH_JOB, 'fixture-multi-push.yml');
  assert.equal(results.length, 2);
  // Each step's own stepBudgetSec is max(600, 725)=725; the OTHER step's
  // stepBudgetSec (725) must appear as otherStepsBudgetSec, not 0 — job
  // timeout is 1200s, so 1200-(725+725) is deeply negative -> flagged.
  for (const r of results) {
    assert.equal(r.stepBudgetSec, 725);
    assert.equal(r.otherStepsBudgetSec, 725);
    assert.ok(r.marginRatio < 0, 'two 725s-budget push steps must blow a 1200s job timeout');
    assert.ok(r.flags.includes('job-timeout-margin-undersized'));
  }
});

// ── continue-on-error treated as soft-fail (card #1910 review finding) ──

const FIXTURE_CONTINUE_ON_ERROR = `
name: Fixture Continue On Error
on:
  workflow_dispatch: {}
jobs:
  fixture:
    runs-on: ubuntu-latest
    steps:
      - name: Commit optional state
        continue-on-error: true
        run: |
          bash scripts/lib/push-with-retry.sh
`;

test('parseWorkflow: continue-on-error: true is captured on the step', () => {
  const parsed = parseWorkflow(FIXTURE_CONTINUE_ON_ERROR);
  assert.equal(parsed.jobs[0].steps[0].continueOnError, true);
});

test('auditWorkflowText: continue-on-error: true step is treated as softFail like a `|| echo` wrapper', () => {
  const results = auditWorkflowText(FIXTURE_CONTINUE_ON_ERROR, 'fixture-continue-on-error.yml');
  assert.equal(results[0].softFail, true);
});

test('auditWorkflowText: a step WITHOUT continue-on-error or || echo is NOT softFail', () => {
  const results = auditWorkflowText(FIXTURE_BARE_DEFAULT, 'fixture-bare-default.yml');
  assert.equal(results[0].softFail, false);
});
