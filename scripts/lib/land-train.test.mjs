/**
 * land-train.test.mjs — BRO-5282 merge train. Pure decisions from
 * scripts/lib/land-train.js, the REAL landBranch() train path against
 * throwaway git repos, and an end-to-end race: 4 concurrent "Land jobs" (the
 * real land-mutex.js / land-train.js / land.js CLIs, landBranch with faked
 * checks) against one bare origin, run exactly in land.yml's step order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const t = require('./land-train.js');
const m = require('./land-mutex.js');
const { landBranch, formatLandLine } = require('./land-branch.js');
const { trainMarkerVerdict, main: landMain } = require('../land.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

// ── pure ────────────────────────────────────────────────────────────────────

test('ticket trailers round-trip; a ticket without a tip is not a rider', () => {
  const msg = `land-mutex ticket run 1 attempt 1 land/x 2026\n\n${t.ticketTrailers({ branch: 'land/x', tip: A, base: B }).join('\n')}`;
  assert.deepEqual(t.parseTicketMessage(msg), { branch: 'land/x', tip: A, base: B });
  assert.deepEqual(t.parseTicketMessage(`x\n\n${t.ticketTrailers({ branch: 'land/x', tip: A }).join('\n')}`), { branch: 'land/x', tip: A, base: null });
  assert.equal(t.parseTicketMessage('land-mutex ticket run 1 attempt 1 land/x 2026'), null, 'pre-train ticket');
  assert.equal(t.parseTicketMessage('Land-Branch: land/x\nLand-Tip: nope'), null);
});

test('markers parse out of the shared refs/land-mutex/* listing; stale ones are those no land ref needs', () => {
  const ls = [`${B}\trefs/land-mutex/landed/${A}`, `${C}\trefs/land-mutex/lock`, `${C}\trefs/land-mutex/queue/1-0000000000001-5-1`, `${D}\trefs/land-mutex/landed/${C}`].join('\n');
  assert.deepEqual(t.parseMarkers(ls), { [A]: B, [C]: D });
  const st = m.parseLsRemote(ls);
  assert.equal(st.tickets.length, 1, 'markers are not tickets');
  assert.deepEqual(st.landed, { [A]: B, [C]: D });
  assert.deepEqual(t.staleMarkers(st.landed, [A]), [C]);
  assert.equal(t.markerRef(A), `refs/land-mutex/landed/${A}`);
  assert.throws(() => t.markerRef('abc'));
});

test('trainMax: default, repo variable, garbage falls back', () => {
  assert.equal(t.trainMax({}), t.DEFAULT_TRAIN_MAX);
  assert.equal(t.trainMax({ LAND_TRAIN_MAX: '0' }), 0);
  assert.equal(t.trainMax({ LAND_TRAIN_MAX: '6' }), 6);
  assert.equal(t.trainMax({ LAND_TRAIN_MAX: 'lots' }), t.DEFAULT_TRAIN_MAX);
});

const tk = (runId, info, extra = {}) => ({ ref: `refs/land-mutex/queue/1-000000000000${runId}-${runId}-1`, sha: C, prio: 1, enqueuedAt: runId, runId: String(runId), attempt: 1, info, remoteTip: info && info.tip, liveness: 'live', ...extra });

test('selectRiders: queue order, own ticket skipped, capped, every eligibility rule fails closed', () => {
  const self = { runId: '1', attempt: 1 };
  const tickets = [
    tk(1, { branch: 'land/holder', tip: A, base: B }),
    tk(2, { branch: 'land/r2', tip: B, base: A }),
    tk(3, null),
    tk(4, { branch: 'land/r4', tip: C, base: A }, { remoteTip: D }),
    tk(5, { branch: 'land/r5', tip: D, base: A }, { liveness: undefined }),
    tk(6, { branch: 'land/r2', tip: A, base: A }),
    tk(7, { branch: 'land/r7', tip: '7'.repeat(40), base: null }),
    tk(8, { branch: 'land/r8', tip: '8'.repeat(40), base: null }, { liveness: 'gone' }),
    tk(9, { branch: 'land/r9', tip: '9'.repeat(40), base: null }),
    tk(10, { branch: 'land/r10', tip: 'e'.repeat(40), base: null }),
  ];
  const r = t.selectRiders({ holderBranch: 'land/holder', self, tickets, max: 4, markers: { ['9'.repeat(40)]: A } });
  assert.deepEqual(r.riders.map((x) => x.branch), ['land/r2', 'land/r7', 'land/r10']);
  const why = Object.fromEntries(r.skipped.map((s) => [s.ref.split('-').pop() && s.ref, s.reason]));
  const reasons = r.skipped.map((s) => s.reason).join(' | ');
  assert.match(reasons, /no verified tip/);
  assert.match(reasons, /land ref moved/);
  assert.match(reasons, /not confirmed live \(unreadable\)/);
  assert.match(reasons, /already in the train/);
  assert.match(reasons, /not confirmed live \(gone\)/);
  assert.match(reasons, /already landed by an earlier train/);
  assert.ok(Object.keys(why).length >= 6);
  assert.equal(t.selectRiders({ holderBranch: 'land/holder', self, tickets, max: 2 }).riders.length, 1);
  assert.equal(t.selectRiders({ holderBranch: 'land/holder', self, tickets, max: 1 }).riders.length, 0, 'max < 2 = trains off');
});

test('selectRiders: main-red lanes never ride, never carry, and a queued main-red lane stops trains (BRO-5096)', () => {
  const self = { runId: '1', attempt: 1 };
  const ok = tk(2, { branch: 'land/r2', tip: B, base: A });
  assert.equal(t.selectRiders({ holderBranch: 'land/main-red-fix', self, tickets: [ok] }).riders.length, 0);
  assert.equal(t.selectRiders({ holderBranch: 'land/h', self, tickets: [ok, tk(3, { branch: 'land/x', tip: C }, { prio: 0 })] }).riders.length, 0);
  assert.equal(t.selectRiders({ holderBranch: 'land/h', self, tickets: [tk(3, { branch: 'land/main-red-x', tip: C })] }).riders.length, 0);
  assert.equal(t.selectRiders({ holderBranch: 'land/h', self, tickets: [ok] }).riders.length, 1);
});

test('segmentHeads: per-branch landed commit by position; any count drift → null', () => {
  assert.deepEqual(t.segmentHeads(['h1', 'h2', 'r1', 'r2a', 'r2b'], [2, 1, 2]), ['h2', 'r1', 'r2b']);
  assert.equal(t.segmentHeads(['h1', 'r1'], [1, 2]), null);
  assert.equal(t.segmentHeads(['h1', 'r1', 'x'], [1, 1]), null);
  assert.equal(t.segmentHeads(['h1'], [1, 0]), null);
});

test('decideFollower: landed only with a marker that is confirmed on main', () => {
  assert.equal(t.decideFollower({ markerSha: null }).landed, false);
  assert.equal(t.decideFollower({ markerSha: A, ancestor: false }).landed, false);
  assert.equal(t.decideFollower({ markerSha: A, ancestor: null }).landed, false);
  assert.equal(t.decideFollower({ markerSha: A, ancestor: true }).landed, true);
});

test('decideStep: a train marker for our tip ends the wait before anything else (BRO-5282)', () => {
  const ls = `${C}\trefs/land-mutex/lock\n${C}\trefs/land-mutex/queue/1-0000000000001-5-1\n${D}\trefs/land-mutex/landed/${A}`;
  const state = m.parseLsRemote(ls);
  assert.deepEqual(m.decideStep({ state, self: { runId: '9', attempt: 1, tip: A } }), { action: 'train-landed', sha: D });
  assert.equal(m.decideStep({ state, self: { runId: '9', attempt: 1, tip: B } }).action, 'enqueue');
  assert.equal(m.decideStep({ state, self: { runId: '9', attempt: 1 } }).action, 'enqueue', 'no tip → old behavior');
});

test('formatLandLine names the riders', () => {
  const line = formatLandLine('land/h', { landed: true, pushed: true, sha: A, attempts: 1, wallMs: 1000, riders: [{ branch: 'land/r' }] });
  assert.match(line, /merge train: \+1 rider\(s\) land\/r/);
});

// ── real git ────────────────────────────────────────────────────────────────

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-train-test-'));
  const origin = path.join(root, 'origin.git');
  sh(root, ['init', '-q', '--bare', '--initial-branch=main', origin]);
  const clone = (name) => {
    const dir = path.join(root, name);
    sh(root, ['clone', '-q', origin, dir]);
    sh(dir, ['config', 'user.email', 't@e.st']);
    sh(dir, ['config', 'user.name', 'test']);
    return dir;
  };
  const seed = clone('seed');
  fs.writeFileSync(path.join(seed, 'shared.txt'), 'one\ntwo\nthree\n');
  sh(seed, ['add', '.']);
  sh(seed, ['commit', '-qm', 'base']);
  sh(seed, ['push', '-q', 'origin', 'HEAD:main']);
  const author = clone('author');
  // A land/** branch forked from origin/main now, pushed to origin.
  const pushBranch = (name, files) => {
    sh(author, ['fetch', '-q', 'origin', 'main']);
    sh(author, ['checkout', '-q', '-B', name, 'origin/main']);
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(author, f)), { recursive: true });
      fs.writeFileSync(path.join(author, f), c);
    }
    sh(author, ['add', '-A']);
    sh(author, ['commit', '-qm', `feat ${name}`]);
    sh(author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${name}`]);
    return sh(author, ['rev-parse', 'HEAD']);
  };
  const mainSha = () => sh(root, ['--git-dir', origin, 'rev-parse', 'main']);
  const onMain = (f) => { try { return sh(root, ['--git-dir', origin, 'show', `main:${f}`]); } catch { return null; } };
  const isAnc = (sha) => { try { sh(root, ['--git-dir', origin, 'merge-base', '--is-ancestor', sha, 'main']); return true; } catch { return false; } };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return { root, origin, clone, pushBranch, mainSha, onMain, isAnc, cleanup };
}

const green = () => [{ name: 'fake-green', pass: true }];
const plainPush = ({ cwd }) => sh(cwd, ['push', '-q', 'origin', 'HEAD:main']);

test('train: holder + 2 riders land in ONE push after ONE combined check; per-branch shas are on main', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const tipB = w.pushBranch('land/b', { 'b.txt': 'b\n' });
    const repo = w.clone('runner');
    const pushes = [];
    const trainSeen = [];
    let solo = 0;
    const r = landBranch({
      branch: 'land/h', source: 'origin', repoDir: repo,
      riders: [{ branch: 'land/a', tip: tipA }, { branch: 'land/b', tip: tipB }],
      checks: () => { solo++; return green(); },
      trainChecks: (o) => { trainSeen.push([...o.changedFiles].sort()); return green(); },
      pushMain: (o) => { pushes.push(o.sha); plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(pushes.length, 1);
    assert.equal(solo, 0, 'the holder-only checks seam is not used for a train');
    assert.deepEqual(trainSeen, [['a.txt', 'b.txt', 'h.txt']]);
    assert.equal(w.mainSha(), r.pushedSha);
    assert.deepEqual(r.riders.map((x) => x.branch), ['land/a', 'land/b']);
    for (const x of [r.sha, ...r.riders.map((y) => y.sha)]) assert.equal(w.isAnc(x), true);
    assert.equal(r.riders[1].sha, r.pushedSha, 'the last rider is the pushed head');
    assert.equal(w.onMain('a.txt'), 'a');
    assert.equal(w.onMain('b.txt'), 'b');
    assert.equal(sh(w.origin, ['show', '-s', '--format=%s', r.sha]), 'feat land/h', 'result.sha is the holder\'s own commit');
  } finally { w.cleanup(); }
});

test('BRO-6276 train scope: verified, disjoint members get the small re-check; a member without a verified base makes it full', () => {
  const w = makeWorld();
  try {
    const base = w.mainSha();
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const tipB = w.pushBranch('land/b', { 'b.txt': 'b\n' });
    const scopes = [];
    const run = (riders, holderBase = base) => {
      const r = landBranch({
        branch: 'land/h', source: 'origin', repoDir: w.clone(`runner-${scopes.length}`), riders, holderBase,
        checks: () => [{ name: 'stop', pass: false, detail: 'stop here' }],
        trainChecks: (o) => { scopes.push(o.recheckScope); return [{ name: 'stop', pass: false, detail: 'stop here' }]; },
        pushMain: () => { throw new Error('must not push'); },
      });
      return r;
    };
    run([{ branch: 'land/a', tip: tipA, base }, { branch: 'land/b', tip: tipB, base }]);
    assert.equal(scopes[0].mode, 'small', scopes[0].reason);
    assert.equal(scopes[0].build, false);
    run([{ branch: 'land/a', tip: tipA }, { branch: 'land/b', tip: tipB, base }]);
    assert.equal(scopes[1].mode, 'full');
    assert.match(scopes[1].reason, /land\/a has no verified base/);
    run([{ branch: 'land/a', tip: tipA, base }], null);
    assert.match(scopes[2].reason, /land\/h has no verified base/);
    process.env.LAND_TRAIN_SMALL_RECHECK_DISABLED = 'true';
    try { run([{ branch: 'land/a', tip: tipA, base }, { branch: 'land/b', tip: tipB, base }]); } finally { delete process.env.LAND_TRAIN_SMALL_RECHECK_DISABLED; }
    assert.equal(scopes[3].mode, 'full');
    assert.match(scopes[3].reason, /disabled/);
  } finally { w.cleanup(); }
});

test('train: a conflicting rider is dropped, HEAD returns to the train, the next rider still rides', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'shared.txt': 'one\nHOLDER\nthree\n' });
    const tipX = w.pushBranch('land/x', { 'shared.txt': 'one\nRIDER\nthree\n' });
    const tipY = w.pushBranch('land/y', { 'y.txt': 'y\n' });
    const repo = w.clone('runner');
    const r = landBranch({
      branch: 'land/h', source: 'origin', repoDir: repo,
      riders: [{ branch: 'land/x', tip: tipX }, { branch: 'land/y', tip: tipY }],
      checks: green, trainChecks: green, pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.deepEqual(r.riders.map((x) => x.branch), ['land/y']);
    assert.equal(r.trainDropped.length, 1);
    assert.match(r.trainDropped[0].reason, /would not rebase/);
    assert.equal(w.onMain('shared.txt'), 'one\nHOLDER\nthree', 'the holder survived the dropped rider');
    assert.equal(w.onMain('y.txt'), 'y');
    assert.equal(sh(w.origin, ['log', '--format=%s', 'main']).split('\n').filter((s) => s === 'feat land/x').length, 0);
  } finally { w.cleanup(); }
});

test('train: a red combined check lands the holder alone (its own checks) and leaves the riders queued', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const repo = w.clone('runner');
    const soloSeen = [];
    const r = landBranch({
      branch: 'land/h', source: 'origin', repoDir: repo,
      riders: [{ branch: 'land/a', tip: tipA }],
      trainChecks: () => [{ name: 'merged-tree-tests', pass: false, detail: 'boom' }],
      checks: (o) => { soloSeen.push(o.changedFiles); return green(); },
      pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.deepEqual(r.riders, []);
    assert.deepEqual(soloSeen, [['h.txt']]);
    assert.match(r.trainDropped[0].reason, /train red \(merged-tree-tests\)/);
    assert.equal(w.onMain('h.txt'), 'h');
    assert.equal(w.onMain('a.txt'), null, 'the rider did NOT land on a red train');
    assert.equal(w.isAnc(tipA), false);
  } finally { w.cleanup(); }
});

test('train: riders are ignored with beforePush (autonomous-merge trailer stamping) and on dry runs', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const repo = w.clone('runner');
    const r = landBranch({
      branch: 'land/h', source: 'origin', repoDir: repo, riders: [{ branch: 'land/a', tip: tipA }],
      checks: green, trainChecks: () => { throw new Error('must not run'); }, beforePush: () => {}, pushMain: plainPush,
    });
    assert.equal(r.landed, true);
    assert.deepEqual(r.riders, []);
    assert.equal(w.onMain('a.txt'), null);
  } finally { w.cleanup(); }
});

test('train: main moves across INERT paths during the combined check → whole train re-rebased, per-branch shas recomputed', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const repo = w.clone('runner');
    const other = w.clone('other');
    let moved = false;
    const r = landBranch({
      branch: 'land/h', source: 'origin', repoDir: repo, riders: [{ branch: 'land/a', tip: tipA }],
      checks: green,
      trainChecks: () => {
        if (!moved) {
          moved = true;
          sh(other, ['pull', '-q', 'origin', 'main']);
          fs.mkdirSync(path.join(other, 'data'), { recursive: true });
          fs.writeFileSync(path.join(other, 'data', 'bot.json'), '{}\n');
          sh(other, ['add', '-A']); sh(other, ['commit', '-qm', 'bot churn']); sh(other, ['push', '-q', 'origin', 'HEAD:main']);
        }
        return green();
      },
      pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.churnSkips, 1);
    assert.equal(r.riders.length, 1);
    assert.equal(w.isAnc(r.sha), true);
    assert.equal(w.isAnc(r.riders[0].sha), true);
    assert.equal(sh(w.origin, ['show', '-s', '--format=%s', r.riders[0].sha]), 'feat land/a');
    assert.equal(sh(w.origin, ['show', '-s', '--format=%s', r.sha]), 'feat land/h');
  } finally { w.cleanup(); }
});

test('train: main moves SUBSTANTIVELY during the combined check → retry lands the holder ALONE (riders taken back out of HEAD)', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const repo = w.clone('runner');
    const other = w.clone('other');
    let moved = false;
    const soloSeen = [];
    const r = landBranch({
      branch: 'land/h', source: 'origin', repoDir: repo, riders: [{ branch: 'land/a', tip: tipA }],
      checks: (o) => { soloSeen.push([...o.changedFiles]); return green(); },
      trainChecks: () => {
        if (!moved) {
          moved = true;
          sh(other, ['pull', '-q', 'origin', 'main']);
          fs.writeFileSync(path.join(other, 'code.js'), '// substantive\n');
          sh(other, ['add', '-A']); sh(other, ['commit', '-qm', 'other session']); sh(other, ['push', '-q', 'origin', 'HEAD:main']);
        }
        return green();
      },
      pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.riders, []);
    assert.deepEqual(soloSeen, [['h.txt']], 'attempt 2 checks the holder alone');
    assert.equal(w.onMain('a.txt'), null, 'the rider did not ride along unmarked');
    assert.equal(sh(w.origin, ['show', '-s', '--format=%s', r.sha]), 'feat land/h', 'result.sha is the holder commit');
    assert.match(r.trainDropped[0].reason, /main moved substantively/);
  } finally { w.cleanup(); }
});

test('staleMarkers: an old marker is pruned even while a land ref still points at its tip', () => {
  assert.deepEqual(t.staleMarkers({ [A]: B }, [A], { [A]: t.MARKER_MAX_AGE_SEC + 1 }), [A]);
  assert.deepEqual(t.staleMarkers({ [A]: B }, [A], { [A]: 60 }), []);
  assert.deepEqual(t.staleMarkers({ [A]: B }, [A]), [], 'unknown age keeps it');
});

test('land.js: a rider of an earlier train finishes from its marker; --train-landed-only never lands unlocked', () => {
  const w = makeWorld();
  try {
    w.pushBranch('land/h', { 'h.txt': 'h\n' });
    const tipA = w.pushBranch('land/a', { 'a.txt': 'a\n' });
    const runner = w.clone('runner');
    const r = landBranch({ branch: 'land/h', source: 'origin', repoDir: runner, riders: [{ branch: 'land/a', tip: tipA }], checks: green, trainChecks: green, pushMain: plainPush });
    const follower = w.clone('follower');
    const out = path.join(w.root, 'res.json');
    const noLand = () => { throw new Error('landBranch must not run for a marked rider'); };
    // No marker yet: --train-landed-only refuses, and does not call landBranch.
    const silence = console.log; console.log = () => {};
    const savedErr = console.error; console.error = () => {};
    try {
      const run = (args) => { const cwd = process.cwd(); process.chdir(follower); try { return landMain(args, noLand); } finally { process.chdir(cwd); } };
      assert.equal(run(['--branch', 'land/a', '--expect-tip', tipA, '--train-landed-only', '--result-file', out]), 1);
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).failedCheck, 'train-marker');
      sh(runner, ['push', '-q', 'origin', `${r.riders[0].sha}:${t.markerRef(tipA)}`]);
      assert.equal(trainMarkerVerdict({ tip: tipA, repoDir: follower }).landed, true);
      assert.equal(run(['--branch', 'land/a', '--expect-tip', tipA, '--train-landed-only', '--result-file', out]), 0);
      const res = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(res.landed, true);
      assert.equal(res.pushed, false);
      assert.equal(res.sha, r.riders[0].sha);
    } finally { console.log = silence; console.error = savedErr; }
    // A marker pointing at a commit that is NOT on main never counts.
    const stray = w.pushBranch('land/stray', { 's.txt': 's\n' });
    sh(runner, ['fetch', '-q', 'origin', 'land/stray']);
    sh(runner, ['push', '-q', 'origin', `${stray}:${t.markerRef(stray)}`]);
    assert.equal(trainMarkerVerdict({ tip: stray, repoDir: follower }).landed, false);
  } finally { w.cleanup(); }
});

// ── end to end: 4 concurrent Land jobs, land.yml's step order ───────────────

const DRIVER = `
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const S = process.env.SCRIPTS;
const { landBranch } = require(S + '/lib/land-branch.js');
const env = (extra) => ({ ...process.env, ...extra });
const cli = (args, extra = {}) => { const r = spawnSync(process.execPath, args, { env: env(extra), encoding: 'utf8' }); process.stdout.write(r.stdout + r.stderr); return r.status; };
const outFile = process.env.GITHUB_OUTPUT;
cli([S + '/land-mutex.js', 'acquire']);
const outs = Object.fromEntries(fs.readFileSync(outFile, 'utf8').split('\\n').filter(Boolean).map((l) => l.split('=')));
const journal = (s) => fs.appendFileSync(process.env.JOURNAL, s + '\\n');
const res = process.env.RESULT;
if (outs.train_landed === 'true') {
  const rc = cli([S + '/land.js', '--branch', process.env.LAND_BRANCH, '--source', 'origin', '--expect-tip', process.env.LAND_TIP, '--train-landed-only', '--result-file', res]);
  cli([S + '/land-train.js', 'unmark', '--tip', process.env.LAND_TIP]);
  journal('follower ' + process.env.LAND_BRANCH + ' rc=' + rc);
} else {
  journal('enter ' + process.env.LAND_BRANCH);
  cli([S + '/land-train.js', 'collect', '--branch', process.env.LAND_BRANCH, '--out', process.env.RIDERS]);
  const riders = JSON.parse(fs.readFileSync(process.env.RIDERS, 'utf8'));
  const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);
  const green = () => { sleep(1500); return [{ name: 'fake-green', pass: true }]; };
  const r = landBranch({ branch: process.env.LAND_BRANCH, source: 'origin', expectSha: process.env.LAND_TIP, repoDir: process.cwd(), riders, checks: green, trainChecks: green,
    pushMain: ({ cwd }) => execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd }), log: (s) => console.log(s) });
  fs.writeFileSync(res, JSON.stringify({ branch: process.env.LAND_BRANCH, ...r }));
  cli([S + '/land-train.js', 'mark', '--result-file', res]);
  journal('exit ' + process.env.LAND_BRANCH + ' landed=' + r.landed + ' riders=' + r.riders.length);
  cli([S + '/land-mutex.js', 'release']);
}
`;

function runDriver(w, name, tip, base, delayMs, extraEnv = {}) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const dir = w.clone(`job-${name}`);
      const tag = name.replace(/\W/g, '_');
      const files = Object.fromEntries(['out', 'riders', 'result'].map((k) => [k, path.join(w.root, `${tag}.${k}`)]));
      fs.writeFileSync(files.out, '');
      const p = spawn(process.execPath, [path.join(w.root, 'driver.cjs')], {
        cwd: dir,
        env: {
          ...process.env, SCRIPTS, JOURNAL: path.join(w.root, 'journal'), GITHUB_OUTPUT: files.out, RIDERS: files.riders, RESULT: files.result,
          GITHUB_RUN_ID: String(100 + delayMs), GITHUB_RUN_ATTEMPT: '1', LAND_BRANCH: name, LAND_TIP: tip, LAND_BASE: base,
          LAND_MUTEX_NO_API: '1', LAND_TRAIN_NO_API: '1', LAND_MUTEX_POLL_SCALE: '0.02', LAND_MUTEX_GRACE_MS: '300', LAND_TRAIN_MAX: '4', ...extraEnv,
        },
      });
      let out = '';
      p.stdout.on('data', (b) => { out += b; });
      p.stderr.on('data', (b) => { out += b; });
      p.on('close', (code) => resolve({ name, code, out, result: fs.existsSync(files.result) ? JSON.parse(fs.readFileSync(files.result, 'utf8')) : null }));
    }, delayMs);
  });
}

test('E2E: 4 concurrent landings → one train push, followers finish from markers, nothing overlaps, every branch on main', { timeout: 120000 }, async () => {
  const w = makeWorld();
  try {
    fs.writeFileSync(path.join(w.root, 'driver.cjs'), DRIVER);
    fs.writeFileSync(path.join(w.root, 'journal'), '');
    const base = w.mainSha();
    const branches = ['land/e1', 'land/e2', 'land/e3', 'land/e4'];
    const tips = branches.map((b, i) => w.pushBranch(b, { [`e${i + 1}.txt`]: `e${i + 1}\n` }));
    const pushesBefore = Number(sh(w.root, ['--git-dir', w.origin, 'rev-list', '--count', 'main']));
    // An earlier landing holds the lock while all four queue (FIFO e1..e4),
    // then releases; e1 takes the lock and carries the three behind it.
    const tree = sh(w.root, ['--git-dir', w.origin, 'hash-object', '-t', 'tree', '-w', '/dev/null']);
    const prevSha = sh(w.root, ['--git-dir', w.origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'previous landing']);
    const prevTicket = m.ticketName({ mainRed: false, enqueuedAt: Date.now() - 1000, runId: '1', attempt: 1 });
    sh(w.root, ['--git-dir', w.origin, 'update-ref', prevTicket, prevSha]);
    sh(w.root, ['--git-dir', w.origin, 'update-ref', m.LOCK_REF, prevSha]);
    const released = new Promise((r) => setTimeout(() => {
      sh(w.root, ['--git-dir', w.origin, 'update-ref', '-d', m.LOCK_REF]);
      sh(w.root, ['--git-dir', w.origin, 'update-ref', '-d', prevTicket]);
      r();
    }, 6000));
    const results = await Promise.all(branches.map((b, i) => runDriver(w, b, tips[i], base, i * 300)));
    await released;
    const journal = fs.readFileSync(path.join(w.root, 'journal'), 'utf8').trim().split('\n');
    for (const r of results) assert.equal(r.code, 0, r.out);
    let inside = 0;
    for (const l of journal) {
      if (l.startsWith('enter')) inside++;
      if (l.startsWith('exit')) inside--;
      assert.ok(inside <= 1, `overlap: ${journal.join(' | ')}`);
    }
    for (let i = 0; i < 4; i++) assert.equal(w.onMain(`e${i + 1}.txt`), `e${i + 1}`, journal.join(' | '));
    const holders = journal.filter((l) => l.startsWith('exit'));
    const followers = journal.filter((l) => l.startsWith('follower'));
    assert.equal(holders.length, 1, `one train landed all four: ${journal.join(' | ')}`);
    assert.match(holders[0], /landed=true riders=3/);
    assert.equal(followers.length, 3);
    for (const f of followers) assert.match(f, /rc=0/);
    for (const r of results) {
      assert.equal(r.result.landed, true, r.out);
      assert.equal(w.isAnc(r.result.sha), true);
    }
    assert.equal(Number(sh(w.root, ['--git-dir', w.origin, 'rev-list', '--count', 'main'])) - pushesBefore, 4, 'four commits, linear');
    const left = sh(w.root, ['--git-dir', w.origin, 'for-each-ref', '--format=%(refname)', 'refs/land-mutex/']).split('\n').filter(Boolean);
    assert.deepEqual(left, [], 'no lock, ticket or train marker left behind');
  } finally { w.cleanup(); }
});

// The same race on an OLDER land.yml (no LAND_TIP, no train steps): the
// mutex derives each run's tip from its push-event head_sha, and land.js
// (always main's copy) forms the train and marks the riders itself.
const OLD_DRIVER = `
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const S = process.env.SCRIPTS;
const { landBranch } = require(S + '/lib/land-branch.js');
const landCli = require(S + '/land.js');
const cli = (args) => { const r = spawnSync(process.execPath, args, { env: process.env, encoding: 'utf8' }); process.stdout.write(r.stdout + r.stderr); return r.status; };
const tip = process.env.TIP;
delete process.env.LAND_TIP;
cli([S + '/land-mutex.js', 'acquire']);
const outs = Object.fromEntries(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8').split('\\n').filter(Boolean).map((l) => l.split('=')));
const journal = (s) => fs.appendFileSync(process.env.JOURNAL, s + '\\n');
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);
const green = () => { sleep(1500); return [{ name: 'fake-green', pass: true }]; };
let called = false;
const land = (o) => { called = true; return landBranch({ ...o, checks: green, trainChecks: green, pushMain: ({ cwd }) => execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd }) }); };
if (outs.held === 'true') journal('enter ' + process.env.LAND_BRANCH);
const rc = landCli.main(['--branch', process.env.LAND_BRANCH, '--source', 'origin', '--expect-tip', tip, '--result-file', process.env.RESULT], land);
const r = JSON.parse(fs.readFileSync(process.env.RESULT, 'utf8'));
journal((outs.held === 'true' ? 'exit ' : 'follower ') + process.env.LAND_BRANCH + ' rc=' + rc + ' landed=' + r.landed + ' riders=' + (r.riders || []).length + ' landBranch=' + called);
if (outs.held === 'true') cli([S + '/land-mutex.js', 'release']);
`;

test('E2E (older land.yml): tips derived from the run, land.js trains and marks on its own, followers never call landBranch', { timeout: 120000 }, async () => {
  const w = makeWorld();
  try {
    fs.writeFileSync(path.join(w.root, 'driver.cjs'), OLD_DRIVER);
    fs.writeFileSync(path.join(w.root, 'journal'), '');
    const branches = ['land/o1', 'land/o2', 'land/o3'];
    const tips = branches.map((b, i) => w.pushBranch(b, { [`o${i + 1}.txt`]: `o${i + 1}\n` }));
    const tree = sh(w.root, ['--git-dir', w.origin, 'hash-object', '-t', 'tree', '-w', '/dev/null']);
    const prevSha = sh(w.root, ['--git-dir', w.origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'previous landing']);
    const prevTicket = m.ticketName({ mainRed: false, enqueuedAt: Date.now() - 1000, runId: '1', attempt: 1 });
    sh(w.root, ['--git-dir', w.origin, 'update-ref', prevTicket, prevSha]);
    sh(w.root, ['--git-dir', w.origin, 'update-ref', m.LOCK_REF, prevSha]);
    const released = new Promise((r) => setTimeout(() => {
      sh(w.root, ['--git-dir', w.origin, 'update-ref', '-d', m.LOCK_REF]);
      sh(w.root, ['--git-dir', w.origin, 'update-ref', '-d', prevTicket]);
      r();
    }, 5000));
    const results = await Promise.all(branches.map((b, i) => runDriver(w, b, tips[i], '', i * 300, {
      TIP: tips[i], GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GH_TOKEN: '', GH_FALLBACK_TOKEN: '', LAND_TRAIN_NO_API: '',
      LAND_MUTEX_TEST_RUN: JSON.stringify({ event: 'push', head_sha: tips[i] }),
    })));
    await released;
    const journal = fs.readFileSync(path.join(w.root, 'journal'), 'utf8').trim().split('\n');
    for (const r of results) assert.equal(r.code, 0, r.out);
    for (let i = 0; i < 3; i++) assert.equal(w.onMain(`o${i + 1}.txt`), `o${i + 1}`, journal.join(' | '));
    const holders = journal.filter((l) => l.startsWith('exit'));
    assert.equal(holders.length, 1, journal.join(' | '));
    assert.match(holders[0], /rc=0 landed=true riders=2 landBranch=true/);
    const followers = journal.filter((l) => l.startsWith('follower'));
    assert.equal(followers.length, 2, journal.join(' | '));
    for (const f of followers) assert.match(f, /rc=0 landed=true riders=0 landBranch=false/);
  } finally { w.cleanup(); }
});

test('tipFromRun / holdsLock', () => {
  assert.equal(t.tipFromRun({ event: 'push', headSha: A, refSha: A }), A);
  assert.equal(t.tipFromRun({ event: 'push', headSha: A, refSha: B }), null, 'ref moved: a newer push has its own run');
  assert.equal(t.tipFromRun({ event: 'workflow_dispatch', headSha: A, refSha: A }), null);
  const st = m.parseLsRemote(`${C}\trefs/land-mutex/lock\n${C}\trefs/land-mutex/queue/1-0000000000001-5-1\n${D}\trefs/land-mutex/queue/1-0000000000002-6-1`);
  assert.equal(t.holdsLock(st, { runId: '5', attempt: 1 }), true);
  assert.equal(t.holdsLock(st, { runId: '6', attempt: 1 }), false);
  assert.equal(t.holdsLock(st, { runId: '5', attempt: 2 }), false);
});

test('trainsFromLandings: a runUrl naming 2+ branches is one train; solo landings and old rows are not', () => {
  const rows = [
    { ts: '2026-10-13T22:00:00Z', branch: 'land/h', sha: A, runUrl: 'u1' },
    { ts: '2026-10-13T22:00:01Z', branch: 'land/r', sha: B, runUrl: 'u1' },
    { ts: '2026-10-13T22:05:00Z', branch: 'land/r', sha: B, runUrl: 'u2' },
    { ts: '2026-10-13T22:06:00Z', branch: 'land/s', sha: C, runUrl: 'u3' },
    { ts: '2026-10-12T00:00:00Z', branch: 'land/x', sha: D, runUrl: 'u0' },
    { ts: '2026-10-12T00:00:01Z', branch: 'land/y', sha: D, runUrl: 'u0' },
  ];
  assert.deepEqual(t.trainsFromLandings(rows, '2026-10-13T21:15'), [{ runUrl: 'u1', branches: ['land/h', 'land/r'], shas: [A, B] }]);
  assert.equal(t.trainsFromLandings(rows).length, 2);
});
