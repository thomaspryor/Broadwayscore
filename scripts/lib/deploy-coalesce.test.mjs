import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decide } = require('./deploy-coalesce.js');

const run = (id, o = {}) => ({ id, status: 'in_progress', head_sha: 'aaa', display_title: 'Deploy to Vercel', ...o });
const job = (coreStatus, status = 'in_progress') => [{ name: 'deploy', status, steps: [{ name: 'Checkout core data', status: coreStatus }] }];

test('skips when an older same-sha run has not pulled core data yet', () => {
  const r = decide({ selfRunId: 20, selfSha: 'aaa', runs: [run(10)], jobsByRun: { 10: job('pending') } });
  assert.equal(r.proceed, false);
  assert.equal(r.coveredBy, 10);
});

test('skips when the older run deploy job is still queued', () => {
  const r = decide({ selfRunId: 20, selfSha: 'aaa', runs: [run(10)], jobsByRun: { 10: [{ name: 'deploy', status: 'queued', steps: [] }] } });
  assert.equal(r.proceed, false);
});

test('proceeds when the older run already checked out core data', () => {
  for (const s of ['in_progress', 'completed']) {
    assert.equal(decide({ selfRunId: 20, selfSha: 'aaa', runs: [run(10)], jobsByRun: { 10: job(s) } }).proceed, true);
  }
});

test('oldest run never skips (newer runs do not cover it)', () => {
  const r = decide({ selfRunId: 10, selfSha: 'aaa', runs: [run(20)], jobsByRun: { 20: job('pending') } });
  assert.equal(r.proceed, true);
});

test('ignores pre-warm runs, other shas, completed runs', () => {
  const jobsByRun = { 10: job('pending'), 11: job('pending'), 12: job('pending') };
  const runs = [run(10, { display_title: 'Deploy to Vercel (pre-warm for run 5)' }), run(11, { head_sha: 'bbb' }), run(12, { status: 'completed' })];
  assert.equal(decide({ selfRunId: 20, selfSha: 'aaa', runs, jobsByRun }).proceed, true);
});

test('fails open on missing job data or inputs', () => {
  assert.equal(decide({ selfRunId: 20, selfSha: 'aaa', runs: [run(10)], jobsByRun: {} }).proceed, true);
  assert.equal(decide({ selfRunId: 20, selfSha: 'aaa', runs: [run(10)], jobsByRun: { 10: [{ name: 'deploy', status: 'in_progress', steps: [] }] } }).proceed, true);
  assert.equal(decide({}).proceed, true);
});

test('31-run stack: only the first plus runs past the pending window build', () => {
  // run 1 is pulling data (past); runs 2..31 all arrive while run 2 is still pending
  const runs = [run(1), run(2)];
  for (let i = 3; i <= 31; i++) runs.push(run(i));
  const jobsByRun = { 1: job('completed'), 2: job('pending') };
  for (let i = 3; i <= 31; i++) jobsByRun[i] = job('pending');
  const built = [];
  for (let i = 3; i <= 31; i++) {
    if (decide({ selfRunId: i, selfSha: 'aaa', runs, jobsByRun }).proceed) built.push(i);
  }
  assert.deepEqual(built, []);
});
