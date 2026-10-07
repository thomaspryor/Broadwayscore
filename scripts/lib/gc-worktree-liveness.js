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
const fs = require('fs');
const path = require('path');

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
    out = execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], {
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

function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--path='));
  const worktreePath = arg ? arg.slice('--path='.length) : process.argv[2];
  if (!worktreePath) {
    console.error('usage: gc-worktree-liveness.js --path=<worktree-dir>');
    process.exit(2);
  }
  const live = hasLiveProcessInDir(worktreePath);
  console.log(JSON.stringify({ path: worktreePath, live }));
  // Exit codes: 0 = live process found (do NOT remove), 1 = clear (safe to remove).
  process.exit(live ? 0 : 1);
}

if (require.main === module) main();

module.exports = { hasLiveProcessInDir };
