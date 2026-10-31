import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideRemoteBranchPrune } = require('./lib/remote-branch-prune.js');

const now = Date.parse('2026-10-29T00:00:00Z');
const old = '2026-10-01T00:00:00Z';
const base = { mergedIntoMain: true, tipCommittedAt: old, now };

test('prunes merged throwaway-prefix branches', () => {
  for (const branch of ['worktree-foo', 'job/abc', 'claude/x', 'bro-123-fix']) {
    assert.equal(decideRemoteBranchPrune({ ...base, branch }).prune, true, branch);
  }
});

test('never prunes protected, unknown-prefix or land/** branches', () => {
  for (const branch of ['main', 'land/foo', 'release/1', 'feature/x', 'fix/y', 'wip/z']) {
    assert.equal(decideRemoteBranchPrune({ ...base, branch }).prune, false, branch);
  }
});

test('keeps unmerged, open-PR, live-worktree, young and undated branches', () => {
  const b = { ...base, branch: 'worktree-foo' };
  assert.equal(decideRemoteBranchPrune({ ...b, mergedIntoMain: false }).reason, 'unmerged');
  assert.equal(decideRemoteBranchPrune({ ...b, openPr: true }).reason, 'open-pr');
  assert.equal(decideRemoteBranchPrune({ ...b, liveWorktree: true }).reason, 'live-worktree');
  assert.equal(decideRemoteBranchPrune({ ...b, tipCommittedAt: '2026-10-25T12:00:00Z' }).reason, 'too-young');
  assert.equal(decideRemoteBranchPrune({ ...b, tipCommittedAt: null }).reason, 'tip-date-unreadable');
});
