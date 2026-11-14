import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyLandedButOpen, lastLedgerEventForTask, ACCEPTED_TERMINAL_EVENTS } = require('./landed-but-open-reconciler.js');

const BASE_PASS = {
  hasMergeCommit: true,
  mergeCommit: 'abc123',
  liveDispatch: false,
  liveLease: false,
  crossMachineDispatch: false,
  acceptanceStatus: 'pass',
};

test('classifyLandedButOpen: job-done is closable when every other gate holds (unchanged baseline)', () => {
  const r = classifyLandedButOpen({ ...BASE_PASS, lastLedgerEvent: 'job-done' });
  assert.equal(r.closable, true);
});

// BRO-3052: linear:BRO-2817's shape — the work merged and the acceptance
// re-check passes, but the process was killed in the gap between finishing
// and appending its own job-done row, so the ledger's last word was
// job-orphaned instead. Gates 1/2/4 already independently prove it's safe.
test('classifyLandedButOpen: job-orphaned is now also closable when every other gate holds (BRO-3052)', () => {
  const r = classifyLandedButOpen({ ...BASE_PASS, lastLedgerEvent: 'job-orphaned' });
  assert.equal(r.closable, true);
  assert.ok(r.reasons.some((s) => s.includes('job-orphaned')));
});

// BRO-516 regression guard (this file's own header counterexample): a stale
// look-alike merge commit next to a genuine job-failed must never pass.
test('classifyLandedButOpen: job-failed is still rejected even with a merge commit and passing acceptance', () => {
  const r = classifyLandedButOpen({ ...BASE_PASS, lastLedgerEvent: 'job-failed' });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /not one of/.test(s)));
});

test('classifyLandedButOpen: job-abandoned and dead stay rejected too', () => {
  for (const ev of ['job-abandoned', 'dead', null]) {
    const r = classifyLandedButOpen({ ...BASE_PASS, lastLedgerEvent: ev });
    assert.equal(r.closable, false, `${ev} must not satisfy gate 3`);
  }
});

// BRO-80 shape: a merge commit exists AND a live dispatch is running right
// now — gate 2 must still block closing in-flight work even for job-orphaned.
test('classifyLandedButOpen: a live dispatch blocks closing even when the last ledger event is job-orphaned', () => {
  const r = classifyLandedButOpen({ ...BASE_PASS, lastLedgerEvent: 'job-orphaned', liveDispatch: true });
  assert.equal(r.closable, false);
  assert.ok(r.reasons.some((s) => /live \(non-dead, non-finished\)/.test(s)));
});

test('ACCEPTED_TERMINAL_EVENTS is exactly {job-done, job-orphaned}', () => {
  assert.deepEqual([...ACCEPTED_TERMINAL_EVENTS].sort(), ['job-done', 'job-orphaned']);
});

test('lastLedgerEventForTask: last entry by file order, ignores other taskIds', () => {
  const entries = [
    { taskId: '1', event: 'launch' },
    { taskId: '2', event: 'job-done' },
    { taskId: '1', event: 'job-orphaned' },
  ];
  assert.equal(lastLedgerEventForTask('1', entries), 'job-orphaned');
  assert.equal(lastLedgerEventForTask('3', entries), null);
});
