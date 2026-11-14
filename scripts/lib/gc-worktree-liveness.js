#!/usr/bin/env node
'use strict';
/**
 * Liveness guard for gc-merged-worktrees.sh (task #1709).
 *
 * git's own dirty-tree refusal protects uncommitted changes, but nothing
 * protected a worktree that is clean-but-still-in-use by a running process
 * (e.g. a dev server, a background watcher) — the GC would happily
 * `git worktree remove` out from under it. Found 2026-08-16: worktree
 * tony-page-season-guard was removed while pids 93138/93152 still had it as
 * their cwd (turned out to be a harmless 5-day-old orphaned `next start`,
 * but the gap was real).
 *
 * hasLiveProcessInDir() answers "is any live process's cwd this path, or
 * somewhere under it" via `lsof -a -d cwd -F pn` — a listing of every
 * process's cwd file descriptor, not a directory-tree scan (`lsof +D <dir>`
 * would work too but walks the whole tree, which is slow and pointless here
 * since only the cwd FD matters).
 */
const { execFileSync } = require('child_process');
const { LSOF } = require('./system-bin');
const fs = require('fs');
const path = require('path');
const { classifyCwdPin, cwdPinBlocks, parseLsofCwds, parsePsTable } = require('./worktree-gc-reclaim.js');

/**
 * @param {string} worktreePath - absolute path to the worktree directory
 * @returns {boolean} true iff a live process has worktreePath (or a path
 *   under it) as its current working directory. Fails safe: any error
 *   running lsof (missing binary, permission denied, unexpected format)
 *   reports true (live) rather than risk removing an in-use worktree.
 */
function hasLiveProcessInDir(worktreePath) {
  // lsof reports resolved paths (e.g. macOS /var/... -> /private/var/...),
  // so a symlinked worktreePath would never match without resolving it the
  // same way first. realpathSync is safe here: callers only ever pass a
  // directory that exists (a registered worktree or a test fixture).
  let target;
  try {
    target = fs.realpathSync(worktreePath);
  } catch {
    target = path.resolve(worktreePath);
  }
  let out;
  try {
    // Bound the call — a hung/wedged lsof (adversarial review, task #1709)
    // would otherwise stall the ENTIRE GC run indefinitely, the same
    // failure shape gc-merged-worktrees.sh already guards against for
    // `git fetch`/`git cherry` (see its own "Bound the fetch" comment). A
    // timeout throws here, which the catch below treats as fail-safe
    // "unknown -> live" like any other lsof failure.
    out = execFileSync(LSOF, ['-a', '-d', 'cwd', '-F', 'pn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    });
  } catch {
    // lsof missing, permission denied, timed out, or any other failure —
    // genuinely unknown whether the worktree is in use. Fail safe: treat as
    // live rather than risk removing one that is.
    return true;
  }
  for (const line of out.split('\n')) {
    if (!line.startsWith('n')) continue;
    const cwd = line.slice(1);
    if (cwd === target || cwd.startsWith(target + path.sep)) return true;
  }
  return false;
}

/**
 * BRO-2694: classify WHO pins the worktree (see classifyCwdPin in
 * worktree-gc-reclaim.js) from one lsof cwd snapshot plus one ps snapshot.
 * Any lsof/ps failure -> 'unknown' (keep), same fail-safe as above.
 * hasLiveProcessInDir stays untouched: bsc-reconcile.js relies on its
 * any-process-means-live contract.
 *
 * @returns {{pin: string, pids: number[], reason: string}}
 */
function cwdPinStatus(worktreePath, { minAgeHours = process.env.WORKTREE_GC_PIN_MIN_AGE_HOURS } = {}) {
  let target;
  try {
    target = fs.realpathSync(worktreePath);
  } catch {
    target = path.resolve(worktreePath);
  }
  let lsofOut;
  let psOut;
  try {
    lsofOut = execFileSync(LSOF, ['-a', '-d', 'cwd', '-F', 'pn'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 64 * 1024 * 1024,
    });
    psOut = execFileSync('ps', ['-ww', '-A', '-o', 'pid=,ppid=,etime=,tty=,command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { pin: 'unknown', pids: [], reason: 'lsof or ps failed' };
  }
  return classifyCwdPin({
    worktreePath: target,
    cwds: parseLsofCwds(lsofOut),
    procs: parsePsTable(psOut),
    minAgeHours,
    sep: path.sep,
  });
}

function main() {
  const argv = process.argv.slice(2);
  const arg = argv.find((a) => a.startsWith('--path='));
  const worktreePath = arg ? arg.slice('--path='.length) : argv.find((a) => !a.startsWith('--'));
  if (!worktreePath) {
    console.error('usage: gc-worktree-liveness.js --path=<worktree-dir> [--classify]');
    process.exit(2);
  }
  if (argv.includes('--classify')) {
    // Prints the bare class on line 1 (gc-merged-worktrees.sh reads it; any
    // other output there is treated as 'unknown'), JSON detail on line 2.
    // Exit 0 iff the class alone blocks removal.
    const status = cwdPinStatus(worktreePath);
    console.log(status.pin);
    console.log(JSON.stringify({ path: worktreePath, ...status }));
    process.exit(cwdPinBlocks(status.pin) ? 0 : 1);
  }
  const live = hasLiveProcessInDir(worktreePath);
  console.log(JSON.stringify({ path: worktreePath, live }));
  // Exit codes: 0 = live process found (do NOT remove), 1 = clear (safe to remove).
  process.exit(live ? 0 : 1);
}

if (require.main === module) main();

module.exports = { hasLiveProcessInDir, cwdPinStatus };
