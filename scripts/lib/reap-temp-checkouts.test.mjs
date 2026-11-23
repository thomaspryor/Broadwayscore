/**
 * BRO-8124: reap-temp-checkouts.js — orphan parents of known prefixes whose
 * repo is gone are reaped; anything with a file open under it, a live owner,
 * an unknown name or a symlinked path is kept.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const R = require('./reap-temp-checkouts.js');

const ROOTS = [];
after(() => { for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

function root() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bro8124-reap-')));
  ROOTS.push(r);
  return r;
}

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const liveOwner = () => ({ pid: process.pid, started: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() });

/** An orphan exactly like the 109 found on 2026-11-23: main/.git points at a deleted repo. */
function orphan(rootDir, { prefix = 'linear-done-verify-', owner = { pid: deadPid(), started: 'gone' }, ageMin = 30 } = {}) {
  const parent = fs.mkdtempSync(path.join(rootDir, prefix));
  const wt = path.join(parent, 'main');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(rootDir, 'deleted-repo', '.git', 'worktrees', 'main')}\n`);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
  if (owner) fs.writeFileSync(path.join(parent, '.acceptance-owner.json'), JSON.stringify(owner));
  const t = new Date(Date.now() - ageMin * 60000);
  for (const p of [path.join(wt, 'a.txt'), path.join(wt, '.git'), wt, parent]) fs.utimesSync(p, t, t);
  return { parent, wt };
}

test('an unregistered orphan linear-done-verify parent with a dead owner is reaped', () => {
  const r = root();
  const o = orphan(r);
  assert.equal(R.checkoutKind(o.wt), 'orphan');
  const s = R.reapTempCheckouts({ roots: [r] });
  assert.equal(s.removed, 1, JSON.stringify(s.results));
  assert.equal(fs.existsSync(o.parent), false);
});

test('a dir with a file held open by a live process is kept', async () => {
  const r = root();
  const o = orphan(r);
  const holder = spawn(process.execPath, ['-e', 'require("fs").openSync(process.argv[1], "r"); console.log("open"); setInterval(() => {}, 1000);', path.join(o.wt, 'a.txt')], { cwd: r, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const s = R.reapTempCheckouts({ roots: [r] });
    assert.equal(s.removed, 0, JSON.stringify(s.results));
    assert.match(s.results[0].reason, /holds a file/);
    assert.ok(fs.existsSync(o.parent));
  } finally { holder.kill('SIGKILL'); }
});

test('a live owner, a too-young dead owner, and deadOnly-vs-ownerless are kept', () => {
  const r = root();
  const live = orphan(r, { owner: liveOwner() });
  const young = orphan(r, { ageMin: 2 });
  const ownerless = orphan(r, { owner: null, ageMin: 120 });
  const s = R.reapTempCheckouts({ roots: [r], deadOnly: true });
  assert.equal(s.removed, 0, JSON.stringify(s.results));
  for (const o of [live, young, ownerless]) assert.ok(fs.existsSync(o.parent));
  // Without deadOnly the long-idle ownerless one goes; the other two stay.
  const s2 = R.reapTempCheckouts({ roots: [r] });
  assert.equal(s2.removed, 1, JSON.stringify(s2.results));
  assert.equal(fs.existsSync(ownerless.parent), false);
  assert.ok(fs.existsSync(live.parent) && fs.existsSync(young.parent));
});

test('unknown prefixes and symlinked parents are never touched', () => {
  const r = root();
  const foreign = orphan(r, { prefix: 'my-scratch-' });
  const target = orphan(r);
  const link = path.join(r, 'linear-done-verify-LiNk01');
  fs.symlinkSync(target.parent, link);
  assert.equal(R.validateParent(link), null);
  assert.equal(R.validateParent(foreign.parent), null);
  assert.equal(R.decide(link, { snapshot: [] }).reap, false);
  R.reapTempCheckouts({ roots: [r] });
  assert.ok(fs.existsSync(foreign.parent), 'foreign prefix kept');
});

test('lsof failure keeps everything', () => {
  assert.equal(R.hasOpenPathUnder(null, '/private/tmp/x'), true);
  assert.equal(R.hasOpenPathUnder(['/private/tmp/xy/a'], '/private/tmp/x'), false);
  assert.equal(R.hasOpenPathUnder(['/private/tmp/x/a'], '/private/tmp/x'), true);
});

test('a truncated lsof (timeout or ENOBUFS) is a failure, exit 1 with output is usable', () => {
  assert.equal(R.pathsFromLsofError({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT', stdout: 'n/x\n' }), null);
  assert.equal(R.pathsFromLsofError({ status: null, code: 'ENOBUFS', stdout: 'n/x\n' }), null);
  assert.deepEqual(R.pathsFromLsofError({ status: 1, stdout: 'p1\nn/x\n' }), ['/x']);
  assert.equal(R.pathsFromLsofError({ status: 1, stdout: '' }), null);
});

test('relative gitdir resolves against the worktree; missing or malformed .git is kept, not orphaned', () => {
  const r = root();
  const repoGit = path.join(r, 'repo', '.git', 'worktrees', 'main');
  fs.mkdirSync(repoGit, { recursive: true });
  const parent = fs.mkdtempSync(path.join(r, 'linear-done-verify-'));
  const wt = path.join(parent, 'main');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, repoGit)}\n`);
  assert.equal(R.checkoutKind(wt), 'registered');
  fs.writeFileSync(path.join(wt, '.git'), 'garbage\n');
  assert.equal(R.checkoutKind(wt), 'other');
  fs.rmSync(path.join(wt, '.git'));
  assert.equal(R.checkoutKind(wt), 'other');
  const o = orphan(r);
  fs.rmSync(path.join(o.wt, '.git'));
  const s = R.reapTempCheckouts({ roots: [r] });
  assert.equal(s.removed, 0, JSON.stringify(s.results));
  assert.ok(fs.existsSync(o.parent));
});

