// BRO-2892: the pre-push hook test fixture (and the merge-gate hook fixture)
// leaked worktrees registered on the real repo, locked 'initializing', which
// `git worktree prune` never clears and which made
// scripts/audit-stranded-reviewed-branches.js report UNTRUSTWORTHY.
//
// These tests drive scripts/lib/temp-worktree.js (the real functions, rule 15)
// against throwaway repos and pin every exit path: normal teardown, a
// timed-out add that left the lock behind, SIGINT/SIGTERM, and SIGKILL (which
// the next suite's reaper clears). A static guard keeps any new fixture from
// registering a worktree on the real repo without the helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HELPER = path.join(REPO_ROOT, 'scripts', 'lib', 'temp-worktree.js');
const {
  TEMP_WORKTREE_PREFIXES,
  STALE_AFTER_MS,
  isTempFixtureWorktreePath,
  isStaleTempWorktree,
  removeTempWorktree,
  reapStaleTempWorktrees,
} = require(HELPER);
const { parseWorktreePorcelain } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'worktree-lock-parse.js'));

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2892-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', 'a.txt']);
  const c = git(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init']);
  assert.equal(c.status, 0, c.stderr);
  return dir;
}

function fixtureDir(prefix = 'pre-push-hook-wt-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return d;
}

function addWorktree(repo, dir) {
  const r = git(repo, ['worktree', 'add', '-q', '--detach', dir, 'main']);
  assert.equal(r.status, 0, r.stderr);
}

function entries(repo) {
  return parseWorktreePorcelain(git(repo, ['worktree', 'list', '--porcelain']).stdout);
}

function isRegistered(repo, dir) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return entries(repo).some((e) => e.path === dir || real(e.path) === real(dir));
}

