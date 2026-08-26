/**
 * BRO-2319: worktrees hit 84GB/99 dirs, disk free hit 4.7Gi, and GC froze at
 * freed=0KB because 82/99 worktrees read as "unmerged" (some genuinely, some
 * only because the old check wasn't authoritative against origin/main) while
 * dispatch had no disk-pressure guard at all — a launcher could print
 * "headless job starting" and leave no lease, no worktree, no job log behind
 * under ENOSPC, with nothing reporting the disk problem.
 *
 * Exercises the REAL decision functions from scripts/lib/worktree-gc-reclaim.js
 * (CLAUDE.md rule 15) — no reimplementation of the logic here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWorktreeReclaim,
  shouldRefuseDispatch,
  computeLiveLeaseCwds,
} from '../../scripts/lib/worktree-gc-reclaim.js';

test('decideWorktreeReclaim: branch already an ancestor of origin/main is removable', () => {
  const result = decideWorktreeReclaim({
    isAncestorOfMain: true,
    hasUnmergedCommits: false,
    hasLiveLease: false,
  });
  assert.equal(result.removable, true);
});

test('decideWorktreeReclaim: a branch with a live lease is NOT removable, even though it is already merged', () => {
  // The exact BRO-2319 hazard: a resumed job keeps committing to a worktree
  // whose earlier commits already landed in origin/main. Merged-ness alone
  // must never win over an active lease.
  const result = decideWorktreeReclaim({
    isAncestorOfMain: true,
    hasUnmergedCommits: false,
    hasLiveLease: true,
  });
  assert.equal(result.removable, false);
  assert.match(result.reason, /live-lease/);
});

test('decideWorktreeReclaim: a branch with genuine unmerged commits is NOT removable', () => {
  const result = decideWorktreeReclaim({
    isAncestorOfMain: false,
    hasUnmergedCommits: true,
    hasLiveLease: false,
  });
  assert.equal(result.removable, false);
  assert.match(result.reason, /unmerged/);
});

test('decideWorktreeReclaim: no unmerged commits and not a live lease is removable even when not a strict ancestor (e.g. rebased/equivalent)', () => {
  const result = decideWorktreeReclaim({
    isAncestorOfMain: false,
    hasUnmergedCommits: false,
    hasLiveLease: false,
  });
  assert.equal(result.removable, true);
});

test('shouldRefuseDispatch: free space below the floor refuses dispatch', () => {
  assert.equal(shouldRefuseDispatch({ freeGB: 3, floorGB: 5 }), true);
});

test('shouldRefuseDispatch: free space at or above the floor allows dispatch', () => {
  assert.equal(shouldRefuseDispatch({ freeGB: 5, floorGB: 5 }), false);
  assert.equal(shouldRefuseDispatch({ freeGB: 20, floorGB: 5 }), false);
});

test('computeLiveLeaseCwds: only includes leases whose pid is alive, per the injected predicate', () => {
  const leases = [
    { cwd: '/wt/live-job', pid: 111 },
    { cwd: '/wt/dead-job', pid: 222 },
    { cwd: '/wt/no-cwd', pid: 333 },
  ];
  delete leases[2].cwd;
  const isAliveFn = (pid) => pid === 111;
  const cwds = computeLiveLeaseCwds(leases, isAliveFn);
  assert.deepEqual([...cwds], ['/wt/live-job']);
});

test('computeLiveLeaseCwds: empty/undefined lease list yields an empty set', () => {
  assert.equal(computeLiveLeaseCwds(undefined, () => true).size, 0);
  assert.equal(computeLiveLeaseCwds([], () => true).size, 0);
});
