/**
 * BRO-2205: covers the two functions gc-worktree.js adds on top of the
 * already-tested decideWorktreeReclaim() (worktree-gc-reclaim.test.mjs) —
 * parsing `git worktree list --porcelain`, and honouring `git worktree
 * lock` ahead of the merge/lease verdict. Fixture below is a real capture
 * shape: the primary checkout (first entry — see parseWorktreeListPorcelain's
 * isPrimary docstring), one normal worktree, and one locked-but-clean
 * worktree (the exact "diary calendar Phase 0 picker work" hazard from the
 * original card's audit).
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

test('parseWorktreeListPorcelain: only the FIRST record is marked isPrimary, regardless of branch name', () => {
  const records = parseWorktreeListPorcelain(PORCELAIN_FIXTURE);
  assert.equal(records[0].isPrimary, true);
  assert.equal(records[1].isPrimary, false);
  assert.equal(records[2].isPrimary, false);
});

test('parseWorktreeListPorcelain: a detached-HEAD worktree has branch=null and detached=true', () => {
  const records = parseWorktreeListPorcelain('worktree /tmp/x\nHEAD abc123\ndetached\n');
  assert.equal(records[0].detached, true);
  assert.equal(records[0].branch, null);
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

test('triageWorktree: a bare worktree entry is never removable, even with fully-merged-looking signals', () => {
  // Adversarial review finding: bare/detached flags survive
  // parseWorktreeListPorcelain() but were originally dropped in triage,
  // so a bare admin record could read as a reclaimable checkout.
  const record = { path: '/x/.bare', branch: null, locked: false, lockedReason: '', bare: true };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false });
  assert.equal(result.removable, false);
  assert.match(result.reason, /bare/);
});

test('triageWorktree: the primary checkout is never removable, even with fully-merged-looking signals', () => {
  // Adversarial review finding: the main repo checkout has a normal branch
  // line (not bare), so it previously sailed through every guard and came
  // back removable:true — mirrors gc-merged-worktrees.sh's own
  // `[ "$path" = "$REPO" ]` special case.
  const record = { path: '/Users/tompryor/Broadwayscore', branch: 'refs/heads/main', locked: false, lockedReason: '', isPrimary: true };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false });
  assert.equal(result.removable, false);
  assert.match(result.reason, /primary checkout/);
});

test('triageWorktree: a detached-HEAD worktree is never removable regardless of signals', () => {
  const record = { path: '/x/detached-thing', branch: null, locked: false, lockedReason: '', detached: true };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false });
  assert.equal(result.removable, false);
  assert.match(result.reason, /detached/);
});

test('triageWorktree: missing/incomplete signals refuse removal rather than defaulting to removable', () => {
  // Adversarial review finding: signals defaults to {}, and undefined
  // booleans previously fell through decideWorktreeReclaim to
  // removable:true ("no unmerged commits") with zero real evidence.
  const record = { path: '/x/y', branch: 'refs/heads/y', locked: false, lockedReason: '' };
  const result = triageWorktree(record, {});
  assert.equal(result.removable, false);
  assert.match(result.reason, /incomplete/);
});

test('triageWorktree: a single missing boolean signal (e.g. lease scan errored) also refuses removal', () => {
  const record = { path: '/x/y', branch: 'refs/heads/y', locked: false, lockedReason: '' };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false });
  assert.equal(result.removable, false);
  assert.match(result.reason, /incomplete/);
});

test('triageWorktree: report-only fields (ageDays/sizeBytes/uncommittedCount) pass through untouched when absent', () => {
  const record = { path: '/x/y', branch: 'refs/heads/y', locked: false, lockedReason: '' };
  const result = triageWorktree(record, { isAncestorOfMain: true, hasUnmergedCommits: false, hasLiveLease: false });
  assert.equal(result.ageDays, undefined);
  assert.equal(result.sizeBytes, undefined);
  assert.equal(result.uncommittedCount, undefined);
});
