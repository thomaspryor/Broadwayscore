// BRO-2466: the BRO team has THREE terminal state types (completed,
// canceled, duplicate), not two. This colocated test requires() the real
// linear-dispatch.js / linear-state-types.js so a production regression
// (someone hand-rolling `stateType === 'completed' || stateType ===
// 'canceled'` again instead of using isTerminalStateType) fails this test
// instead of drifting silently past it (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenIssuesQuery,
  buildOpenIssuesWithDescriptionsQuery,
  checkTerminalStateGuard,
  findUnresolvedDispatchComment,
} from './linear-dispatch.js';
import { TERMINAL_STATE_TYPES, isTerminalStateType } from './linear-state-types.js';

test('TERMINAL_STATE_TYPES includes duplicate alongside completed/canceled', () => {
  assert.deepEqual([...TERMINAL_STATE_TYPES].sort(), ['canceled', 'completed', 'duplicate']);
});

test('isTerminalStateType: true for all three terminal types, false otherwise', () => {
  assert.equal(isTerminalStateType('completed'), true);
  assert.equal(isTerminalStateType('canceled'), true);
  assert.equal(isTerminalStateType('duplicate'), true);
  assert.equal(isTerminalStateType('started'), false);
  assert.equal(isTerminalStateType('backlog'), false);
  assert.equal(isTerminalStateType(undefined), false);
});

test('buildOpenIssuesQuery: excludes duplicate (not just completed/canceled) from the open-issue filter', () => {
  const query = buildOpenIssuesQuery();
  assert.match(query, /nin:\s*\["completed","canceled","duplicate"\]/);
});

test('buildOpenIssuesWithDescriptionsQuery: excludes duplicate too (rail 2 dedupe query)', () => {
  const query = buildOpenIssuesWithDescriptionsQuery();
  assert.match(query, /nin:\s*\["completed","canceled","duplicate"\]/);
});

test('checkTerminalStateGuard: refuses re-dispatch of a duplicate-type issue, names the state', () => {
  const issue = { identifier: 'BRO-2400', state: { type: 'duplicate', name: 'Duplicate' } };
  const refusal = checkTerminalStateGuard(issue);
  assert.match(refusal, /BRO-2400/);
  assert.match(refusal, /Duplicate/);
});

test('findUnresolvedDispatchComment: a "Dispatched ..." comment on a now-duplicate issue is not live', () => {
  const dispatched = { body: 'Dispatched abcd1234 to workspace-9 at 2026-08-01T00:00:00Z' };
  const issue = { state: { type: 'duplicate' }, comments: { nodes: [dispatched] } };
  assert.equal(findUnresolvedDispatchComment(issue), null);
});
