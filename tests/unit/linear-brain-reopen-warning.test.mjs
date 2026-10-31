// Tests scripts/linear-brain.js's `update --state <non-terminal>` path when
// the issue's CURRENT state is Done/Canceled (BRO-3869 cousin fix):
// `linear-session.js claim` already warns automatically on this exact shape
// (reopening a concluded card — the incident that filed BRO-3869), but
// `update --state` is this repo's other, more general path that can move an
// issue OUT of a terminal state and had no equivalent warning. Non-blocking:
// the write still proceeds, matching the done-gate's own precedent above it
// in the same function.
//
// Driven end-to-end IN A REAL SUBPROCESS — same rationale and fixture shape
// as linear-brain-done-gate.test.mjs (a throwing process.exit stub would be
// masked by the surrounding try/catch's own process.exit(2)).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEAM_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
  { id: 'state-duplicate', name: 'Duplicate', type: 'duplicate' },
];

function makeIssue({ state, comments = [], relations = { nodes: [] } }) {
  return {
    id: 'issue-uuid-cousin',
    identifier: 'BRO-9459',
    title: 'Fixture issue for the reopen-warning cousin fix',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-9459/fixture',
    description: 'n/a',
    state,
    comments: { nodes: comments },
    relations,
  };
}

function runUpdate({ argv, state, comments = [], relations }) {
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue({ state, comments, relations }))};
    main(${JSON.stringify(argv)}, {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      createComment: async () => { console.error('CREATE_COMMENT_CALLED'); },
      createIssueRelation: async () => { throw new Error('createIssueRelation must not be called in these fixtures'); },
    });
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
}

test('update: reopening a Done issue warns with its NEWEST comments, in real newest-first API order, before the write', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9459', '--state', 'In Progress'],
    state: { id: 'state-done', name: 'Done', type: 'completed' },
    // Deliberately newest-first, matching the live BRO-3456 order this fix
    // is guarding against (see linear-staleness-check.js's newestComments).
    comments: [
      { id: 'c2', body: 'SHIPPED — do not revert this.', createdAt: '2026-09-16T16:57:00.000Z', user: { name: 'Bob' } },
      { id: 'c1', body: 'earliest, stale investigation note', createdAt: '2026-09-15T21:24:00.000Z', user: { name: 'Bob' } },
    ],
  });
  assert.equal(res.status, 0, `expected success, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /was "Done" \(a concluded state\) — you're reopening it/);
  assert.match(res.stderr, /SHIPPED — do not revert this/);
  // The write still proceeds — this is a warning, never a block.
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('update: reopening a Canceled issue also warns (not just Done)', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9459', '--state', 'Todo'],
    state: { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
  });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /was "Canceled" \(a concluded state\)/);
});

test('update: a routine Todo -> In Progress transition does NOT print the concluded-state warning', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9459', '--state', 'In Progress'],
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  });
  assert.equal(res.status, 0);
  assert.doesNotMatch(res.stderr, /a concluded state/);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('update: moving BETWEEN terminal states (Done -> Canceled) does NOT print the reopen warning (not actually reopening)', () => {
  const res = runUpdate({
    // --cancel-reason satisfies the canceled-state reason gate (BRO-3435,
    // scripts/lib/linear-cancel-gate.js, exit 7): Done -> Canceled IS a real
    // transition INTO a canceled-type state, so the gate fires on it by design
    // and this test would otherwise exit 7 instead of 0. Same shape as the
    // Done -> Duplicate case below, which feeds the duplicate gate a
    // pre-existing relation for the same reason. The subject here is the
    // reopen warning, not either gate.
    argv: ['update', 'BRO-9459', '--state', 'Canceled', '--cancel-reason', 'superseded by the consolidated follow-up card'],
    state: { id: 'state-done', name: 'Done', type: 'completed' },
  });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /a concluded state/);
});

test('update: Done -> Duplicate does NOT warn — Duplicate is ALSO a terminal type, not a reopen (adversarial review finding)', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9459', '--state', 'Duplicate'],
    state: { id: 'state-done', name: 'Done', type: 'completed' },
    // A pre-existing relation so the duplicate-gate allows the move without
    // needing --duplicate-of (see linear-brain-duplicate-gate.test.mjs's
    // identical fixture shape for "allowed: an issue that already owns a
    // duplicate relation").
    relations: { nodes: [{ type: 'duplicate', relatedIssue: { id: 'issue-uuid-2823', identifier: 'BRO-9823' } }] },
  });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /a concluded state/);
});

test('update: Duplicate -> In Progress DOES warn — reopening a Duplicate-closed issue is exactly the BRO-3869 shape (adversarial review finding)', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9459', '--state', 'In Progress'],
    state: { id: 'state-duplicate', name: 'Duplicate', type: 'duplicate' },
  });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
  assert.match(res.stderr, /was "Duplicate" \(a concluded state\) — you're reopening it/);
});

test('update: a no-op re-run on an already-terminal issue (same state) does NOT print the warning', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9459', '--state', 'Done'],
    state: { id: 'state-done', name: 'Done', type: 'completed' },
  });
  // isRealTransition is false here (target.id === issue.state.id), so this
  // hits the done-gate instead — refused, since this fixture carries no
  // evidence — but never the reopen warning, since nothing is being reopened.
  // The exit-status assertion is not decoration: without it, ANY mutation
  // that throws before the reopen-warning block (exit 2) keeps this test
  // green on a doesNotMatch alone (ship-check finding, 2026-09-21).
  assert.equal(res.status, 5, `expected the done-gate refusal, got ${res.status}. stderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /a concluded state/);
});
