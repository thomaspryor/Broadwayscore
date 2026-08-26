'use strict';
/**
 * Pure decision functions for worktree GC + dispatch disk-pressure (BRO-2319).
 *
 * Extracted per CLAUDE.md rule 15 so scripts/gc-merged-worktrees.sh (bash)
 * and scripts/lib/bsc-runner.js (dispatch) share ONE tested source of truth
 * instead of each re-implementing the same "is this safe" logic inline.
 * No I/O here — callers gather the booleans/numbers from git/lsof/lease
 * files/df and pass them in, which is what makes this requireable in a
 * plain node:test file with zero fixtures.
 */

/**
 * Decide whether a worktree is safe for `git worktree remove`.
 *
 * A live lease always wins: a job actively using this worktree must never
 * be pulled out from under it, even if its branch happens to already be an
 * ancestor of origin/main (e.g. a resumed session continuing to commit after
 * its first batch of work already landed).
 *
 * @param {object} d
 * @param {boolean} d.isAncestorOfMain  - every commit on the branch is already
 *   reachable from origin/main (fast-forward/plain-merge case; the squash
 *   case is handled upstream by `git cherry`, folded into hasUnmergedCommits).
 * @param {boolean} d.hasUnmergedCommits - branch has commits origin/main does
 *   not have (per `git cherry`), i.e. genuinely stranded work.
 * @param {boolean} d.hasLiveLease - a data/audit/job-leases/* lease with a
 *   live pid has this worktree's path as its cwd.
 * @returns {{removable: boolean, reason: string}}
 */
function decideWorktreeReclaim({ isAncestorOfMain, hasUnmergedCommits, hasLiveLease }) {
  if (hasLiveLease) {
    return { removable: false, reason: 'live-lease — a running job has this worktree as its cwd' };
  }
  if (isAncestorOfMain) {
    return { removable: true, reason: 'branch already an ancestor of origin/main' };
  }
  if (hasUnmergedCommits) {
    return { removable: false, reason: 'unmerged commits — possibly stranded work' };
  }
  return { removable: true, reason: 'no unmerged commits' };
}

/**
 * Decide whether new dispatch should be refused because disk is critically
 * low — the loud counterpart to the silent failure BRO-2319 documents
 * (lease/worktree/log writes that fail quietly under ENOSPC).
 *
 * @param {object} d
 * @param {number} d.freeGB - current free space on the worktree filesystem.
 * @param {number} d.floorGB - minimum free space required to dispatch.
 * @returns {boolean} true iff dispatch should be refused.
 */
function shouldRefuseDispatch({ freeGB, floorGB }) {
  return freeGB < floorGB;
}

/**
 * Given parsed job-lease records (data/audit/job-leases/*\/lease.json) and a
 * pid-liveness predicate, return the Set of `cwd` values that GC must treat
 * as live and never remove.
 *
 * A lease with pid === null/undefined is NOT the same as a dead pid — it
 * means the job is still being provisioned (acquireLease writes pid:null;
 * the real pid only lands once the subprocess actually spawns, via
 * onSpawn). A freshly-provisioned worktree in that window is exactly the
 * highest-risk moment for GC to race (clean, forked straight off
 * origin/main, so it reads as already-merged) — fail SAFE and count it as
 * live. Only a lease with a KNOWN, non-null pid is checked against
 * isAliveFn for staleness; a dead-pid lease (crashed holder) is correctly
 * NOT counted as live, matching bsc-runner.acquireLease's own "steal on
 * dead pid" reclaim semantics for that case.
 *
 * @param {Array<{cwd?: string, pid?: number|null}>} leases
 * @param {(pid: number|null|undefined) => boolean} isAliveFn
 * @returns {Set<string>}
 */
function computeLiveLeaseCwds(leases, isAliveFn) {
  const cwds = new Set();
  for (const lease of leases || []) {
    if (!lease || !lease.cwd) continue;
    if (lease.pid == null || isAliveFn(lease.pid)) cwds.add(lease.cwd);
  }
  return cwds;
}

module.exports = { decideWorktreeReclaim, shouldRefuseDispatch, computeLiveLeaseCwds };
