// BRO-4754: re-run the newest main test.yml run only when every failed job
// was starved of a runner. Fixtures mirror run 37364141042 (2026-10-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideInfraRerun, waitMsFor, isStarvedJob, MIN_AGE_MS } = require('./main-infra-rerun.js');

const NOW = Date.parse('2026-10-05T20:30:00Z');
const STARVED = [{ message: 'The job was not acquired by Runner of type hosted even after multiple attempts' }];
const NOTICE = [{ message: 'The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.' }];

const run = (o = {}) => ({
  id: 37364141042, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'failure',
  run_attempt: 1, updated_at: '2026-10-05T19:49:40Z', ...o,
});
const job = (id, name, conclusion, steps = []) => ({ id, name, conclusion, steps });
const jobs = () => [
  job(1, 'Lint Workflows', 'success', [{ conclusion: 'success' }]),
  job(2, 'Unit Tests', 'cancelled'),
  job(3, 'TypeScript Check', 'cancelled'),
  job(4, 'Data Safety Guards', 'cancelled'),
  job(5, 'Visual Regression', 'skipped'),
  job(6, 'Test Summary', 'failure', [{ conclusion: 'success' }, { conclusion: 'failure' }]),
];
const starvedAll = () => ({ 2: STARVED, 3: [...NOTICE, ...STARVED], 4: STARVED });

test('newest run with only starved jobs is re-run', () => {
  const d = decideInfraRerun({ runs: [run()], jobs: jobs(), annotationsByJobId: starvedAll(), now: NOW });
  assert.equal(d.retry, true, d.reason);
  assert.deepEqual(d.starved, ['Unit Tests', 'TypeScript Check', 'Data Safety Guards']);
});

test('a real failure next to starved jobs blocks the re-run (runner shutdown mid-job, run 37363050279)', () => {
  const js = jobs();
  js[1] = job(2, 'Unit Tests', 'failure', [{ conclusion: 'success' }, { conclusion: 'failure' }]);
  const d = decideInfraRerun({ runs: [run()], jobs: js, annotationsByJobId: starvedAll(), now: NOW });
  assert.equal(d.retry, false);
  assert.match(d.reason, /real-failure:Unit Tests/);
});

test('cancelled without the starvation annotation (timeout, human cancel) is not starvation', () => {
  const d = decideInfraRerun({ runs: [run()], jobs: jobs(), annotationsByJobId: { ...starvedAll(), 3: NOTICE }, now: NOW });
  assert.equal(d.retry, false);
  assert.match(d.reason, /TypeScript Check/);
});

test('a cancelled job whose steps ran is not starvation even with the annotation', () => {
  assert.equal(isStarvedJob(job(9, 'X', 'cancelled', [{ conclusion: 'success' }]), STARVED), false);
  assert.equal(isStarvedJob(job(9, 'X', 'cancelled', [{ conclusion: 'skipped' }]), STARVED), true);
});

test('only the newest run is considered: an older red run behind a newer one is left alone', () => {
  const newer = run({ id: 2, conclusion: 'success' });
  const d = decideInfraRerun({ runs: [newer, run()], jobs: jobs(), annotationsByJobId: starvedAll(), now: NOW });
  assert.equal(d.retry, false);
  assert.equal(d.reason, 'conclusion-success');
});

test('newest run still in progress: wait', () => {
  const d = decideInfraRerun({ runs: [run({ status: 'in_progress', conclusion: null })], jobs: [], now: NOW });
  assert.equal(d.reason, 'newest-run-not-completed');
});

test('too soon after the run ended: wait, so a rerun mid-incident does not starve again', () => {
  const ended = new Date(NOW - MIN_AGE_MS + 60_000).toISOString();
  const d = decideInfraRerun({ runs: [run({ updated_at: ended })], jobs: jobs(), annotationsByJobId: starvedAll(), now: NOW });
  assert.equal(d.reason, 'too-recent');
});

test('attempt budget: attempt 3 is not re-run again', () => {
  const d = decideInfraRerun({ runs: [run({ run_attempt: 3 })], jobs: jobs(), annotationsByJobId: starvedAll(), now: NOW });
  assert.equal(d.reason, 'attempts-exhausted');
  assert.equal(decideInfraRerun({ runs: [run({ run_attempt: 2 })], jobs: jobs(), annotationsByJobId: starvedAll(), now: NOW }).retry, true);
});

test('non-main or non-push runs are ignored', () => {
  assert.equal(decideInfraRerun({ runs: [run({ head_branch: 'land/x' })], now: NOW }).reason, 'not-main-push');
  assert.equal(decideInfraRerun({ runs: [run({ event: 'schedule' })], now: NOW }).reason, 'not-main-push');
});

test('only the aggregator failed: nothing to re-run', () => {
  const js = jobs().map((j) => (j.name === 'Test Summary' ? j : { ...j, conclusion: j.conclusion === 'skipped' ? 'skipped' : 'success' }));
  assert.equal(decideInfraRerun({ runs: [run()], jobs: js, now: NOW }).reason, 'no-failed-jobs');
});

// BRO-4771: workflow_run fires right after the run ends; --wait sleeps only
// when the run would qualify once old enough.
test('waitMsFor: a fresh starved-only run waits until MIN_AGE has passed', () => {
  const ended = NOW - 60_000;
  const ms = waitMsFor({ runs: [run({ updated_at: new Date(ended).toISOString() })], jobs: jobs(), annotationsByJobId: starvedAll() }, { now: NOW });
  assert.ok(ms >= MIN_AGE_MS - 60_000 && ms <= MIN_AGE_MS - 60_000 + 10_000, String(ms));
});

test('waitMsFor: a fresh run with a real failure does not hold a runner asleep', () => {
  const js = jobs();
  js[1] = job(2, 'Unit Tests', 'failure', [{ conclusion: 'failure' }]);
  const r = run({ updated_at: new Date(NOW - 60_000).toISOString() });
  assert.equal(waitMsFor({ runs: [r], jobs: js, annotationsByJobId: starvedAll() }, { now: NOW }), 0);
});

test('waitMsFor: no wait when already decidable (old enough, in progress, exhausted)', () => {
  assert.equal(waitMsFor({ runs: [run()], jobs: jobs(), annotationsByJobId: starvedAll() }, { now: NOW }), 0);
  assert.equal(waitMsFor({ runs: [run({ status: 'in_progress', conclusion: null })] }, { now: NOW }), 0);
  const fresh = new Date(NOW - 60_000).toISOString();
  assert.equal(waitMsFor({ runs: [run({ updated_at: fresh, run_attempt: 3 })], jobs: jobs(), annotationsByJobId: starvedAll() }, { now: NOW }), 0);
});

test('waitMsFor: capped at maxWaitMs', () => {
  const r = run({ updated_at: new Date(NOW).toISOString() });
  assert.equal(waitMsFor({ runs: [r], jobs: jobs(), annotationsByJobId: starvedAll() }, { now: NOW, maxWaitMs: 1000 }), 1000);
});
