import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateWorktreeEntry,
  evaluateCiRedClaim,
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

test('evaluateCiRedClaim: no in_progress task names the symbol — allow', () => {
  const tasks = [
    { id: 1, status: 'completed', subject: 'Fix shouldShowSentiment ReferenceError', description: '' },
    { id: 2, status: 'pending', subject: 'Some unrelated task', description: '' },
  ];
  const v = evaluateCiRedClaim({ symbol: 'shouldShowSentiment' }, tasks);
  assert.equal(v.allow, true);
});

test('evaluateCiRedClaim: CI red already claimed by another in_progress task — refuse', () => {
  const tasks = [
    { id: 563, status: 'in_progress', subject: "Fix main CI red: shouldShowSentiment ReferenceError + help-flag audit FP", description: '' },
  ];
  const v = evaluateCiRedClaim({ symbol: 'shouldShowSentiment' }, tasks);
  assert.equal(v.allow, false);
  assert.match(v.reason, /#563/);
  assert.equal(v.claimedBy.id, 563);
});

test('evaluateCiRedClaim: matches on runId too', () => {
  const tasks = [
    { id: 9, status: 'in_progress', subject: 'Fix flake in CI run 30120249897', description: '' },
  ];
  const v = evaluateCiRedClaim({ runId: '30120249897' }, tasks);
  assert.equal(v.allow, false);
});

test('evaluateCiRedClaim: no target given — allow', () => {
  const v = evaluateCiRedClaim(null, []);
  assert.equal(v.allow, true);
});

test('checkDuplicateDispatch: composes both checks — clean worktree + unclaimed CI red allows', () => {
  const v = checkDuplicateDispatch({
    worktreeState: { name: 'foo', exists: true, locked: false, dirty: false },
    ciRedTarget: { symbol: 'someSymbol' },
    existingClaims: [],
  });
  assert.equal(v.allow, true);
});

test('checkDuplicateDispatch: dirty worktree refuses even with no CI-red target', () => {
  const v = checkDuplicateDispatch({ worktreeState: { name: 'foo', exists: true, locked: false, dirty: true } });
  assert.equal(v.allow, false);
});

test('checkDuplicateDispatch: clean worktree but claimed CI red still refuses', () => {
  const v = checkDuplicateDispatch({
    worktreeState: { name: 'foo', exists: true, locked: false, dirty: false },
    ciRedTarget: { symbol: 'shouldShowSentiment' },
    existingClaims: [{ id: 563, status: 'in_progress', subject: 'Fix shouldShowSentiment ReferenceError', description: '' }],
  });
  assert.equal(v.allow, false);
  assert.match(v.reason, /#563/);
});

test('checkDuplicateDispatch: nothing passed — allow (no collision to detect)', () => {
  const v = checkDuplicateDispatch({});
  assert.equal(v.allow, true);
});
