/**
 * autonomous-data-workdir.js — Tier-2 branch mechanics (Sprint 4, S4-T2).
 *
 * Tier 1 branches inside THIS repo's own worktree. Tier-2 cards write to one
 * of two private repos instead (~/broadway-scorecard-data or this repo's
 * data/review-texts/ nested clone) — the executor must never mutate their
 * mains. This builds a scratch "verification root" shaped like this repo's
 * own data/ layout (shows.json + review-texts/ as siblings), backed by a
 * fresh `auto/*` branch worktree of whichever private repo the card's class
 * touches, so:
 *   - the implementer (claude CLI, cwd = scratchRoot) edits real files
 *     through the symlink, same as an interactive session's local checkout
 *   - verify-review-recovery.js (cwd-resolved by design) sees the right
 *     data/review-texts + data/reviews.json shape
 *   - validate-show-venue.js is pointed at scratchRoot/data via --data-dir
 *     (its DATA_DIR is otherwise fixed to its own __dirname, see that file)
 *
 * NEVER touches origin/main of either private repo: worktrees are created
 * with `-B <branch> origin/main` (branch off, never checkout main itself)
 * and pushed to a new branch ref, mirroring Sprint 3's web-repo invariant.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function scorecardDataRoot(opts = {}) {
  return opts.scorecardDataRoot || path.join(os.homedir(), 'broadway-scorecard-data');
}

function reviewTextsRoot(repoRoot) {
  return path.join(repoRoot, 'data', 'review-texts');
}

// repoKey: 'scorecard-data' | 'review-texts' (see autonomous-eligibility.js
// DATA_CLASS_REPO). repoRoot: this repo's root (for locating the nested
// review-texts clone) — required only when repoKey is 'review-texts' and no
// explicit reviewTextsPath override is given.
function buildDataWorkdir({ repoKey, branch, scratchRoot, repoRoot, scorecardDataPath, reviewTextsPath }) {
  if (!scratchRoot) throw new Error('buildDataWorkdir: scratchRoot is required');
  if (!branch) throw new Error('buildDataWorkdir: branch is required');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const dataDir = path.join(scratchRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const worktrees = {};
  if (repoKey === 'scorecard-data') {
    const root = scorecardDataPath || scorecardDataRoot();
    const wt = path.join(scratchRoot, 'scorecard-data-wt');
    git(root, ['fetch', 'origin', 'main']);
    git(root, ['worktree', 'add', '-B', branch, wt, 'origin/main']);
    worktrees.scorecardData = { root, path: wt };
    fs.symlinkSync(path.join(wt, 'shows.json'), path.join(dataDir, 'shows.json'));
  } else if (repoKey === 'review-texts') {
    const root = reviewTextsPath || reviewTextsRoot(repoRoot);
    const wt = path.join(scratchRoot, 'review-texts-wt');
    git(root, ['fetch', 'origin', 'main']);
    git(root, ['worktree', 'add', '-B', branch, wt, 'origin/main']);
    worktrees.reviewTexts = { root, path: wt };
    fs.symlinkSync(wt, path.join(dataDir, 'review-texts'));
  } else {
    throw new Error(`buildDataWorkdir: unknown repoKey "${repoKey}"`);
  }

  return { scratchRoot, dataDir, worktrees };
}

// Best-effort teardown — a leftover worktree/scratch dir is a disk-hygiene
// issue, never a correctness one, so failures here are swallowed (mirrors
// autonomous-run.js's existing `catch { /* leave for manual GC */ }` pattern
// for its own web-repo worktrees).
function removeDataWorkdir({ scratchRoot, worktrees }) {
  for (const key of Object.keys(worktrees || {})) {
    const w = worktrees[key];
    try { git(w.root, ['worktree', 'remove', '--force', w.path]); } catch { /* leave for manual GC */ }
  }
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Push the worktree's branch to the private repo's origin. Never main — the
// branch name itself enforces that (autonomous branches live under auto/*).
function pushDataBranch(worktreePath, branch) {
  git(worktreePath, ['push', '-u', 'origin', branch]);
}

// buildDataWorkdir() only ever populates ONE of worktrees.scorecardData /
// worktrees.reviewTexts per call (one repoKey per card) — this picks
// whichever is present so callers don't need to branch on repoKey again.
function primaryWorktree(wd) {
  return wd.worktrees.scorecardData || wd.worktrees.reviewTexts || null;
}

// Show ids touched by a review-texts diff, derived from path shape alone
// (top-level dir = showId; _pending/<showId>/... one level deeper) — used to
// target verify-review-recovery.js per show without trusting card text.
function showIdsFromReviewTextsDiff(files) {
  const ids = new Set();
  for (const raw of files || []) {
    const parts = String(raw).split('/');
    if (parts[0] === '_pending') { if (parts[1]) ids.add(parts[1]); }
    else if (parts[0]) ids.add(parts[0]);
  }
  return [...ids];
}

module.exports = {
  scorecardDataRoot,
  reviewTextsRoot,
  buildDataWorkdir,
  removeDataWorkdir,
  pushDataBranch,
  showIdsFromReviewTextsDiff,
  primaryWorktree,
};
