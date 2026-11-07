'use strict';
// The ONE place that knows the owner Mac's checkout path (BRO-2682/2681/3545/4295).
//
// Many scripts want "the main checkout": shared ledgers, locks, .env and data
// that must not split per worktree (see dispatch-ledger.js's header). They used
// to hardcode '/Users/tompryor/Broadwayscore', which does not exist on a CI
// runner or a cloud container, and anything that mkdir -p'd under it created a
// stray partial tree there. That stray tree then fooled existsSync()-based
// "am I on the Mac?" checks (bsc-next/linear-next refused every acceptance path
// as phantom, 15 red tests in cloud). tests/unit/hardcoded-broadwayscore-path.test.mjs
// fails if the literal appears anywhere else.
//
// Resolution order for MAIN_REPO_ROOT:
//   1. BSC_REPO_ROOT env var (explicit override)
//   2. MAC_REPO, but only when it is a real checkout (package.json + .git),
//      so a stray partial dir never counts
//   3. the main checkout this file belongs to, read from .git without
//      spawning git (a worktree's .git file points back at it)
//   4. this file's own checkout root
const fs = require('fs');
const path = require('path');

const MAC_REPO = '/Users/tompryor/Broadwayscore';
const SELF_ROOT = path.resolve(__dirname, '..', '..');

function isCheckout(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile()
      && fs.existsSync(path.join(dir, '.git'));
  } catch { return false; }
}

// Main checkout for the checkout containing `fromDir`, or null when no .git
// is found walking up. A linked worktree's .git is a file
// "gitdir: <main>/.git/worktrees/<name>"; the main checkout's is a directory.
function mainCheckoutOf(fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { /* keep walking */ }
    if (st && st.isDirectory()) return dir;
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return dir;
      const gitdir = path.resolve(dir, m[1]);
      const wt = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir);
      return wt ? wt[1] : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveRepoRoot({ env = process.env, macRepo = MAC_REPO, fromDir = SELF_ROOT } = {}) {
  if (env.BSC_REPO_ROOT) return path.resolve(env.BSC_REPO_ROOT);
  if (isCheckout(macRepo)) return macRepo;
  return mainCheckoutOf(fromDir) || path.resolve(fromDir);
}

const MAIN_REPO_ROOT = resolveRepoRoot();

module.exports = { MAC_REPO, MAIN_REPO_ROOT, isCheckout, mainCheckoutOf, resolveRepoRoot };
