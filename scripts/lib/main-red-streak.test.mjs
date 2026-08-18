import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessMainRedStreak } = require('./main-red-streak.js');

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
