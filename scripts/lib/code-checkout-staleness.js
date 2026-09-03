/**
 * code-checkout-staleness — warns when the CODE checkout itself (not a data
 * clone) is behind origin/main (BRO-2663).
 *
 * 2026-08-31 incident: a crown session read scripts/audit-regex-patterns.test.mjs
 * from the shared main ~/Broadwayscore checkout, 18 commits behind origin/main,
 * found 0 "opera" mentions where a landed commit (dd7ba875198, confirmed on
 * origin/main) had added 5 opera tests, and nearly concluded a correct worker
 * had reverted its own tests. `git merge --ff-only origin/main` fixed it. The
 * crown loop's own "am I ahead" check (`git rev-list --count
 * origin/main..HEAD`) reads 0 in both the current-checkout AND the
 * arbitrarily-behind case — it structurally cannot catch this; the missing
 * direction is `HEAD..origin/main`. session-start.sh already warns for two
 * staleness classes (data/review-texts, the core-data clone) but never for
 * the code repo itself. This closes that gap.
 *
 * Scope: the shared MAIN checkout only. A worktree branch is ahead of
 * origin/main by definition (its own commits) — the caller (session-start.sh)
 * skips this check inside a worktree, the same way the existing "WORKTREE
 * REMINDER" block does (`[[ "$PWD" != *"/.claude/worktrees/"* ]]`). This file
 * has no opinion on that; it just answers "how far behind/ahead is this
 * directory" (second-opinion review, BRO-2663 plan review).
 */
'use strict';

const { execFileSync } = require('child_process');

// Matches the CORE-DATA block's perl-alarm timeout (session-start.sh) — a
// network hang here must not block every session start indefinitely.
const FETCH_TIMEOUT_MS = 5000;

/**
 * Best-effort update of the local origin/main tracking ref. Fail-open: a
 * network hiccup or missing remote must not block session start — a stale
 * cached ref (whatever was last fetched) is strictly better than hanging.
 */
function fetchOriginMain(repoDir, execFn = execFileSync) {
  try {
    execFn('git', ['-C', repoDir, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '-q'], {
      timeout: FETCH_TIMEOUT_MS,
      stdio: 'ignore',
    });
  } catch { /* fail-open */ }
}

/**
 * How far HEAD is behind/ahead of remoteRef. 0 on any failure (detached HEAD,
 * remote-ref never fetched, not a git repo, etc.) — fail-open, matching
 * fetchOriginMain.
 */
function getBehindAheadCounts(repoDir, remoteRef = 'refs/remotes/origin/main', execFn = execFileSync) {
  const count = (range) => {
    try {
      return Number(execFn('git', ['-C', repoDir, 'rev-list', '--count', range], { encoding: 'utf8' }).trim()) || 0;
    } catch {
      return 0;
    }
  };
  return {
    behind: count(`HEAD..${remoteRef}`),
    ahead: count(`${remoteRef}..HEAD`),
  };
}

/**
 * Pure — no fs/git. Behind-only is the incident's shape: the shared main
 * checkout drifted with nothing local to lose, so ff-only is always safe.
 */
function formatCodeCheckoutStaleMessage({ behind, ahead }, repoDir) {
  if (behind > 0 && ahead === 0) {
    return [
      `🔶 STALE CODE CHECKOUT: ${repoDir} is ${behind} commit(s) behind origin/main.`,
      `   Reading ANY file here (tests, scripts, CLAUDE.md) can produce a WRONG CONCLUSION —`,
      `   a checkout 18 commits behind once read a landed commit's 5 new tests as reverted (BRO-2663).`,
      `   Bring it current before trusting anything you read:`,
      `     git merge --ff-only origin/main`,
      `   If that's BLOCKED ("commit your changes or stash them before you merge"), it's almost`,
      `   always modified tracked telemetry under data/audit/ on the shared main checkout — commit`,
      `   it first (data: audit telemetry update [skip ci]), THEN merge. Do NOT \`git stash\` on the`,
      `   shared main checkout — it's shared with every other session on this machine.`,
    ].join('\n');
  }
  if (behind > 0 && ahead > 0) {
    return [
      `🚨 CODE CHECKOUT DIVERGED: ${repoDir} is ${behind} behind AND ${ahead} ahead of origin/main.`,
      `   Conclusions drawn from this checkout may be stale AND carry unmerged local commits.`,
      `   Reconcile before trusting anything you read:`,
      `     git merge origin/main`,
    ].join('\n');
  }
  return null;
}

/** Convenience wrapper: fetches (unless skipFetch), counts, formats. */
function runCodeCheckoutStalenessCheck({ repoDir, execFn = execFileSync, skipFetch = false } = {}) {
  if (!skipFetch) fetchOriginMain(repoDir, execFn);
  const { behind, ahead } = getBehindAheadCounts(repoDir, 'refs/remotes/origin/main', execFn);
  return { behind, ahead, message: formatCodeCheckoutStaleMessage({ behind, ahead }, repoDir) };
}

module.exports = {
  FETCH_TIMEOUT_MS,
  fetchOriginMain,
  getBehindAheadCounts,
  formatCodeCheckoutStaleMessage,
  runCodeCheckoutStalenessCheck,
};
