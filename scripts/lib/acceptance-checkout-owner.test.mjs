import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeOwner, ownerState, canReapCheckout, removableTempCheckout, OWNER_FILE } = require('./acceptance-checkout-owner.js');
const { removeCheckout } = require('./acceptance-check-core.js');

test('owner records distinguish live, dead, reused and unknown process identities', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  assert.equal(ownerState(dir), 'legacy');
  writeOwner(dir);
  assert.equal(ownerState(dir), 'live');
  const file = path.join(dir, OWNER_FILE);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: 'different process start' }));
  assert.equal(ownerState(dir), 'unknown');
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, started: 'finished child' }));
  assert.equal(ownerState(dir), 'dead');
  fs.writeFileSync(file, 'torn');
  assert.equal(ownerState(dir), 'unknown');
});

test('cleanup preserves dirty, unmerged and locked work and removes a clean checkout', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-safe-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'source'), 'original');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha); // HEAD is on origin/main
  const parent = path.join(dir, 'owned');
  const wt = path.join(parent, 'main');
  git(repo, 'worktree', 'add', '--detach', wt, sha);
  writeOwner(parent);
  const co = { dir: parent, wt, repo, sha };
  assert.equal(canReapCheckout(wt), false, 'live owner protects even a clean tree');
  fs.writeFileSync(path.join(parent, OWNER_FILE), JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, started: 'finished child' }));
  assert.equal(canReapCheckout(wt), true, 'a dead owner with no remaining process is reclaimable');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  assert.equal(canReapCheckout(wt), false, 'a child still running in the checkout protects it');
  child.kill();
  await once(child, 'exit');
  fs.writeFileSync(path.join(wt, '.env'), 'PRIVATE_VALUE=preserve');
  assert.equal(canReapCheckout(wt), false);
  assert.equal(removeCheckout(co), false);
  fs.unlinkSync(path.join(wt, '.env'));
  fs.writeFileSync(path.join(wt, 'source'), 'uncommitted');
  git(wt, 'add', '.');
  git(wt, '-c', 'commit.gpgsign=false', 'commit', '-m', 'unmerged');
  assert.equal(removeCheckout(co), false, 'a commit off the pinned sha is kept');
  git(wt, 'reset', '--hard', sha);
  git(repo, 'worktree', 'lock', wt);
  assert.equal(removeCheckout(co), false, 'a deliberate git lock is kept');
  assert.equal(fs.existsSync(wt), true);
  git(repo, 'worktree', 'unlock', wt);
  // A file held open under the checkout keeps it even though --force would delete it.
  const holder = spawn(process.execPath, ['-e', `const fs=require('fs');fs.openSync(${JSON.stringify(path.join(wt, 'source'))},'r');process.stdout.write('ready');setInterval(()=>{},1000)`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill());
  await once(holder.stdout, 'data');
  assert.equal(removeCheckout(co), false, 'an open file under it keeps it');
  holder.kill();
  await once(holder, 'exit');
  // A real source edit (not something a check run writes) keeps it.
  fs.writeFileSync(path.join(wt, 'source'), 'someone edited this');
  assert.equal(removeCheckout(co), false, 'an unexpected source edit is kept');
  git(wt, 'checkout', '--', 'source');
  // BRO-8124: what the checks wrote (data/audit churn, a root test temp dir,
  // a deleted file) does not keep a finished checkout...
  fs.mkdirSync(path.join(wt, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'data', 'audit', 'stage-latency.jsonl'), '{"showId":"example-show-2026"}\n');
  fs.mkdirSync(path.join(wt, '.bro-3151-test-abc123'));
  fs.writeFileSync(path.join(wt, '.bro-3151-test-abc123', 'fixture.json'), '{}');
  fs.unlinkSync(path.join(wt, '.gitignore'));
  // ...unless the kill switch restores the strict rule.
  process.env.TEMP_CHECKOUT_REAP_DISABLED = '1';
  try { assert.equal(removeCheckout(co), false, 'kill switch: any dirt keeps it'); }
  finally { delete process.env.TEMP_CHECKOUT_REAP_DISABLED; }
  assert.equal(removeCheckout(co), true);
  assert.equal(fs.existsSync(parent), false);
  assert.ok(!git(repo, 'worktree', 'list').includes(wt), 'worktree deregistered');
});

test('BRO-8124: an initializing lock from a killed `git worktree add` does not keep a dead checkout', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-init-')));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a'), 'a');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=F', '-c', 'user.email=f@x.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const parent = path.join(dir, 'owned');
    const wt = path.join(parent, 'main');
    git(repo, 'worktree', 'add', '--detach', wt, sha);
    writeOwner(parent);
    git(repo, 'worktree', 'lock', '--reason', 'initializing', wt);
    assert.equal(removableTempCheckout(wt, { sha }).force, 2);
    assert.equal(removeCheckout({ dir: parent, wt, repo, sha }), true);
    assert.equal(fs.existsSync(parent), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