function cleanup(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

test('reproduces the leak: a locked "initializing" registration survives remove --force + rm + prune', () => {
  const repo = makeRepo();
  const wt = fixtureDir();
  try {
    addWorktree(repo, wt);
    git(repo, ['worktree', 'lock', '--reason', 'initializing', wt]);
    const r = git(repo, ['worktree', 'remove', '--force', wt]);
    assert.notEqual(r.status, 0, 'git refused single-force remove of a locked worktree');
    fs.rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    git(repo, ['worktree', 'prune']);
    assert.ok(isRegistered(repo, wt), 'old teardown leaves the locked registration behind');
    // The helper clears exactly this leftover state.
    assert.deepEqual(removeTempWorktree(repo, wt), { removed: true });
    assert.ok(!isRegistered(repo, wt));
  } finally { cleanup(repo, wt); }
});

test('removeTempWorktree: locked "initializing" with the checkout present but no .git file', () => {
  const repo = makeRepo();
  const wt = fixtureDir();
  try {
    addWorktree(repo, wt);
    git(repo, ['worktree', 'lock', '--reason', 'initializing', wt]);
    fs.rmSync(path.join(wt, '.git'));
    assert.deepEqual(removeTempWorktree(repo, wt), { removed: true });
    assert.ok(!isRegistered(repo, wt));
    assert.ok(!fs.existsSync(wt), 'directory removed too');
  } finally { cleanup(repo, wt); }
});

test('removeTempWorktree: normal unlocked teardown, and a never-registered path, both succeed', () => {
  const repo = makeRepo();
  const wt = fixtureDir();
  try {
    addWorktree(repo, wt);
    assert.deepEqual(removeTempWorktree(repo, wt), { removed: true });
    assert.ok(!isRegistered(repo, wt));
    assert.deepEqual(removeTempWorktree(repo, fixtureDir()), { removed: true });
    assert.deepEqual(removeTempWorktree(repo, null), { removed: true });
  } finally { cleanup(repo, wt); }
});

test('isStaleTempWorktree: only fixture names, only past the threshold, unknown age is left alone', () => {
  const old = STALE_AFTER_MS + 1;
  assert.equal(isStaleTempWorktree({ path: '/tmp/pre-push-hook-wt-abc', ageMs: old }), true);
  assert.equal(isStaleTempWorktree({ path: '/private/tmp/merge-gate-hook-test-probe-wt-x', ageMs: old }), true);
  assert.equal(isStaleTempWorktree({ path: '/tmp/pre-push-hook-wt-abc', ageMs: 60_000 }), false, 'in-flight suite');
  assert.equal(isStaleTempWorktree({ path: '/tmp/pre-push-hook-wt-abc', ageMs: null }), false);
  assert.equal(isStaleTempWorktree({ path: '/repo/.claude/worktrees/bro-1', ageMs: old }), false, 'session worktree');
  assert.equal(isTempFixtureWorktreePath('/x/pre-push-hook-wt-'), true);
  assert.equal(isTempFixtureWorktreePath('/x/my-pre-push-hook-wt-1'), false);
});

test('reapStaleTempWorktrees: reaps stale fixture debris, keeps fresh fixtures and session worktrees', () => {
  const repo = makeRepo();
  const stale = fixtureDir('pre-push-hook-wt-');
  const staleGone = fixtureDir('merge-gate-hook-test-probe-wt-');
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2892-session-'));
  fs.rmSync(session, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  try {
    addWorktree(repo, stale);
    addWorktree(repo, staleGone);
    addWorktree(repo, session);
    for (const d of [stale, staleGone, session]) git(repo, ['worktree', 'lock', '--reason', 'initializing', d]);
    fs.rmSync(path.join(stale, '.git'));
    fs.rmSync(staleGone, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    // Fresh: nothing is reaped (a parallel suite may be mid-add right now).
    // `now` comes from the filesystem clock (the registrations' mtimes use it),
    // not Date.now(), so the test is immune to a shifted/faked process clock.
    const probe = path.join(repo, '.fs-clock-probe');
    fs.writeFileSync(probe, '');
    const fsNow = fs.statSync(probe).mtimeMs;
    assert.deepEqual(reapStaleTempWorktrees(repo, { now: fsNow }), []);
    assert.ok(isRegistered(repo, stale) && isRegistered(repo, staleGone));

    const reaped = reapStaleTempWorktrees(repo, { now: fsNow + STALE_AFTER_MS + 60_000 });
    assert.equal(reaped.length, 2);
    assert.ok(reaped.every((r) => r.removed && r.lockReason === 'initializing'));
    assert.ok(!isRegistered(repo, stale) && !isRegistered(repo, staleGone));
    assert.ok(isRegistered(repo, session), 'a non-fixture locked worktree is never touched');
  } finally {
    git(repo, ['worktree', 'unlock', session]);
    cleanup(repo, stale, staleGone, session);
  }
});

// A child process that registers a fixture worktree exactly the way the hook
// suites do, then waits to be signalled.
function startChild(repo, wt) {
  const script = `
    const { removeTempWorktree, registerExitCleanup } = require(${JSON.stringify(HELPER)});
    const { spawnSync } = require('child_process');
    registerExitCleanup(() => removeTempWorktree(${JSON.stringify(repo)}, ${JSON.stringify(wt)}));
    const r = spawnSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'add', '-q', '--detach', ${JSON.stringify(wt)}, 'main']);
    if (r.status !== 0) process.exit(9);
    spawnSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'lock', '--reason', 'initializing', ${JSON.stringify(wt)}]);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { if (String(b).includes('ready')) resolve(); });
    child.on('exit', (code, sig) => reject(new Error(`child exited early: ${code} ${sig}`)));
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, exited };
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`interrupt (${sig}) mid-flight: the locked fixture registration is removed and the signal still kills the process`, async () => {
    const repo = makeRepo();
    const wt = fixtureDir();
    try {
      const { child, ready, exited } = startChild(repo, wt);
      await ready;
      assert.ok(isRegistered(repo, wt), 'fixture registered before the interrupt');
      child.kill(sig);
      const { signal } = await exited;
      assert.equal(signal, sig, 'cleanup re-raises the original signal');
      assert.ok(!isRegistered(repo, wt), `${sig} left a registration behind`);
      assert.ok(!entries(repo).some((e) => path.basename(e.path).startsWith('pre-push-hook-wt-')));
    } finally { cleanup(repo, wt); }
  });
}

test('SIGKILL mid-flight: the leftover is reaped by the next suite once stale', async () => {
  const repo = makeRepo();
  const wt = fixtureDir();
  try {
    const { child, ready, exited } = startChild(repo, wt);
    await ready;
    child.kill('SIGKILL');
    await exited;
    assert.ok(isRegistered(repo, wt), 'SIGKILL cannot be caught, so the registration survives');
    reapStaleTempWorktrees(repo, { staleAfterMs: 0 });
    assert.ok(!isRegistered(repo, wt));
  } finally { cleanup(repo, wt); }
});

test('guard: every test fixture that registers a worktree on the real repo uses temp-worktree.js', () => {
  // Matches `['-C', REPO_ROOT, 'worktree', 'add'` and `git(Ok)?(CANONICAL_ROOT, ['worktree', 'add'`.
  const REAL_REPO_ADD = /(?:'-C',\s*(?:REPO_ROOT|CANONICAL_ROOT|MAIN_ROOT)\s*,\s*'worktree',\s*'add'|\b\w+\(\s*(?:REPO_ROOT|CANONICAL_ROOT|MAIN_ROOT)\s*,\s*\[\s*'worktree',\s*'add')/;
  const offenders = [];
  let matched = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.test\.(?:mjs|cjs|js)$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (!REAL_REPO_ADD.test(src)) continue;
        matched++;
        if (!src.includes('temp-worktree.js')) offenders.push(path.relative(REPO_ROOT, p));
        const prefixes = [...src.matchAll(/os\.tmpdir\(\),\s*[`'](pre-push-hook-wt-|merge-gate-hook-test-)/g)].map((m) => m[1]);
        for (const pre of prefixes) assert.ok(TEMP_WORKTREE_PREFIXES.includes(pre), `${p}: prefix ${pre} not in TEMP_WORKTREE_PREFIXES`);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'scripts'));
  walk(path.join(REPO_ROOT, 'tests'));
  assert.ok(matched >= 2, `guard regex found only ${matched} real-repo fixtures; it has gone blind`);
  assert.deepEqual(offenders, [], 'register real-repo fixture worktrees via scripts/lib/temp-worktree.js (BRO-2892)');
});

test('real repo: the reaper removes every stale hook-fixture registration it finds', () => {
  const reaped = reapStaleTempWorktrees(REPO_ROOT);
  assert.deepEqual(reaped.filter((r) => !r.removed), [], 'a stale fixture registration could not be removed');
  assert.deepEqual(reapStaleTempWorktrees(REPO_ROOT), [], 'stale fixture registrations remain after reaping');
});
