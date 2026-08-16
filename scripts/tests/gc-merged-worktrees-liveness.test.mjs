// scripts/tests/gc-merged-worktrees-liveness.test.mjs
//
// Acceptance test for task #1709: gc-merged-worktrees.sh had no liveness
// guard — it could `git worktree remove` a merged, clean worktree that was
// still a live process's cwd (a dev server, a background watcher). git's own
// dirty-tree refusal doesn't help here because there's nothing dirty for it
// to refuse on. Found 2026-08-16: worktree tony-page-season-guard was
// removed while pids 93138/93152 still had it as their cwd.
//
// Per CLAUDE.md rule 15 this require()s the REAL exported function from
// scripts/lib/gc-worktree-liveness.js (hasLiveProcessInDir) — the same
// function gc-merged-worktrees.sh's removal loop calls via the CLI wrapper
// before every `git worktree remove` — it does not reimplement the check.
//
// Spawns a REAL background process (node:child_process spawn, not a fake)
// with its cwd inside a merged, clean git worktree built from a throwaway
// temp repo, and asserts the function declines that worktree while still
// clearing an identical merged, clean worktree with no process in it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { hasLiveProcessInDir } = require('../lib/gc-worktree-liveness.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Build a throwaway repo with a `main` branch and two worktrees, both
// branched from (and therefore already fully merged into) main — i.e. both
// are "merged, clean" from gc-merged-worktrees.sh's point of view. Only
// their liveness differs.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-liveness-test-'));
const mainRepo = path.join(root, 'main-repo');
fs.mkdirSync(mainRepo);
git(['init', '-q', '-b', 'main'], mainRepo);
git(['config', 'user.email', 'test@example.com'], mainRepo);
git(['config', 'user.name', 'Test'], mainRepo);
fs.writeFileSync(path.join(mainRepo, 'README.md'), 'gc liveness test fixture\n');
git(['add', '.'], mainRepo);
git(['commit', '-q', '-m', 'init'], mainRepo);

const liveWorktree = path.join(root, 'wt-live');
const idleWorktree = path.join(root, 'wt-idle');
git(['worktree', 'add', '-q', '-b', 'wt-live-branch', liveWorktree, 'main'], mainRepo);
git(['worktree', 'add', '-q', '-b', 'wt-idle-branch', idleWorktree, 'main'], mainRepo);

// A real, long-lived child process with its cwd inside liveWorktree —
// standing in for a dev server or background watcher left running there.
const liveProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  cwd: liveWorktree,
  stdio: 'ignore',
  detached: false,
});

after(() => {
  liveProc.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

// Give the child a moment to actually start and register its cwd with the
// kernel before lsof goes looking for it.
function waitForPid(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* busy-wait: node:test has no built-in sleep primitive worth pulling in for 200ms */
  }
}
waitForPid(300);

test('hasLiveProcessInDir declines a merged, clean worktree that is a live process\'s cwd', () => {
  assert.equal(hasLiveProcessInDir(liveWorktree), true);
});

test('hasLiveProcessInDir clears an identical merged, clean worktree with no live process in it', () => {
  assert.equal(hasLiveProcessInDir(idleWorktree), false);
});

test('after the live process exits, the same worktree is no longer reported as live', async () => {
  liveProc.kill('SIGKILL');
  await new Promise((resolve) => liveProc.once('exit', resolve));
  // Give the kernel a moment to release the fd table entry.
  waitForPid(300);
  assert.equal(hasLiveProcessInDir(liveWorktree), false);
});
