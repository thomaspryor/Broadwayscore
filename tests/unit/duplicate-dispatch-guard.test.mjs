import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateWorktreeEntry,
  checkDuplicateDispatch,
} = require('../../scripts/lib/duplicate-dispatch-guard.js');

test('evaluateWorktreeEntry: no existing worktree — allow', () => {
  const v = evaluateWorktreeEntry(null);
  assert.equal(v.allow, true);
});

test('evaluateWorktreeEntry: same-name worktree clean+unlocked — allow', () => {
  const v = evaluateWorktreeEntry({ name: 'foo', exists: true, locked: false, dirty: false });
  assert.equal(v.allow, true);
  assert.match(v.reason, /clean and unlocked/);
});

test('evaluateWorktreeEntry: dirty worktree — refuse', () => {
  const v = evaluateWorktreeEntry({ name: 'foo', exists: true, locked: false, dirty: true });
  assert.equal(v.allow, false);
  assert.match(v.reason, /uncommitted changes/);
});

test('evaluateWorktreeEntry: locked worktree — refuse', () => {
  const v = evaluateWorktreeEntry({
    name: 'foo',
    exists: true,
    locked: true,
    lockReason: 'claude session foo (pid 123 start Mon Jul 27)',
    dirty: false,
  });
  assert.equal(v.allow, false);
  assert.match(v.reason, /locked/);
  assert.match(v.reason, /pid 123/);
});

test('evaluateWorktreeEntry: locked AND dirty — refuse with lock reason (locked checked first)', () => {
  const v = evaluateWorktreeEntry({ name: 'foo', exists: true, locked: true, lockReason: 'live session', dirty: true });
  assert.equal(v.allow, false);
  assert.match(v.reason, /locked/);
});

test('checkDuplicateDispatch: dirty worktree refuses even with no CI-red target', () => {
  const v = checkDuplicateDispatch({ worktreeState: { name: 'foo', exists: true, locked: false, dirty: true } });
  assert.equal(v.allow, false);
});

test('checkDuplicateDispatch: nothing passed — allow (no collision to detect)', () => {
  const v = checkDuplicateDispatch({});
  assert.equal(v.allow, true);
});