test('TEMP_CHECKOUT_REAP_DISABLED=1 stops every entry point, including the single-checkout path', () => {
  const r = root();
  const o = orphan(r);
  process.env.TEMP_CHECKOUT_REAP_DISABLED = '1';
  try {
    assert.equal(R.reapOne(o.parent).removed, false);
    assert.equal(R.reapTempCheckouts({ roots: [r] }).removed, 0);
    assert.notEqual(spawnSync(process.execPath, [require.resolve('./reap-temp-checkouts.js'), '--one', o.wt], { env: process.env }).status, 0);
  } finally { delete process.env.TEMP_CHECKOUT_REAP_DISABLED; }
  assert.ok(fs.existsSync(o.parent));
});

test('BRO-8124: lsof parse skips the cleaning process itself; check-run dirt is classified narrowly', () => {
  const { parseLsofPaths } = require('./reap-temp-checkouts.js');
  const { isCheckRunDirt } = require('./acceptance-checkout-owner.js');
  const out = 'p100\nn/tmp/a/main/x\np200\nn/tmp/b/main/y\n';
  assert.deepEqual(parseLsofPaths(out), ['/tmp/a/main/x', '/tmp/b/main/y']);
  assert.deepEqual(parseLsofPaths(out, 100), ['/tmp/b/main/y']);
  for (const l of [' M data/audit/stage-latency.jsonl', ' D LICENSE', 'D  b.txt', '?? .bro-3151-test-kkNL7v/hamilton-2015/x.json', '?? scripts/__pycache__/a.pyc']) assert.equal(isCheckRunDirt(l), true, l);
  for (const l of [' M scripts/lib/foo.js', '?? notes.md', 'R  a -> b', ' M data/shows.json', '?? "weird name"']) assert.equal(isCheckRunDirt(l), false, l);
});
