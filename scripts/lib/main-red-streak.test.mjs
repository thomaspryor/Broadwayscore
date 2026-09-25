import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessMainRedStreak, failingJobsFromNeeds,
  stepFailureSignature, firstFailingTestNameInJobLog, isBashIntegrationStep, failingStepSignatures, signaturesToResolve,
  trackSignatureAbsence, jobNameFromRedKey, STALE_ABSENT_RUN_THRESHOLD,
} = require('./main-red-streak.js');

const NOW = Date.parse('2026-08-17T15:40:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const run = (headSha, minutesAgo, conclusion, jobs) => ({ headSha, createdAt: ago(minutesAgo), conclusion, jobs });

const testJob = (name, conclusion, steps) => ({ name, conclusion, steps });
const failedStep = (name) => ({ name, conclusion: 'failure' });
const okStep = (name) => ({ name, conclusion: 'success' });

test('a clean green history produces no alert', () => {
  const runs = [
    run('aaa111222', 10, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests'), okStep('Complete job')])]),
    run('bbb333444', 70, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
    run('ccc555666', 130, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW);
  assert.equal(r.alarm, null);
  assert.equal(r.redRunCount, 0);
});

test('a streak longer than the threshold produces exactly ONE alert naming the failing job and the FIRST red commit', () => {
  // main went red 04:05 (5h35m before "now" = 15:40), several pushes since,
  // none of them fixed it. Newest-first, matching gh run list.
  const failingJobSteps = [okStep('Set up job'), failedStep('Run tests'), okStep('Complete job')];
  const runs = [
    run('newest999', 5, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]),
    run('middle555', 60, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]),
    run('cd8e65911', 335, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]), // first red — 04:05
    run('0179cd0e0', 391, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]), // last green — 03:09
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.notEqual(r.alarm, null);
  assert.match(r.alarm, /"unit-tests"/);
  assert.match(r.alarm, /cd8e65911/);
  assert.doesNotMatch(r.alarm, /newest999/);
  assert.equal(r.firstRedSha, 'cd8e65911');
  assert.equal(r.redRunCount, 3);
  assert.ok(r.redStreakHours > 2);
});

test('a streak shorter than the threshold is silent', () => {
  const failingJobSteps = [okStep('Set up job'), failedStep('Run tests')];
  const runs = [
    run('newest999', 20, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]),
    run('older8888', 50, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]),
    run('lastgreen', 90, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.equal(r.alarm, null);
  assert.ok(r.redStreakHours < 2);
});

test('an infrastructure-only failure (job died in "Set up job") does not count toward the streak', () => {
  // run 32044013575: HTTP 429 fetching actions/github-script during "Set up
  // job" — zero tests ran. Must not be treated as evidence main is broken,
  // and must not be treated as a green reset either.
  const infraSteps = [failedStep('Set up job')];
  const runs = [
    run('32044013575', 30, 'failure', [testJob('unit-tests', 'failure', infraSteps)]),
    run('realred22222', 60, 'failure', [testJob('unit-tests', 'failure', [okStep('Set up job'), failedStep('Run tests')])]),
    run('lastgreen3333', 100, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  // Only the one real red run counts — well under the 2h threshold anchored
  // to the last green (100min ago), so still silent.
  assert.equal(r.redRunCount, 1);
  assert.equal(r.firstRedSha, 'realred22222');
  assert.equal(r.alarm, null);

  // Now push the real red further back so the (infra-filtered) streak DOES
  // cross the threshold — the infra run must still be excluded from the count
  // and from naming the failing commit.
  const runsLong = [
    run('32044013575', 10, 'failure', [testJob('unit-tests', 'failure', infraSteps)]),
    run('realred22222', 150, 'failure', [testJob('unit-tests', 'failure', [okStep('Set up job'), failedStep('Run tests')])]),
    run('lastgreen3333', 200, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const rLong = assessMainRedStreak(runsLong, NOW, 2);
  assert.notEqual(rLong.alarm, null);
  assert.equal(rLong.redRunCount, 1);
  assert.equal(rLong.firstRedSha, 'realred22222');
  assert.doesNotMatch(rLong.alarm, /32044013575/);
});

test('a cancellation WITH explicit evidence every job also just cancelled (no failure) does not count toward the streak', () => {
  const runs = [
    run('cancelled11', 15, 'cancelled', [testJob('unit-tests', 'cancelled', [])]),
    run('lastgreen222', 40, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.equal(r.alarm, null);
  assert.equal(r.redRunCount, 0);
});

test('a job-level TIMEOUT (cancelled job, failing step inside) counts red — it is not a supersession', () => {
  // GitHub reports a job that hit timeout-minutes with conclusion 'cancelled',
  // identically to one cancelled by supersession, but its STEPS keep the
  // failures it accumulated first. Judging on job conclusions alone scored
  // these benign, so main failed on every push with alarm:null.
  // Real incident, main 2026-09-01: runs 33466229004 / 33469747007 /
  // 33471909555, Data Validation ~35m against timeout-minutes: 30, job
  // conclusion 'cancelled', step "Validate provisional show venue+dates
  // against Playbill" conclusion 'failure'.
  const runs = [
    run('timedout777', 15, 'cancelled', [
      testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')]),
      testJob('data-validation', 'cancelled', [okStep('Set up job'), failedStep('Validate provisional show venue+dates against Playbill')]),
    ]),
    run('lastgreen777', 200, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.notEqual(r.alarm, null);
  assert.equal(r.redRunCount, 1);
  assert.equal(r.firstRedSha, 'timedout777');
});

test('a genuine supersession (cancelled job, NO failing step) still does not count — the timeout fix must not over-trigger', () => {
  const runs = [
    run('superseded88', 15, 'cancelled', [
      testJob('unit-tests', 'cancelled', [okStep('Set up job')]),
      testJob('data-validation', 'cancelled', [okStep('Set up job')]),
    ]),
    run('lastgreen888', 200, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.equal(r.alarm, null);
  assert.equal(r.redRunCount, 0);
});

test('a mid-flight cancel that stamps later always()-steps "failure" is NOT red (phantom failures)', () => {
  // When the runner cancels a job in flight, GitHub marks every remaining
  // `if: always()` step 'failure' with zero duration even though it never ran.
  // Observed on run 33416106078: Data Validation was cancelled during Checkout
  // (step 2 'cancelled'), then steps 13-53 all reported 'failure' at an
  // identical timestamp. Nothing failed and no test executed, so counting these
  // would be the same class of false positive isSetupJobOnlyFailure prevents.
  const runs = [
    run('phantom555', 15, 'cancelled', [
      testJob('data-validation', 'cancelled', [
        { name: 'Set up job', conclusion: 'success', number: 1 },
        { name: 'Checkout', conclusion: 'cancelled', number: 2 },
        { name: 'Audit something (if: always())', conclusion: 'failure', number: 13 },
        { name: 'Audit something else (if: always())', conclusion: 'failure', number: 14 },
      ]),
    ]),
    run('lastgreen555', 200, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.equal(r.alarm, null);
  assert.equal(r.redRunCount, 0);
});

test('a REAL failure before the cancel point still counts red even though later steps are phantom', () => {
  // The discriminator is ordering, not presence: a genuine failure precedes the
  // first cancelled step. This is the shape that must stay red.
  const runs = [
    run('realthencancel66', 15, 'cancelled', [
      testJob('data-validation', 'cancelled', [
        { name: 'Set up job', conclusion: 'success', number: 1 },
        { name: 'Validate provisional show venue+dates against Playbill', conclusion: 'failure', number: 16 },
        { name: 'Later step killed by the cancel', conclusion: 'cancelled', number: 54 },
      ]),
    ]),
    run('lastgreen666', 200, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.notEqual(r.alarm, null);
  assert.equal(r.redRunCount, 1);
  assert.equal(r.firstRedSha, 'realthencancel66');
});

test('a cancellation with NO job evidence counts as red, not benign (absence of evidence must not manufacture a pass)', () => {
  // Earlier version of isBenignCancellation defaulted an unexplained
  // cancellation to benign — the same "absence of evidence buys an excuse"
  // mistake isInfraOnlyFailure is careful to avoid. A cancelled run we have
  // zero job data for could just as easily be a real hang that got killed.
  const runs = [
    run('cancelled99', 20, 'cancelled', undefined),
    run('lastgreen444', 200, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.notEqual(r.alarm, null);
  assert.equal(r.redRunCount, 1);
  assert.equal(r.firstRedSha, 'cancelled99');
});

test('no green run anywhere in the queried window still anchors on the oldest red run', () => {
  const failingJobSteps = [okStep('Set up job'), failedStep('Run tests')];
  const runs = [
    run('newest999', 10, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]),
    run('oldest8888', 300, 'failure', [testJob('unit-tests', 'failure', failingJobSteps)]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.notEqual(r.alarm, null);
  assert.equal(r.firstRedSha, 'oldest8888');
  assert.equal(r.lastGreenAt, null);
});

test('no runs at all is silent, not a crash', () => {
  const r = assessMainRedStreak([], NOW);
  assert.equal(r.alarm, null);
  assert.equal(r.redRunCount, 0);
});

test('an in-progress run reported with conclusion "" (not null) does not fire a false alarm', () => {
  // Regression pin: `gh run list --json conclusion` reports an in-progress
  // run's conclusion as an EMPTY STRING, confirmed live via `gh run view
  // <id> --json status,conclusion` -> {"conclusion":"","status":"in_progress"}.
  // A version of classify() that checked only `run.conclusion == null`
  // treated '' as neither success nor still-running and fell through to
  // 'red', firing a false alarm on every currently-running push.
  const runs = [
    run('inprogress11', 2, '', undefined),
    run('inprogress22', 12, '', undefined),
    run('lastgreen5555', 30, 'success', [testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run tests')])]),
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.equal(r.alarm, null);
  assert.equal(r.redRunCount, 0);
});

test('failingJobsFromNeeds returns empty string when every job in `needs` succeeded or was skipped', () => {
  const needs = { 'unit-tests': { result: 'success' }, 'dependency-audit': { result: 'skipped' } };
  assert.equal(failingJobsFromNeeds(needs), '');
});

test('failingJobsFromNeeds names the one failing job', () => {
  const needs = { 'unit-tests': { result: 'success' }, 'data-validation': { result: 'failure' } };
  assert.equal(failingJobsFromNeeds(needs), 'data-validation');
});

test('failingJobsFromNeeds comma-joins multiple failing jobs and excludes skipped/success ones', () => {
  const needs = {
    'unit-tests': { result: 'success' },
    'data-validation': { result: 'failure' },
    'lint-workflows': { result: 'failure' },
    'dependency-audit': { result: 'skipped' },
  };
  assert.equal(failingJobsFromNeeds(needs), 'data-validation, lint-workflows');
});

test('failingJobsFromNeeds treats cancelled jobs as failing too (not success/skipped)', () => {
  const needs = { 'e2e-tests': { result: 'cancelled' } };
  assert.equal(failingJobsFromNeeds(needs), 'e2e-tests');
});

test('failingJobsFromNeeds handles an empty/missing needs object without crashing', () => {
  assert.equal(failingJobsFromNeeds({}), '');
  assert.equal(failingJobsFromNeeds(undefined), '');
});

// ── per-breakage signature (BRO-3865) ───────────────────────────────────────

test('failingStepSignatures: two different failing steps produce two distinct conditions', () => {
  const run = {
    jobs: [
      testJob('unit-tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests (no-data-dependency)')]),
      testJob('lint-workflows', 'failure', [okStep('Set up job'), failedStep('Lint workflow files')]),
    ],
  };
  const sigs = failingStepSignatures(run);
  assert.equal(sigs.length, 2);
  assert.notEqual(sigs[0].conditionKey, sigs[1].conditionKey);
  assert.ok(sigs.every((s) => s.conditionKey.startsWith('test-yml:red:')));
});

test('failingStepSignatures: the same failing step recurring on a later push produces the SAME conditionKey (stays dedupe-friendly)', () => {
  const makeRun = () => ({
    jobs: [testJob('unit-tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests (no-data-dependency)')])],
  });
  const sigsA = failingStepSignatures(makeRun());
  const sigsB = failingStepSignatures(makeRun());
  assert.equal(sigsA.length, 1);
  assert.equal(sigsB.length, 1);
  assert.equal(sigsA[0].conditionKey, sigsB[0].conditionKey);
});

test('signaturesToResolve: a step that goes CONFIRMED green resolves while a still-failing sibling stays open', () => {
  const keyA = stepFailureSignature('unit-tests', 'Run unit tests (no-data-dependency)', null);
  const keyB = stepFailureSignature('lint-workflows', 'Lint workflow files', null);
  const openKeys = [keyA, keyB, 'test-yml:main-streak-escalation']; // non-red key must be ignored, not resolved
  // unit-tests recovered (conclusion success); lint-workflows is still red.
  const laterRun = {
    jobs: [
      testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run unit tests (no-data-dependency)')]),
      testJob('lint-workflows', 'failure', [okStep('Set up job'), failedStep('Lint workflow files')]),
    ],
  };
  const currentSignatures = failingStepSignatures(laterRun);
  const toResolve = signaturesToResolve(openKeys, laterRun, currentSignatures);
  assert.deepEqual(toResolve, [keyA]);
});

test('signaturesToResolve: a fully-green run resolves every open red-signature key', () => {
  const keyA = stepFailureSignature('unit-tests', 'Run unit tests (no-data-dependency)', null);
  const keyB = stepFailureSignature('lint-workflows', 'Lint workflow files', null);
  const greenRun = {
    jobs: [
      testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run unit tests (no-data-dependency)')]),
      testJob('lint-workflows', 'success', [okStep('Set up job'), okStep('Lint workflow files')]),
    ],
  };
  const toResolve = signaturesToResolve([keyA, keyB], greenRun, []);
  assert.deepEqual(new Set(toResolve), new Set([keyA, keyB]));
});

test('signaturesToResolve does NOT resolve a signature whose job is merely ABSENT/SKIPPED this run (absence of evidence is not evidence of recovery)', () => {
  // Adversarial-review finding (BRO-3865): a job skipped by a path filter, or
  // cancelled upstream before it ran, gives ZERO evidence the previously
  // broken step now passes. Only an explicit conclusion:'success' may
  // resolve a signature — the same "absence must not manufacture an excuse"
  // principle classify()/isInfraOnlyFailure apply elsewhere in this file.
  const keyA = stepFailureSignature('lint-workflows', 'Lint workflow files', null);
  const runWithLintSkipped = {
    jobs: [
      testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run unit tests (no-data-dependency)')]),
      testJob('lint-workflows', 'skipped', []),
    ],
  };
  const currentSignatures = failingStepSignatures(runWithLintSkipped);
  const toResolve = signaturesToResolve([keyA], runWithLintSkipped, currentSignatures);
  assert.deepEqual(toResolve, []);
});

test('signaturesToResolve does NOT resolve a signature for a job that is STILL failing, even on a different step than currently reported', () => {
  // Only the job's OWN FIRST failing step is ever reported by
  // failingStepSignatures (GitHub Actions skips later steps once one fails),
  // so an older open signature for a step that isn't the CURRENT one must
  // stay open rather than being inferred as fixed — the job's conclusion is
  // still 'failure', not 'success'.
  const staleKey = stepFailureSignature('data-validation', 'An earlier step that used to fail', null);
  const stillRedRun = {
    jobs: [testJob('data-validation', 'failure', [okStep('Set up job'), failedStep('A different, currently-failing step')])],
  };
  const currentSignatures = failingStepSignatures(stillRedRun);
  const toResolve = signaturesToResolve([staleKey], stillRedRun, currentSignatures);
  assert.deepEqual(toResolve, []);
});

test('firstFailingTestNameInJobLog extracts the first TAP failing test name from one job\'s raw log', () => {
  const log = [
    '2026-09-20T10:00:00.0000000Z not ok 42 - url collision canonical dedupe removes exact duplicate',
    "2026-09-20T10:00:00.0000000Z   location: '/repo/tests/unit/url-collision-canonical.test.mjs:10:1'",
    '2026-09-20T10:00:01.0000000Z not ok 88 - lastFeaturedInWeek marks the most recent issue',
  ].join('\n');
  // Only the FIRST failing test is kept — later ones in the same batched
  // step don't overwrite it.
  assert.equal(firstFailingTestNameInJobLog(log), 'url collision canonical dedupe removes exact duplicate');
});

test('firstFailingTestNameInJobLog ignores an echoed shell comment that merely CONTAINS the literal string "not ok N - <name>" as documentation text', () => {
  // Live-verified (BRO-3865): this repo's own run_batch() shell function
  // prints a comment containing this exact substring as part of GitHub
  // Actions' "Run <script>" echo of the step's own source — with ANSI color
  // codes prefixed, so it can never accidentally match the anchored regex,
  // but worth pinning explicitly since it looks deceptively similar.
  const log = [
    "2026-09-20T18:38:38.2331444Z \x1b[36;1m    # (`not ok N - <name>` plus a `location: 'file:line'`\x1b[0m",
    '2026-09-20T18:39:00.0000000Z not ok 2223 - the real failing test',
  ].join('\n');
  assert.equal(firstFailingTestNameInJobLog(log), 'the real failing test');
});

test('firstFailingTestNameInJobLog returns null when there is no TAP line (a non-test step, e.g. actionlint)', () => {
  const log = '2026-09-20T10:00:00.0000000Z ::error::some actionlint failure with no TAP output at all';
  assert.equal(firstFailingTestNameInJobLog(log), null);
});

test('failingStepSignatures uses the per-job test name map when supplied', () => {
  const run = { jobs: [testJob('Unit Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests (no-data-dependency)')])] };
  const testNameByJob = new Map([['Unit Tests', 'named-only new write (no band) still beats an Unknown+unanchored collider']]);
  const sigs = failingStepSignatures(run, testNameByJob);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].testName, 'named-only new write (no band) still beats an Unknown+unanchored collider');
});

test('stepFailureSignature: same job+step, different first-failing-test names produce different conditionKeys', () => {
  const keyA = stepFailureSignature('unit-tests', 'Run unit tests (no-data-dependency)', 'url collision canonical dedupe removes exact duplicate');
  const keyB = stepFailureSignature('unit-tests', 'Run unit tests (no-data-dependency)', 'lastFeaturedInWeek marks the most recent issue');
  assert.notEqual(keyA, keyB);
});

test('failingStepSignatures skips setup-job-only infra failures (no signature manufactured from zero test evidence)', () => {
  const run = { jobs: [testJob('unit-tests', 'failure', [failedStep('Set up job')])] };
  assert.deepEqual(failingStepSignatures(run), []);
});

// ── BRO-4151: a bash integration step never gets a testName from the job's
// whole-log TAP scan, even when the map has one for that job ──────────────

test('isBashIntegrationStep matches test.yml\'s "(bash integration)" naming convention only', () => {
  assert.equal(isBashIntegrationStep('Run push-with-retry stranded-commit-cascade test (bash integration)'), true);
  assert.equal(isBashIntegrationStep('Run unit tests (no-data-dependency)'), false);
  assert.equal(isBashIntegrationStep('Lint workflow files'), false);
  assert.equal(isBashIntegrationStep(''), false);
  assert.equal(isBashIntegrationStep(undefined), false);
});

test('failingStepSignatures never attributes a testName to a bash-integration step, even when the job-log TAP scan found one from a different step', () => {
  // BRO-4149: "Unit Tests" job log contains a real `not ok` line from an
  // EARLIER `node --test` batch step, but the job's own FIRST FAILING step is
  // the bash integration test (which never prints TAP output at all — the
  // whole-job-log scan cannot distinguish which step a `not ok` line actually
  // belongs to). Attributing it anyway titled the filed card with an
  // unrelated test's name.
  const run = {
    jobs: [testJob('Unit Tests', 'failure', [
      okStep('Set up job'),
      okStep('Run unit tests (no-data-dependency)'),
      failedStep('Run push-with-retry stranded-commit-cascade test (bash integration)'),
    ])],
  };
  const testNameByJob = new Map([['Unit Tests', 'foo returns the contracted value']]);
  const sigs = failingStepSignatures(run, testNameByJob);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].step, 'Run push-with-retry stranded-commit-cascade test (bash integration)');
  assert.equal(sigs[0].testName, null, 'a bash-integration step must never inherit an unrelated TAP name');
});

test('failingStepSignatures still attributes a testName to a non-bash-integration failing step', () => {
  const run = { jobs: [testJob('Unit Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests (no-data-dependency)')])] };
  const testNameByJob = new Map([['Unit Tests', 'a real node --test failure']]);
  const sigs = failingStepSignatures(run, testNameByJob);
  assert.equal(sigs[0].testName, 'a real node --test failure');
});

test('an unparseable createdAt on the anchor run reports null duration, not a silent pass (code-review finding)', () => {
  // A version of the health-check.js caller rendered this as
  // "N red run(s), undefinedh since last green" and returned status 'pass' —
  // silently hiding a real data-quality problem instead of surfacing it.
  // The predicate's job is just to make this state distinguishable: redRunCount
  // > 0 with redStreakHours === null.
  const runs = [
    { headSha: 'badcreatedat', createdAt: 'not-a-date', conclusion: 'failure',
      jobs: [testJob('unit-tests', 'failure', [okStep('Set up job'), failedStep('Run tests')])] },
  ];
  const r = assessMainRedStreak(runs, NOW, 2);
  assert.equal(r.redRunCount, 1);
  assert.equal(r.redStreakHours, null);
  assert.equal(r.alarm, null);
});

// ── BRO-4054: stale signature tracking ───────────────────────────────────────

test('jobNameFromRedKey strips the prefix and the trailing hash', () => {
  assert.equal(jobNameFromRedKey('test-yml:red:E2E Tests:c2df710e'), 'E2E Tests');
  assert.equal(jobNameFromRedKey('test-yml:red:Unit Tests:0858c92a'), 'Unit Tests');
});

test('trackSignatureAbsence: 3 consecutive failed runs without the signature resolve it; 2 do not', () => {
  const key = stepFailureSignature('Unit Tests', 'Run unit tests', 'old test');
  const otherSig = [{ conditionKey: stepFailureSignature('Unit Tests', 'Run unit tests', 'new test') }];
  const failingRun = { jobs: [testJob('Unit Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests')])] };
  let cond = { [key]: { status: 'open' } };
  const r1 = trackSignatureAbsence(cond, otherSig, failingRun, '1001');
  assert.deepEqual(r1, { toResolve: [], updates: { [key]: ['1001'] } });
  cond = { [key]: { status: 'open', absentRunIds: r1.updates[key] } };
  const r2 = trackSignatureAbsence(cond, otherSig, failingRun, '1002');
  assert.deepEqual(r2.toResolve, []);
  assert.deepEqual(r2.updates[key], ['1001', '1002']);
  cond = { [key]: { status: 'open', absentRunIds: r2.updates[key] } };
  const r3 = trackSignatureAbsence(cond, otherSig, failingRun, '1003');
  assert.deepEqual(r3.toResolve, [key]);
  assert.equal(r3.updates[key].length, STALE_ABSENT_RUN_THRESHOLD);
  // the same run id never counts twice (a re-run of the step in one run)
  const dup = trackSignatureAbsence({ [key]: { status: 'open', absentRunIds: ['1001', '1002'] } }, otherSig, failingRun, '1002');
  assert.deepEqual(dup, { toResolve: [], updates: {} });
});

test('trackSignatureAbsence: the signature reappearing resets the counter to zero', () => {
  const key = stepFailureSignature('Unit Tests', 'Run unit tests', 'flaky test');
  const failingRun = { jobs: [testJob('Unit Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests')])] };
  const r = trackSignatureAbsence({ [key]: { status: 'open', absentRunIds: ['1', '2'] } }, [{ conditionKey: key }], failingRun, '3');
  assert.deepEqual(r, { toResolve: [], updates: { [key]: [] } });
  // present and already at zero → no update row at all
  assert.deepEqual(trackSignatureAbsence({ [key]: { status: 'open' } }, [{ conditionKey: key }], failingRun, '4').updates, {});
});

test('trackSignatureAbsence counts absence ONLY when the key\'s job ran and failed on a real step (skipped/green/setup-only/other job never tick)', () => {
  const key = stepFailureSignature('E2E Tests', 'Run unit tests', 'x');
  const cond = { [key]: { status: 'open', absentRunIds: ['1', '2'] } };
  const none = [];
  // skipped job → no evidence
  assert.deepEqual(trackSignatureAbsence(cond, none, { jobs: [testJob('E2E Tests', 'skipped', [])] }, '3'), { toResolve: [], updates: {} });
  // green job → resolve-on-green's business, not a stale tick
  assert.deepEqual(trackSignatureAbsence(cond, none, { jobs: [testJob('E2E Tests', 'success', [okStep('Run unit tests')])] }, '3'), { toResolve: [], updates: {} });
  // setup-only infra failure → no evidence
  assert.deepEqual(trackSignatureAbsence(cond, none, { jobs: [testJob('E2E Tests', 'failure', [failedStep('Set up job')])] }, '3'), { toResolve: [], updates: {} });
  // a DIFFERENT job failing says nothing about this key
  assert.deepEqual(trackSignatureAbsence(cond, none, { jobs: [testJob('Unit Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests')])] }, '3'), { toResolve: [], updates: {} });
  // cancelled job (timed out) with phantom failures after the cancel → no evidence
  assert.deepEqual(trackSignatureAbsence(cond, none, { jobs: [testJob('E2E Tests', 'cancelled', [{ name: 'Checkout', conclusion: 'cancelled' }, failedStep('Run unit tests')])] }, '3'), { toResolve: [], updates: {} });
  // the job DID fail on a real step, but on another test → tick → stale
  const r = trackSignatureAbsence(cond, [{ conditionKey: stepFailureSignature('E2E Tests', 'Run unit tests', 'y') }],
    { jobs: [testJob('E2E Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests')])] }, '3');
  assert.deepEqual(r.toResolve, [key]);
});

test('trackSignatureAbsence: a job whose log fetch failed this run gets no absence tick (job+step-only signature must not read as "gone")', () => {
  const key = stepFailureSignature('E2E Tests', 'Run unit tests', 'x');
  const cond = { [key]: { status: 'open', absentRunIds: ['1', '2'] } };
  const run = { jobs: [testJob('E2E Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests')])] };
  const stepOnly = [{ conditionKey: stepFailureSignature('E2E Tests', 'Run unit tests', null) }];
  assert.deepEqual(trackSignatureAbsence(cond, stepOnly, run, '3', { unreliableJobs: new Set(['E2E Tests']) }), { toResolve: [], updates: {} });
  // non-red keys are ignored entirely
  assert.deepEqual(trackSignatureAbsence({ 'health-check:Cookies': { status: 'open' } }, none(), run, '3'), { toResolve: [], updates: {} });
  function none() { return []; }
});
