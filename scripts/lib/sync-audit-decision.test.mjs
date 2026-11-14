/**
 * BRO-3441 — which dirty paths may sync-audit-checkout.sh's union recovery
 * touch? unionLedgerCandidates() is the single decision; these cases pin it,
 * and pin how its output steers classifyBlock().
 *
 * The intermittent "refuse / diverged" with a tracked merge=union ledger in
 * the blocking set traced to a ledger missing from the worktree: the old
 * shell loop accepted it (tracked + *.jsonl + union), commit-and-rebase
 * committed its deletion, the rebase aborted on modify/delete, and the
 * stranded deletion commit left every later tick refusing. A ledger that is
 * not on disk is now never a union candidate, so the run refuses before
 * anything is committed. The end-to-end case lives in
 * sync-audit-checkout.test.mjs ("BRO-3441: a ledger MISSING ...").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  unionLedgerCandidates, recoveryPushAllowed, classifyBlock,
  ACTION_REFUSE, ACTION_COMMIT_AND_REBASE, ACTION_UNION_RECOVER, REASON_DIVERGED,
} = require('./sync-audit-decision.js');

const LEDGER = 'data/audit/stage-latency.jsonl';
const ok = { path: LEDGER, tracked: true, inWorktree: true, mergeAttr: 'union' };

test('a tracked, on-disk, merge=union *.jsonl ledger qualifies', () => {
  assert.deepEqual(unionLedgerCandidates([ok]), [LEDGER]);
});

test('each missing fact disqualifies the path', () => {
  assert.deepEqual(unionLedgerCandidates([{ ...ok, tracked: false }]), [], 'untracked: nothing to restore');
  assert.deepEqual(unionLedgerCandidates([{ ...ok, inWorktree: false }]), [], 'missing on disk: pending deletion (BRO-3441)');
  assert.deepEqual(unionLedgerCandidates([{ ...ok, mergeAttr: 'unspecified' }]), [], 'no union attribute');
  assert.deepEqual(unionLedgerCandidates([{ ...ok, path: 'tests/unit-test-manifest.txt' }]), [], 'union but not *.jsonl');
});

test('bad input is ignored, order is kept', () => {
  const second = { ...ok, path: 'data/audit/scraper-spend-ledger.jsonl' };
  assert.deepEqual(unionLedgerCandidates([null, { path: '' }, second, ok]), [second.path, LEDGER]);
  assert.deepEqual(unionLedgerCandidates(undefined), []);
  assert.deepEqual(unionLedgerCandidates('nope'), []);
});

test('BRO-3441: diverged + ledger missing from the worktree refuses instead of commit-and-rebase', () => {
  const gone = { ...ok, inWorktree: false };
  const d = classifyBlock({
    blockingPaths: [LEDGER], aheadCount: 1, behindCount: 1,
    unionMergePaths: unionLedgerCandidates([gone]),
  });
  assert.equal(d.action, ACTION_REFUSE);
  assert.equal(d.reason, REASON_DIVERGED);
});

test('diverged + ledger present still routes to commit-and-rebase', () => {
  const d = classifyBlock({
    blockingPaths: [LEDGER], aheadCount: 1, behindCount: 1,
    unionMergePaths: unionLedgerCandidates([ok]),
  });
  assert.equal(d.action, ACTION_COMMIT_AND_REBASE);
});

test('not ahead + ledger present routes to union-recover; missing refuses', () => {
  assert.equal(classifyBlock({ blockingPaths: [LEDGER], unionMergePaths: unionLedgerCandidates([ok]) }).action, ACTION_UNION_RECOVER);
  assert.equal(
    classifyBlock({ blockingPaths: [LEDGER], unionMergePaths: unionLedgerCandidates([{ ...ok, inWorktree: false }]) }).action,
    ACTION_REFUSE,
  );
});

test('BRO-3405 recoveryPushAllowed: only ledger-only commits are pushed', () => {
  const ledger = { path: LEDGER, mergeAttr: 'union' };
  assert.equal(recoveryPushAllowed({ commitCount: 1, touched: [ledger] }), true);
  assert.equal(recoveryPushAllowed({ commitCount: 2, touched: [ledger, { path: 'src/app/page.tsx', mergeAttr: 'unspecified' }] }), false);
  assert.equal(recoveryPushAllowed({ commitCount: 1, touched: [{ path: 'data/audit/x.jsonl', mergeAttr: 'unspecified' }] }), false, 'not union');
  assert.equal(recoveryPushAllowed({ commitCount: 1, touched: [{ path: 'tests/unit-test-manifest.txt', mergeAttr: 'union' }] }), false, 'union but not jsonl');
  assert.equal(recoveryPushAllowed({ commitCount: 0, touched: [ledger] }), false, 'nothing ahead');
  assert.equal(recoveryPushAllowed({ commitCount: 1, touched: [] }), false, 'empty commit is not a ledger commit');
  assert.equal(recoveryPushAllowed(), false);
});
