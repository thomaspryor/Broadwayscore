import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assessMainRedStreak, failingJobsFromNeeds,
  stepFailureSignature, firstFailingTestNamesByScope, failingStepSignatures, signaturesToResolve,
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

test('signaturesToResolve: a step that goes green resolves while a still-failing sibling stays open', () => {
  const keyA = stepFailureSignature('unit-tests', 'Run unit tests (no-data-dependency)', null);
  const keyB = stepFailureSignature('lint-workflows', 'Lint workflow files', null);
  const openKeys = [keyA, keyB, 'test-yml:main-streak-escalation']; // non-red key must be ignored, not resolved
  // unit-tests recovered; lint-workflows is still red on this later run.
  const laterRun = {
    jobs: [
      testJob('unit-tests', 'success', [okStep('Set up job'), okStep('Run unit tests (no-data-dependency)')]),
      testJob('lint-workflows', 'failure', [okStep('Set up job'), failedStep('Lint workflow files')]),
    ],
  };
  const currentSignatures = failingStepSignatures(laterRun);
  const toResolve = signaturesToResolve(openKeys, currentSignatures);
  assert.deepEqual(toResolve, [keyA]);
});

test('signaturesToResolve: a fully-green run resolves every open red-signature key', () => {
  const keyA = stepFailureSignature('unit-tests', 'Run unit tests (no-data-dependency)', null);
  const keyB = stepFailureSignature('lint-workflows', 'Lint workflow files', null);
  const toResolve = signaturesToResolve([keyA, keyB], []);
  assert.deepEqual(new Set(toResolve), new Set([keyA, keyB]));
});

test('firstFailingTestNamesByScope extracts the first TAP failing test name per job/step scope', () => {
  const log = [
    'unit-tests\tRun unit tests (no-data-dependency)\t2026-09-20T10:00:00.0000000Z not ok 42 - url collision canonical dedupe removes exact duplicate',
    "unit-tests\tRun unit tests (no-data-dependency)\t2026-09-20T10:00:00.0000000Z   location: '/repo/tests/unit/url-collision-canonical.test.mjs:10:1'",
    'unit-tests\tRun unit tests (no-data-dependency)\t2026-09-20T10:00:01.0000000Z not ok 88 - lastFeaturedInWeek marks the most recent issue',
  ].join('\n');
  const { byScope } = firstFailingTestNamesByScope(log);
  // Only the FIRST failing test in the scope is kept — later ones in the same
  // batched step don't overwrite it.
  assert.equal(byScope.get('unit-tests\0Run unit tests (no-data-dependency)'), 'url collision canonical dedupe removes exact duplicate');
});

test('firstFailingTestNamesByScope also indexes by job alone, as a fallback for when gh --log-failed cannot attribute a step', () => {
  // Live-verified quirk (BRO-3865): `gh run view --log-failed` reported every
  // line's step as the literal string "UNKNOWN STEP" for this repo's nested
  // ::group:: shell functions, even though `--json jobs` names steps fine.
  const log = [
    'Unit Tests\tUNKNOWN STEP\t2026-09-20T10:53:23.0000000Z not ok 2223 - broadway edition renders an in-week off-Broadway opening',
    'Unit Tests\tUNKNOWN STEP\t2026-09-20T10:55:17.0000000Z not ok 7980 - named-only new write (no band) still beats an Unknown+unanchored collider',
  ].join('\n');
  const { byJob } = firstFailingTestNamesByScope(log);
  assert.equal(byJob.get('Unit Tests'), 'broadway edition renders an in-week off-Broadway opening');
});

test('failingStepSignatures falls back to the job-only test name when the exact job+step scope has none', () => {
  const run = { jobs: [testJob('Unit Tests', 'failure', [okStep('Set up job'), failedStep('Run unit tests (no-data-dependency)')])] };
  const testNames = {
    byScope: new Map(), // exact "Unit Tests\0Run unit tests (no-data-dependency)" scope missing (gh couldn't attribute it)
    byJob: new Map([['Unit Tests', 'named-only new write (no band) still beats an Unknown+unanchored collider']]),
  };
  const sigs = failingStepSignatures(run, testNames);
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
