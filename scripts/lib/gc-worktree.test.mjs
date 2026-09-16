/**
 * BRO-2205: covers the two functions gc-worktree.js adds on top of the
 * already-tested decideWorktreeReclaim() (worktree-gc-reclaim.test.mjs) —
 * parsing `git worktree list --porcelain`, and honouring `git worktree
 * lock` ahead of the merge/lease verdict. Fixture below is a real capture
 * shape: one normal worktree, one locked-but-clean worktree (the exact
 * "diary calendar Phase 0 picker work" hazard from the original card's
 * audit), and the primary checkout (no `branch` line variant is not
 * exercised here since primary checkouts are never GC candidates).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreeListPorcelain, triageWorktree } from '../../scripts/lib/gc-worktree.js';

const PORCELAIN_FIXTURE = [
  'worktree /Users/tompryor/Broadwayscore',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /Users/tompryor/Broadwayscore/.claude/worktrees/job-linear-bro-1234',
  'HEAD def456',
  'branch refs/heads/job/linear-bro-1234',
  '',
  'worktree /Users/tompryor/Broadwayscore/.claude/worktrees/diary-phase0c',
  'HEAD 789abc',
  'branch refs/heads/diary-phase0c',
  'locked active session: diary calendar Phase 0 picker work',
  '',
].join('\n');

test('parseWorktreeListPorcelain: splits porcelain output into one record per worktree', () => {
  const records = parseWorktreeListPorcelain(PORCELAIN_FIXTURE);
  assert.equal(records.length, 3);
  assert.equal(records[0].path, '/Users/tompryor/Broadwayscore');
  assert.equal(records[0].branch, 'refs/heads/main');
  assert.equal(records[0].locked, false);
});

test('parseWorktreeListPorcelain: captures the lock reason text after "locked "', () => {
  const records = parseWorktreeListPorcelain(PORCELAIN_FIXTURE);
  const diary = records.find((r) => r.path.endsWith('diary-phase0c'));
  assert.equal(diary.locked, true);
  assert.equal(diary.lockedReason, 'active session: diary calendar Phase 0 picker work');
});

test('parseWorktreeListPorcelain: a bare "locked" line (no reason) still sets locked=true with empty reason', () => {
  const records = parseWorktreeListPorcelain('worktree /tmp/x\nbranch refs/heads/x\nlocked\n');
  assert.equal(records[0].locked, true);
  assert.equal(records[0].lockedReason, '');
});

test('parseWorktreeListPorcelain: empty/garbage input returns no records', () => {
  assert.deepEqual(parseWorktreeListPorcelain(''), []);
  assert.deepEqual(parseWorktreeListPorcelain('not porcelain output'), []);
});

test('triageWorktree: a locked worktree is never removable, even when fully merged and lease-free', () => {
  // The exact hazard the original card's audit caught: a clean, merged
  // worktree that is STILL an active session because it is git-locked.
  const record = { path: '/x/diary-phase0c', branch: 'refs/heads/diary-phase0c', locked: true, lockedReason: 'active session: diary calendar Phase 0 picker work' };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false });
  assert.equal(result.removable, false);
  assert.match(result.reason, /git-locked/);
  assert.match(result.reason, /diary calendar Phase 0 picker work/);
});

test('triageWorktree: an unlocked, fully-merged, lease-free worktree is removable', () => {
  const record = { path: '/x/job-linear-bro-1234', branch: 'refs/heads/job/linear-bro-1234', locked: false, lockedReason: '' };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false, ageDays: 12, sizeBytes: 780000000, uncommittedCount: 0 });
  assert.equal(result.removable, true);
  assert.equal(result.ageDays, 12);
  assert.equal(result.sizeBytes, 780000000);
});

test('triageWorktree: an unlocked worktree with genuine unmerged commits is not removable, regardless of age', () => {
  const record = { path: '/x/stale-but-real-work', branch: 'refs/heads/x', locked: false, lockedReason: '' };
  const result = triageWorktree(record, { isAncestorOfMain: false, hasUnmergedCommits: true, hasLiveLease: false, ageDays: 90 });
  assert.equal(result.removable, false);
  assert.match(result.reason, /unmerged/);
});

test('triageWorktree: an unlocked worktree with a live lease is not removable even if merged', () => {
  const record = { path: '/x/resumed-session', branch: 'refs/heads/x', locked: false, lockedReason: '' };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: true });
  assert.equal(result.removable, false);
  assert.match(result.reason, /live-lease/);
});

test('triageWorktree: report-only fields (ageDays/sizeBytes/uncommittedCount) pass through untouched when absent', () => {
  const record = { path: '/x/y', branch: 'refs/heads/y', locked: false, lockedReason: '' };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false });
  assert.equal(result.ageDays, undefined);
  assert.equal(result.sizeBytes, undefined);
  assert.equal(result.uncommittedCount, undefined);
});
