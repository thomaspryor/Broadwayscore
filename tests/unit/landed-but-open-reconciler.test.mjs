/**
 * Tests for scripts/lib/landed-but-open-reconciler.js (BRO-2558).
 *
 * The core invariant under test: merge-commit presence ALONE must never be
 * sufficient to classify a card closable. A card with a merge commit on main
 * but a live dispatch, or a failed/absent acceptance re-check, must classify
 * as still-open. Fixtures below reproduce the three real cards from the
 * 2026-08-31 pass (BRO-406 closable, BRO-80 and BRO-516 still-open).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyLandedButOpen, lastLedgerEventForTask, SUCCESS_LEDGER_EVENT } = require(
  path.join(__dirname, '..', '..', 'scripts', 'lib', 'landed-but-open-reconciler.js'),
);

// ---- no merge commit at all: never closable, regardless of everything else ----

test('no merge commit -> still open, even with a healthy ledger and passing acceptance', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: false,
    liveDispatch: false,
    liveLease: false,
    lastLedgerEvent: SUCCESS_LEDGER_EVENT,
    acceptanceStatus: 'pass',
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /no merge commit/.test(s)));
});

// ---- BRO-80 shape: merge commit + a LIVE dispatch right now ----

test('BRO-80 shape: merge commit present but a live dispatch is active -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: 'deadbeef',
    liveDispatch: true,
    liveLease: false,
    lastLedgerEvent: SUCCESS_LEDGER_EVENT, // even a stale prior success must not override a live worker
    acceptanceStatus: 'pass',
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /live \(non-dead, non-finished\) entry/.test(s)));
});

test('merge commit present but an unresolved dispatch comment shows a cross-machine (different-host) dispatch -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: 'deadbeef',
    liveDispatch: false, // this host's local ledger sees nothing live
    liveLease: false,
    crossMachineDispatch: true, // but the issue's own comment thread does
    lastLedgerEvent: SUCCESS_LEDGER_EVENT,
    acceptanceStatus: 'pass',
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /ANOTHER host/.test(s)));
});

test('merge commit present but a live job/worktree lease is held -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: 'deadbeef',
    liveDispatch: false,
    liveLease: true,
    lastLedgerEvent: SUCCESS_LEDGER_EVENT,
    acceptanceStatus: 'pass',
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /live job\/worktree lease/.test(s)));
});

// ---- BRO-516 shape: looks landed by title similarity, but its OWN evidence says otherwise ----

test('BRO-516 shape: last ledger event is job-failed, no live dispatch -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true, // the naive title-similarity sweep would have called this landed
    mergeCommit: 'cafef00d',
    liveDispatch: false,
    liveLease: false,
    lastLedgerEvent: 'job-failed',
    acceptanceStatus: 'unverifiable', // marker missing on disk
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /job-failed.*not.*job-done/.test(s)));
});

test('no dispatch-ledger entry at all for this taskId -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: 'cafef00d',
    liveDispatch: false,
    liveLease: false,
    lastLedgerEvent: null,
    acceptanceStatus: null,
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /"none", not "job-done"/.test(s)));
});

// ---- acceptance re-check must independently pass, even once the ledger looks clean ----

test('merge commit + job-done + no live dispatch but acceptance re-check FAILS -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: 'abc123',
    liveDispatch: false,
    liveLease: false,
    lastLedgerEvent: SUCCESS_LEDGER_EVENT,
    acceptanceStatus: 'fail',
  });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /did not pass \(status: fail\)/.test(s)));
});

test('merge commit + job-done + no live dispatch but acceptance re-check is UNVERIFIABLE -> still open, not closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: 'abc123',
    liveDispatch: false,
    liveLease: false,
    lastLedgerEvent: SUCCESS_LEDGER_EVENT,
    acceptanceStatus: 'unverifiable',
  });
  assert.equal(r.closable, false);
});

// ---- BRO-406 shape: the one card this session actually closed on exactly these three signals ----

test('BRO-406 shape: merge commit + no live dispatch + job-done + acceptance PASS -> closable', () => {
  const r = classifyLandedButOpen({
    hasMergeCommit: true,
    mergeCommit: '7387a67242b',
    liveDispatch: false,
    liveLease: false,
    lastLedgerEvent: SUCCESS_LEDGER_EVENT,
    acceptanceStatus: 'pass',
  });
  assert.equal(r.closable, true);
  assert.ok(r.reasons.some((s) => /re-verified passing/.test(s)));
});

// ---- lastLedgerEventForTask: pure fold helper ----

test('lastLedgerEventForTask returns the last matching entry in file order, ignoring other taskIds', () => {
  const entries = [
    { taskId: 'linear:BRO-1', event: 'launch' },
    { taskId: 'linear:BRO-406', event: 'launch' },
    { taskId: 'linear:BRO-1', event: 'job-done' },
    { taskId: 'linear:BRO-406', event: 'job-failed' },
    { taskId: 'linear:BRO-406', event: 'job-done' },
  ];
  assert.equal(lastLedgerEventForTask('linear:BRO-406', entries), 'job-done');
  assert.equal(lastLedgerEventForTask('linear:BRO-1', entries), 'job-done');
});

test('lastLedgerEventForTask returns null for a taskId with no entries', () => {
  assert.equal(lastLedgerEventForTask('linear:BRO-999', []), null);
  assert.equal(lastLedgerEventForTask('linear:BRO-999', [{ taskId: 'linear:BRO-1', event: 'job-done' }]), null);
});

test('lastLedgerEventForTask tolerates malformed rows without throwing', () => {
  const entries = [null, undefined, 42, 'not-an-object', { taskId: 'linear:BRO-406', event: 'job-done' }];
  assert.equal(lastLedgerEventForTask('linear:BRO-406', entries), 'job-done');
});
