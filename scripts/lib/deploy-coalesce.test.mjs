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

// --- BRO-8236 part 2: overtaken routine runs stop before upload ---
const { redundantRoutineDeploy, olderRunUploading } = require('./deploy-coalesce.js');
const T0 = Date.UTC(2026, 10, 26, 6, 0, 0);
const BASE = 'broadwayscore-base.vercel.app';
const routine = (o = {}) => ({ urgent: 'false', reason: 'content-changed', codeChanged: 'false', nowMs: T0 + 10 * 60e3, selfRunId: 20, runs: [], jobsByRun: {}, deployments: [], baselineUrl: BASE, baselineCreatedMs: T0, ...o });
const dep = (url, created, state = 'READY') => ({ url, created, state });

test('BRO-8236: routine run stops when Vercel has a newer non-failed prod deploy than its baseline', () => {
  for (const state of ['READY', 'BUILDING', 'QUEUED', 'INITIALIZING']) {
    const v = redundantRoutineDeploy(routine({ deployments: [dep(BASE, T0), dep('other.vercel.app', T0 + 9 * 60e3, state)] }));
    assert.equal(v.stop, true, state);
    assert.match(v.why, /newer-deployment other\.vercel\.app/);
  }
});
test('BRO-8236: the baseline itself, failed deploys and older deploys do not stop it', () => {
  const deployments = [dep(BASE, T0), dep('err.vercel.app', T0 + 60e3, 'ERROR'), dep('can.vercel.app', T0 + 60e3, 'CANCELED'), dep('old.vercel.app', T0 - 10 * 60e3)];
  assert.deepEqual(redundantRoutineDeploy(routine({ deployments })), { stop: false, why: 'not-overtaken' });
});
test('BRO-8236: urgent runs (opening-night reveal, go-live-now) never stop', () => {
  const deployments = [dep('other.vercel.app', T0 + 60e3)];
  for (const urgent of ['true', true, '', undefined, null]) {
    assert.equal(redundantRoutineDeploy(routine({ urgent, deployments })).stop, false, String(urgent));
  }
});
test('BRO-8236: code-changed and fail-open reasons never stop', () => {
  const deployments = [dep('other.vercel.app', T0 + 60e3)];
  for (const reason of ['code-changed', 'explicit-ship', 'no-baseline-fail-open', 'diff-error-fail-open', 'kill-switch', '', undefined]) {
    assert.equal(redundantRoutineDeploy(routine({ reason, deployments })).stop, false, String(reason));
  }
  for (const reason of ['content-changed', 'data-changed', 'staleness-backstop']) {
    assert.equal(redundantRoutineDeploy(routine({ reason, deployments })).stop, true, reason);
  }
});
test('BRO-8236: an older run inside Deploy to Production stops a routine run; a newer one does not', () => {
  const up = [{ name: 'should-deploy', status: 'completed', conclusion: 'success' }, { name: 'deploy', status: 'in_progress', steps: [{ name: 'Deploy to Production', status: 'in_progress' }] }];
  assert.equal(redundantRoutineDeploy(routine({ runs: [run(10)], jobsByRun: { 10: up } })).why, 'older-run-uploading 10');
  // pre-warm runs upload too, so they count here (they are only exempt from being cancelled)
  assert.equal(olderRunUploading({ selfRunId: 20, runs: [run(10, { display_title: 'Deploy to Vercel (pre-warm for run 5)' })], jobsByRun: { 10: up } }), 10);
  assert.equal(redundantRoutineDeploy(routine({ runs: [run(30)], jobsByRun: { 30: up } })).stop, false, 'newer run: older wins, both never stop');
  assert.equal(redundantRoutineDeploy(routine({ runs: [run(10)], jobsByRun: { 10: jobs('pending') } })).stop, false, 'not uploading yet');
  assert.equal(redundantRoutineDeploy(routine({ runs: [run(10, { head_branch: 'x' })], jobsByRun: { 10: up } })).stop, false, 'non-main');
});
test('BRO-8236: missing data fails open (no stop)', () => {
  assert.equal(redundantRoutineDeploy({}).stop, false);
  assert.equal(redundantRoutineDeploy(routine({ deployments: null })).stop, false);
  assert.equal(redundantRoutineDeploy(routine({ baselineCreatedMs: NaN, deployments: [dep('o.vercel.app', T0 + 1)] })).stop, false);
  assert.equal(redundantRoutineDeploy(routine({ baselineUrl: '', deployments: [dep('o.vercel.app', T0 + 1)] })).stop, false);
});
test('BRO-8236 wiring: gate exports urgent + baseline, coalesce step reads them, stop step dispatches then cancels before upload', () => {
  const y = readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');
  for (const k of ['urgent', 'baseline_url', 'baseline_created_ms']) {
    assert.ok(y.includes(`${k}: \${{ steps.check.outputs.${k} }}`), `should-deploy output ${k}`);
  }
  assert.match(y, /GATE_URGENT: \$\{\{ needs\.should-deploy\.outputs\.urgent \}\}/);
  assert.match(y, /GATE_REASON: \$\{\{ needs\.should-deploy\.outputs\.reason \}\}/);
  const stop = y.indexOf('      - name: Stop overtaken routine deploy\n');
  assert.ok(stop > y.indexOf('deploy-coalesce-gate.js') && stop < y.indexOf('      - name: Deploy to Production\n'), 'stop step between coalesce and Deploy');
  const body = y.slice(stop, y.indexOf('      - name: Deploy to Production\n'));
  assert.match(body, /if: steps\.coalesce\.outputs\.redundant == 'true'/);
  assert.ok(body.indexOf('-f source=deferred') < body.indexOf('gh run cancel'), 'follow-up dispatched before self-cancel');
  assert.match(body, /dispatch failed, deploying/);
});

