'use strict';

/**
 * remote-branch-prune.js — pure decisions for BRO-2975.
 *
 * gc-merged-worktrees.sh only cleans local worktrees, so every worktree/job
 * branch pushed to origin stayed there forever (666 heads on 2026-09-08).
 * A remote branch is pruned only when losing it loses nothing:
 *   - its name starts with a known throwaway prefix (never main, land/**, release, etc.)
 *   - its tip is an ancestor of origin/main (the work is on main)
 *   - no open PR has it as head, and it is whose tip is older than MIN_AGE_DAYS
 * The script logs each deleted tip sha, so a delete is recoverable by pushing the sha back.
 */

const PRUNABLE_PREFIXES = ['worktree-', 'job/', 'claude/', 'bro-'];
const PROTECTED = new Set(['main', 'master', 'HEAD', 'gh-pages']);
// Tip age, not push age: a branch cut from main has a minutes-old tip, so 7 days also protects a fresh empty branch.
const MIN_AGE_DAYS = 7;
const MAX_DELETES_PER_RUN = 100;

const matchesPrefix = (branch) => PRUNABLE_PREFIXES.some((p) => branch.startsWith(p));

/**
 * @param {object} p
 * @param {string} p.branch  branch name without refs/heads/
 * @param {boolean} p.mergedIntoMain  tip is an ancestor of origin/main
 * @param {string|null} p.tipCommittedAt  ISO date of tip commit
 * @param {boolean} [p.openPr]
 * @param {boolean} [p.liveWorktree]  checked out in a live worktree elsewhere
 * @param {number} [p.now]
 * @returns {{ prune: boolean, reason: string }}
 */
function decideRemoteBranchPrune({ branch, mergedIntoMain, tipCommittedAt, openPr = false, liveWorktree = false, now = Date.now() } = {}) {
  const keep = (reason) => ({ prune: false, reason });
  if (!branch || PROTECTED.has(branch)) return keep('protected');
  if (!matchesPrefix(branch)) return keep('unknown-prefix');
  if (!mergedIntoMain) return keep('unmerged');
  if (openPr) return keep('open-pr');
  if (liveWorktree) return keep('live-worktree');
  if (!tipCommittedAt || Number.isNaN(Date.parse(tipCommittedAt))) return keep('tip-date-unreadable');
  if ((now - Date.parse(tipCommittedAt)) / 86400000 < MIN_AGE_DAYS) return keep('too-young');
  return { prune: true, reason: 'merged' };
}

module.exports = { decideRemoteBranchPrune, PRUNABLE_PREFIXES, MIN_AGE_DAYS, MAX_DELETES_PER_RUN };
