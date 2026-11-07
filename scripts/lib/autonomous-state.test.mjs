import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { STATES, EVENTS, TRANSITIONS, transition, isTerminal } = require('./autonomous-state.js');

const disp = (s) => (s === '' ? '(empty)' : s);

test('every enumerated valid transition lands on its target state', () => {
  for (const [event, rule] of Object.entries(TRANSITIONS)) {
    const froms = Array.isArray(rule.from) ? rule.from : [rule.from];
    for (const from of froms) {
      const opts = rule.reasonRequired && !rule.autoReason ? { reason: 'test-reason' } : {};
      const result = transition(from, event, opts);
      assert.equal(result.next, rule.to, `${disp(from)} + ${event} should → ${rule.to}`);
      assert.ok(!result.noop, `${disp(from)} + ${event} is a real transition, not a noop`);
      if (rule.autoReason) {
        assert.equal(result.reason, rule.autoReason, `${event} carries auto-reason`);
      } else if (opts.reason) {
        assert.equal(result.reason, opts.reason, `${event} passes provided reason through`);
      } else {
        assert.equal(result.reason, null, `${event} has null reason when none provided`);
      }
    }
  }
});

test('exports are consistent: EVENTS matches TRANSITIONS keys, all endpoints are known STATES', () => {
  assert.deepEqual(EVENTS, Object.keys(TRANSITIONS));
  for (const rule of Object.values(TRANSITIONS)) {
    const froms = Array.isArray(rule.from) ? rule.from : [rule.from];
    for (const from of froms) assert.ok(STATES.includes(from), `from ${disp(from)} is a known state`);
    assert.ok(STATES.includes(rule.to), `to ${rule.to} is a known state`);
  }
});

// --- The 4 wedge cases ---

test('wedge a: approve-then-branch-GC — merge.stale-branch fails with auto-reason stale-approval', () => {
  const result = transition('approved', 'merge.stale-branch');
  assert.equal(result.next, 'failed');
  assert.equal(result.reason, 'stale-approval');
});

test('wedge b: reject beats a standing approval — tap.reject on approved → rejected', () => {
  const result = transition('approved', 'tap.reject');
  assert.equal(result.next, 'rejected');
});

test('wedge c: merge.reverify-fail strips the approval — no merge without a fresh tap', () => {
  const result = transition('approved', 'merge.reverify-fail');
  assert.equal(result.next, 'needs-approval');
  // The approval is gone: merge.success from needs-approval must THROW.
  assert.throws(
    () => transition('needs-approval', 'merge.success'),
    /invalid transition: needs-approval \+ merge\.success/
  );
  // Recovery path: a fresh tap re-approves, then merge succeeds.
  assert.equal(transition('needs-approval', 'tap.approve').next, 'approved');
  assert.equal(transition('approved', 'merge.success').next, 'merged');
});

test('wedge d: double-merge oscillation — merge.oscillation fails with auto-reason oscillation', () => {
  const result = transition('approved', 'merge.oscillation');
  assert.equal(result.next, 'failed');
  assert.equal(result.reason, 'oscillation');
});

test('wedge e (Sprint 3): deterministic-green diff skips the tap — run.auto-approve is attempted→approved with a mechanical reason', () => {
  const result = transition('attempted', 'run.auto-approve');
  assert.equal(result.next, 'approved');
  assert.equal(result.reason, 'deterministic-green');
  // From there, the SAME merge path runs as a human-tapped approval — no
  // separate merge event for the auto-approved case.
  assert.equal(transition('approved', 'merge.success').next, 'merged');
});

test('wedge f (Sprint 3): revert only legal from merged — tap.revert', () => {
  const result = transition('merged', 'tap.revert');
  assert.equal(result.next, 'reverted');
  for (const from of ['needs-approval', 'approved', 'rejected', 'failed', 'queued', 'attempted', '']) {
    assert.throws(() => transition(from, 'tap.revert'), (err) => err.message === `invalid transition: ${disp(from)} + tap.revert`);
  }
});

// --- Idempotent replays ---

test('idempotent replays return noop:true and keep the state', () => {
  const replays = [
    ['approved', 'tap.approve'],
    ['rejected', 'tap.reject'],
    ['merged', 'merge.success'],
  ];
  for (const [state, event] of replays) {
    const result = transition(state, event);
    assert.equal(result.next, state, `${state} + ${event} keeps state`);
    assert.equal(result.noop, true, `${state} + ${event} is a noop`);
  }
});

// --- Invalid transitions throw ---

test('invalid transitions throw with an explicit message — never a silent no-op', () => {
  assert.throws(() => transition('', 'run.claim'), /invalid transition: \(empty\) \+ run\.claim/);
  assert.throws(() => transition('queued', 'tap.approve'), /invalid transition: queued \+ tap\.approve/);
  assert.throws(
    () => transition('needs-approval', 'merge.success'),
    /invalid transition: needs-approval \+ merge\.success/
  );
  assert.throws(() => transition('merged', 'run.pass'), /invalid transition: merged \+ run\.pass/);
  assert.throws(() => transition('failed', 'run.claim'), /invalid transition: failed \+ run\.claim/);
  assert.throws(() => transition('split-proposed', 'run.claim'), /invalid transition: split-proposed \+ run\.claim/);
});

test('unknown event throws', () => {
  assert.throws(() => transition('queued', 'not.an.event'), /unknown event: not\.an\.event/);
});

test('unknown state throws', () => {
  assert.throws(() => transition('bogus-state', 'run.claim'), /unknown state: bogus-state/);
});

// --- Reason-required events ---

test('reason-required events throw without a reason', () => {
  assert.throws(() => transition('', 'triage.fail'), /reason required for triage\.fail/);
  assert.throws(() => transition('attempted', 'run.fail'), /reason required for run\.fail/);
});

test('reason-required events pass the provided reason through', () => {
  assert.deepEqual(transition('', 'triage.fail', { reason: 'triage' }), { next: 'failed', reason: 'triage' });
  assert.deepEqual(transition('attempted', 'run.fail', { reason: 'budget' }), { next: 'failed', reason: 'budget' });
});

test('auto-reason events never throw for a missing reason, and an explicit reason wins', () => {
  assert.equal(transition('approved', 'merge.stale-branch').reason, 'stale-approval');
  assert.equal(transition('approved', 'merge.oscillation').reason, 'oscillation');
  assert.equal(transition('approved', 'merge.stale-branch', { reason: 'branch deleted by GC' }).reason, 'branch deleted by GC');
});

// --- isTerminal truth table ---

test('isTerminal truth table', () => {
  const expected = {
    '': false,
    queued: false,
    attempted: false,
    'needs-approval': false,
    approved: false,
    merged: true,
    rejected: true,
    failed: true,
    'split-proposed': false,
    reverted: true,
  };
  for (const state of STATES) {
    assert.equal(isTerminal(state), expected[state], `isTerminal(${disp(state)})`);
  }
});