test('BRO-8236: a code change (or unknown code state) is never stopped, whatever the gate reason', () => {
  const deployments = [dep('other.vercel.app', T0 + 60e3)];
  for (const codeChanged of ['true', '', undefined, null]) {
    assert.equal(redundantRoutineDeploy(routine({ codeChanged, deployments })).stop, false, String(codeChanged));
  }
});
test('BRO-8236: a stuck in-flight Vercel deploy (>20 min) does not suppress shipping; a stale READY one still counts', () => {
  const late = T0 + 60 * 60e3;
  assert.equal(redundantRoutineDeploy(routine({ nowMs: late, deployments: [dep('stuck.vercel.app', T0 + 60e3, 'BUILDING')] })).stop, false);
  assert.equal(redundantRoutineDeploy(routine({ nowMs: late, deployments: [dep('done.vercel.app', T0 + 60e3, 'READY')] })).stop, true);
});
test('BRO-8236: the gate script decides before cancelling, and a stopping run cancels nothing', () => {
  const g = readFileSync(new URL('../deploy-coalesce-gate.js', import.meta.url), 'utf8');
  const verdictAt = g.indexOf('verdict = redundantRoutineDeploy(');
  const cancelAt = g.indexOf("gh(['run', 'cancel'");
  assert.ok(verdictAt > 0 && cancelAt > verdictAt, 'verdict computed before any cancel');
  assert.match(g.slice(verdictAt, cancelAt), /if \(verdict\.stop\) return;/);
  assert.match(g, /redundant=\$\{verdict\.stop && !dryRun\}/, 'dry run never stops a run');
});

test('BRO-8236: baseline url compares by host, so a https:// or trailing-slash baseline is still excluded', () => {
  const deployments = [dep(BASE, T0 + 1000)];
  for (const baselineUrl of [`https://${BASE}`, `${BASE}/`, BASE.toUpperCase()]) {
    assert.equal(redundantRoutineDeploy(routine({ baselineUrl, deployments })).stop, false, baselineUrl);
  }
});
