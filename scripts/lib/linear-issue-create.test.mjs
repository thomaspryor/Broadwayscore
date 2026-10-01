// Tests scripts/lib/linear-issue-create.js's pure state-selection and
// usage-limit-detection logic, plus the module's dispatch-gate wiring — no
// live Linear API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createLinearIssue, pickStateForMode, isUsageLimitExceeded } = require('./linear-issue-create.js');

const STATES = [
  { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
  { id: 'todo-1', name: 'Todo', type: 'unstarted' },
  { id: 'progress-1', name: 'In Progress', type: 'started' },
  { id: 'done-1', name: 'Done', type: 'completed' },
];

test('pickStateForMode park: picks the backlog-type state', () => {
  const state = pickStateForMode(STATES, 'park');
  assert.equal(state.type, 'backlog');
});

test('pickStateForMode park: falls back to unstarted when no backlog state exists', () => {
  const noBacklog = STATES.filter((s) => s.type !== 'backlog');
  const state = pickStateForMode(noBacklog, 'park');
  assert.equal(state.type, 'unstarted');
});

test('pickStateForMode park: throws a clear error when neither backlog nor unstarted exists', () => {
  const onlyStarted = STATES.filter((s) => s.type === 'started' || s.type === 'completed');
  assert.throws(() => pickStateForMode(onlyStarted, 'park'), /backlog.*unstarted/);
});

test("pickStateForMode dispatch: picks the unstarted-type state, never 'started'", () => {
  const state = pickStateForMode(STATES, 'dispatch');
  assert.equal(state.type, 'unstarted');
});

test('pickStateForMode dispatch: throws when no unstarted state exists', () => {
  const noUnstarted = STATES.filter((s) => s.type !== 'unstarted');
  assert.throws(() => pickStateForMode(noUnstarted, 'dispatch'), /unstarted/);
});

test('isUsageLimitExceeded: true when linearErrors carries the extensions.code', () => {
  const err = new Error('Linear GraphQL error: nope');
  err.linearErrors = [{ message: 'nope', extensions: { code: 'USAGE_LIMIT_EXCEEDED' } }];
  assert.equal(isUsageLimitExceeded(err), true);
});

test('isUsageLimitExceeded: true when only the message text carries it', () => {
  const err = new Error('Linear GraphQL error: USAGE_LIMIT_EXCEEDED — issue cap reached');
  assert.equal(isUsageLimitExceeded(err), true);
});

test('isUsageLimitExceeded: false for an unrelated error', () => {
  const err = new Error('Linear GraphQL error: Team BRO not found');
  assert.equal(isUsageLimitExceeded(err), false);
});

test('createLinearIssue: rejects with the disposition message when neither flag is given', async () => {
  await assert.rejects(
    () => createLinearIssue({ title: 'x', description: 'y' }),
    (err) => {
      assert.match(err.message, /--dispatch/);
      assert.match(err.message, /--park/);
      return true;
    }
  );
});

test('createLinearIssue: rejects immediately on bad disposition, never calls the Linear client', async () => {
  // No linear-client mocking needed here — a real getTeam() call would throw
  // on a missing LINEAR_API_KEY in this test environment, which would make a
  // false pass indistinguishable from disposition-gate-then-network-call.
  // Asserting the specific dispositionReason instead proves the gate ran
  // FIRST, before any client method was touched.
  try {
    await createLinearIssue({ title: 'x', description: 'y', dispatch: true, park: 'also set' });
    assert.fail('expected rejection');
  } catch (err) {
    assert.equal(err.dispositionReason, 'BOTH_FLAGS');
  }
});

// BRO-4487: a parked issue is never filed as Urgent/High. Nothing dispatches a
// PARKED: card, and CLAUDE.md requires P0/P1 to be dispatched at creation.
const { effectiveCreatePriority, PARKED_MAX_PRIORITY } = require('./linear-issue-create.js');

test('effectiveCreatePriority: parked High and Urgent are clamped to Medium', () => {
  assert.equal(PARKED_MAX_PRIORITY, 3);
  assert.deepEqual(effectiveCreatePriority({ priority: 2, mode: 'park', title: 'x' }), { priority: 3, clamped: true });
  assert.deepEqual(effectiveCreatePriority({ priority: 1, mode: 'park', title: 'x' }), { priority: 3, clamped: true });
  assert.deepEqual(effectiveCreatePriority({ priority: '2', mode: 'park', title: 'x' }), { priority: 3, clamped: true }, 'a numeric string is still High');
});

test('effectiveCreatePriority: dispatched issues keep the priority they asked for', () => {
  assert.deepEqual(effectiveCreatePriority({ priority: 1, mode: 'dispatch', title: 'P0: x' }), { priority: 1, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: 2, mode: 'dispatch', title: 'x' }), { priority: 2, clamped: false });
});

test('effectiveCreatePriority: an unset priority with a P0:/P1: title prefix is pinned to Medium when parked', () => {
  // priorityOf() reads the title when the field is unset, so leaving it unset
  // would let the prefix re-promote the card to P1.
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'park', title: 'P1: x' }), { priority: 3, clamped: true });
  assert.deepEqual(effectiveCreatePriority({ priority: 0, mode: 'park', title: 'P0: x' }), { priority: 3, clamped: true });
});

test('effectiveCreatePriority: parked Medium/Low and unranked untitled issues are left alone', () => {
  assert.deepEqual(effectiveCreatePriority({ priority: 3, mode: 'park', title: 'P1: x' }), { priority: 3, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: 4, mode: 'park', title: 'x' }), { priority: 4, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'park', title: 'x' }), { priority: undefined, clamped: false });
});

test('createLinearIssue: a parked High issue reaches the Linear client at Medium with a note', async () => {
  const fs = require('fs');
  const linearClient = require('./linear-client.js');
  const { LEDGER_PATH } = require('./intake-breaker.js');
  const ledgerBefore = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH) : null;
  const realGetTeam = linearClient.getTeam;
  linearClient.getTeam = async () => ({ id: 'team-1', states: { nodes: STATES } });
  let sent = null;
  try {
    const client = { createIssue: async (input) => { sent = input; return { identifier: 'BRO-0', id: 'i' }; } };
    await createLinearIssue({ title: 'Alert: x', description: 'body', park: 'auto-filed parked for triage', priority: 2, client });
  } finally {
    linearClient.getTeam = realGetTeam;
    // recordCreated() appends to the real intake ledger; never leave a test row behind (BRO-2656).
    if (ledgerBefore === null) { try { fs.unlinkSync(LEDGER_PATH); } catch { /* absent */ } }
    else fs.writeFileSync(LEDGER_PATH, ledgerBefore);
  }
  assert.equal(sent.priority, 3);
  assert.equal(sent.stateId, 'backlog-1');
  assert.match(sent.description, /^PARKED: /);
  assert.match(sent.description, /filed at Medium because it is parked/);
});
