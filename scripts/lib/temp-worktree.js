'use strict';

/**
 * Temp git worktrees that TEST FIXTURES register against the real repo
 * (BRO-2892).
 *
 * `git worktree add` registers the new worktree LOCKED with reason
 * "initializing" and only unlocks it once checkout finishes. Our hook test
 * suites (scripts/pre-push.test.mjs, scripts/tests/merge-gate-hook.test.mjs)
 * run that add under a SIGKILL timeout, and their teardown used a single
 * `git worktree remove --force`, which git REFUSES for a locked worktree
 * ("use 'remove -f -f' to override or unlock first"). The teardown then
 * rm -rf'd the directory anyway, leaving a registration that is locked, so
 * `git worktree prune` skips it forever, and whose directory is gone or has
 * no .git file. audit-stranded-reviewed-branches.js could not classify those
 * and reported the whole sweep UNTRUSTWORTHY.
 *
 * Every fixture that registers a worktree on the real repo goes through this
 * module: removeTempWorktree() survives the locked state, registerExitCleanup()
 * covers interrupts (SIGINT/SIGTERM/exit), and reapStaleTempWorktrees() runs at
 * the start of each suite to clear what a SIGKILL'd earlier run left behind.
 * tests/unit/pre-push-hook.test.mjs pins all three plus a static guard that no
 * fixture creates such a worktree without this module.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseWorktreePorcelain } = require('./worktree-lock-parse');

// Basename prefixes only test fixtures ever use. Nothing a real session
// creates starts with these, so a match is fixture debris, never work.
const TEMP_WORKTREE_PREFIXES = Object.freeze(['pre-push-hook-wt-', 'merge-gate-hook-test-']);

// A hook suite finishes in minutes. A fixture registration older than this is
// dead; younger ones may belong to a suite running right now in a parallel
// session ("initializing" is also the state of a legitimately in-flight add).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const GIT_TIMEOUT_MS = 30_000;
// Deleting a full checkout of this repo took 15-30s on a loaded machine and
// was SIGKILLed at 30s in testing, so `worktree remove` gets more room.
const REMOVE_TIMEOUT_MS = 180_000;

function isTempFixtureWorktreePath(p, prefixes = TEMP_WORKTREE_PREFIXES) {
  const base = path.basename(String(p || ''));
  return prefixes.some((pre) => base.startsWith(pre));
}

// Pure decision: reap a registered worktree only when it is a fixture by name
// AND its registration is older than the stale threshold. ageMs null means the
// age could not be read; leave it (fail safe toward not deleting).
function isStaleTempWorktree({ path: p, ageMs }, { prefixes = TEMP_WORKTREE_PREFIXES, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!isTempFixtureWorktreePath(p, prefixes)) return false;
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return false;
  return ageMs >= staleAfterMs;
}

function git(repoRoot, args, timeout = GIT_TIMEOUT_MS) {
  return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
}

function commonGitDir(repoRoot) {
  const r = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Map each registered worktree path to its admin dir (.git/worktrees/<name>),
// read from each admin dir's gitdir file. Works even when the worktree's own
// directory (and so its .git file) is gone.
function adminDirsByPath(repoRoot) {
  const out = new Map();
  const common = commonGitDir(repoRoot);
  if (!common) return out;
  const root = path.join(common, 'worktrees');
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    const admin = path.join(root, name);
    try {
      const gitdir = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
      out.set(path.dirname(gitdir), admin);
    } catch { /* not a worktree admin dir */ }
  }
  return out;
}

function sameRealPath(a, b) {
  const norm = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return path.resolve(a) === path.resolve(b) || norm(a) === norm(b);
}

function registeredEntry(repoRoot, dir) {
  const r = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return null;
  return parseWorktreePorcelain(r.stdout).find((e) => sameRealPath(e.path, dir)) || null;
}

/**
 * Remove a fixture worktree on any exit path: unlock (a no-op when not
 * locked), remove with double force (works on a locked entry), delete the
 * directory, then prune so a registration whose directory was already gone is
 * dropped. Returns { removed: true } when no registration for dir remains.
 */
function removeTempWorktree(repoRoot, dir) {
  if (!dir) return { removed: true };
  const entry = registeredEntry(repoRoot, dir);
  const target = entry ? entry.path : dir;
  git(repoRoot, ['worktree', 'unlock', target]);
  git(repoRoot, ['worktree', 'remove', '-f', '-f', target], REMOVE_TIMEOUT_MS);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
  if (registeredEntry(repoRoot, dir)) {
    // remove was killed or the directory was already gone. With the directory
    // deleted, an UNLOCKED registration is exactly what prune clears; unlock
    // again because prune skips a locked entry forever.
    git(repoRoot, ['worktree', 'unlock', target]);
    git(repoRoot, ['worktree', 'prune']);
  }
  return { removed: registeredEntry(repoRoot, dir) === null };
}

// Registration ages are measured against file mtimes, so "now" must come from
// the filesystem clock too. Date.now() is shifted by the time-bomb audit
// (tests/helpers/clock-shift.mjs); using it here made every live sibling
// suite's fixture look stale and reapable (BRO-6389).
function fsClockNow() {
  try {
    const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fs-clock-'));
    const t = fs.statSync(d).mtimeMs;
    fs.rmdirSync(d);
    return t;
  } catch { return Date.now(); }
}

/**
 * Clear fixture registrations left by earlier runs that never reached
 * teardown (SIGKILL, OOM, a killed CI job). Only names matching
 * TEMP_WORKTREE_PREFIXES and older than staleAfterMs are touched.
 */
function reapStaleTempWorktrees(repoRoot, { now = fsClockNow(), prefixes = TEMP_WORKTREE_PREFIXES, staleAfterMs = STALE_AFTER_MS } = {}) {
  const r = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const admins = adminDirsByPath(repoRoot);
  const reaped = [];
  for (const entry of parseWorktreePorcelain(r.stdout)) {
    if (!isTempFixtureWorktreePath(entry.path, prefixes)) continue;
    let admin = admins.get(entry.path);
    if (!admin) for (const [p, a] of admins) if (sameRealPath(p, entry.path)) { admin = a; break; }
    let ageMs = null;
    try { ageMs = now - fs.statSync(admin).mtimeMs; } catch { /* unknown age: leave it */ }
    if (!isStaleTempWorktree({ path: entry.path, ageMs }, { prefixes, staleAfterMs })) continue;
    const { removed } = removeTempWorktree(repoRoot, entry.path);
    reaped.push({ path: entry.path, lockReason: entry.lockReason, removed });
  }
  return reaped;
}

/**
 * Run cleanup once on normal exit, an uncaught throw, or SIGINT/SIGTERM/
 * SIGHUP. Signal handlers re-raise the signal after cleanup so the process
 * still dies with the original signal. SIGKILL cannot be caught; the next
 * suite's reapStaleTempWorktrees() covers that.
 */
function registerExitCleanup(fn) {
  let done = false;
  const run = () => { if (done) return; done = true; try { fn(); } catch { /* never mask the exit */ } };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = (sig) => {
    run();
    for (const s of signals) process.removeListener(s, handlers[s]);
    process.kill(process.pid, sig);
  };
  const handlers = {};
  for (const s of signals) { handlers[s] = () => onSignal(s); process.on(s, handlers[s]); }
  process.on('exit', run);
  return run;
}

module.exports = {
  TEMP_WORKTREE_PREFIXES,
  STALE_AFTER_MS,
  isTempFixtureWorktreePath,
  isStaleTempWorktree,
  removeTempWorktree,
  reapStaleTempWorktrees,
  registerExitCleanup,
};
