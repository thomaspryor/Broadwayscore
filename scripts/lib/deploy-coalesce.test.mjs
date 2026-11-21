import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decide } = require('./deploy-coalesce.js');

const run = (id, o = {}) => ({ id, status: 'in_progress', head_branch: 'main', display_title: 'Deploy to Vercel', ...o });
const jobs = (coreStatus, { deployStatus = 'in_progress', gate = 'success' } = {}) => [
  { name: 'should-deploy', status: 'completed', conclusion: gate },
  { name: 'deploy', status: deployStatus, steps: [{ name: 'Deploy to Production', status: coreStatus }] },
];

test('cancels older run still before Deploy to Production', () => {
  assert.deepEqual(decide({ selfRunId: 20, runs: [run(10)], jobsByRun: { 10: jobs('pending') } }).cancel, [10]);
});
test('cancels older run whose deploy job is still queued', () => {
  assert.deepEqual(decide({ selfRunId: 20, runs: [run(10)], jobsByRun: { 10: jobs('pending', { deployStatus: 'queued' }) } }).cancel, [10]);
});
test('keeps older run that already started/finished core data checkout', () => {
  for (const s of ['in_progress', 'completed']) assert.deepEqual(decide({ selfRunId: 20, runs: [run(10)], jobsByRun: { 10: jobs(s) } }).cancel, []);
});
test('never cancels newer or same-id runs (oldest is never superseded by older)', () => {
  assert.deepEqual(decide({ selfRunId: 10, runs: [run(10), run(20)], jobsByRun: { 10: jobs('pending'), 20: jobs('pending') } }).cancel, []);
});
test('keeps pre-warm, completed, gate-not-success, and unknown-shape runs', () => {
  const runs = [run(1, { display_title: 'Deploy to Vercel (pre-warm for run 5)' }), run(2, { status: 'completed' }), run(3), run(4), run(5)];
  const jobsByRun = {
    1: jobs('pending'), 2: jobs('pending'), 3: jobs('pending', { gate: 'failure' }),
    4: [{ name: 'should-deploy', status: 'in_progress' }], // gate unfinished
    5: [{ name: 'should-deploy', status: 'completed', conclusion: 'success' }, { name: 'deploy', status: 'in_progress', steps: [] }],
  };
  assert.deepEqual(decide({ selfRunId: 20, runs, jobsByRun }).cancel, []);
});
test('only main: non-main targets kept, non-main canceller cancels nothing', () => {
  assert.deepEqual(decide({ selfRunId: 20, runs: [run(10, { head_branch: 'feature' })], jobsByRun: { 10: jobs('pending') } }).cancel, []);
  assert.deepEqual(decide({ selfRunId: 20, selfBranch: 'feature', runs: [run(10)], jobsByRun: { 10: jobs('pending') } }).cancel, []);
});
test('fails open on missing inputs / jobs', () => {
  assert.deepEqual(decide({}).cancel, []);
  assert.deepEqual(decide({ selfRunId: 20, runs: [run(10)], jobsByRun: {} }).cancel, []);
});
test('31-run stack: the newest run supersedes every pending predecessor', () => {
  const runs = [], jobsByRun = {};
  for (let i = 1; i <= 31; i++) { runs.push(run(i)); jobsByRun[i] = jobs(i <= 5 ? 'completed' : 'pending'); }
  const d = decide({ selfRunId: 32, runs, jobsByRun });
  assert.equal(d.cancel.length, 26);
  assert.ok(!d.cancel.includes(5));
});

test('workflow wiring: step runs in deploy job before the build, fail-open, gate untouched', () => {
  const y = readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');
  assert.match(y, /node scripts\/deploy-coalesce-gate\.js/);
  const at = y.indexOf('deploy-coalesce-gate.js');
  assert.ok(at > y.indexOf('      - name: Build\n') && at < y.indexOf('      - name: Deploy to Production\n'), 'must run after Build, before Deploy');
  assert.match(y.slice(at - 900, at), /continue-on-error: true/);
  assert.match(y.slice(at - 900, at), /DEPLOY_COALESCE_DISABLED/);
});
