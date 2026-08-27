// BRO-2466: the BRO team has THREE terminal state types (completed,
// canceled, duplicate), not two. This colocated test requires() the real
// linear-dispatch.js / linear-state-types.js so a production regression
// (someone hand-rolling `stateType === 'completed' || stateType ===
// 'canceled'` again instead of using isTerminalStateType) fails this test
// instead of drifting silently past it (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueQuery,
  buildOpenIssuesQuery,
  buildOpenIssuesWithDescriptionsQuery,
  checkTerminalStateGuard,
  marketingProjectGuard,
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

test('buildIssueQuery: fetches project so marketingProjectGuard can see it (BRO-2488)', () => {
  const query = buildIssueQuery();
  assert.match(query, /project\s*\{\s*name\s*\}/);
});

// BRO-2488: the documented dispatch funnel excludes "· Marketing" issues, but
// nothing enforced it — BRO-128 (Linear project "Marketing/distribution")
// dispatched cleanly with zero refusal. This must fail against the
// pre-fix behavior (issue.project was never fetched, so any check reading it
// evaluated against undefined and refused nothing).
test('marketingProjectGuard: refuses an issue in the Marketing/distribution project', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  const refusal = marketingProjectGuard(issue, {});
  assert.match(refusal, /BRO-128/);
  assert.match(refusal, /Marketing\/distribution/);
});

test('marketingProjectGuard: case/whitespace-insensitive on the project name', () => {
  const issue = { identifier: 'BRO-1', project: { name: '  MARKETING/DISTRIBUTION  ' } };
  assert.match(marketingProjectGuard(issue, {}), /BRO-1/);
});

test('marketingProjectGuard: a non-Marketing project is allowed', () => {
  const issue = { identifier: 'BRO-2', project: { name: 'Infrastructure' } };
  assert.equal(marketingProjectGuard(issue, {}), null);
});

test('marketingProjectGuard: no project set (undefined) is allowed — fails open like every other guard', () => {
  const issue = { identifier: 'BRO-3' };
  assert.equal(marketingProjectGuard(issue, {}), null);
});

test('marketingProjectGuard: --force bypasses the refusal', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  assert.equal(marketingProjectGuard(issue, { force: true }), null);
});

test('marketingProjectGuard: --dry-run and --print-prompt also bypass it (preview stays side-effect-free)', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  assert.equal(marketingProjectGuard(issue, { 'dry-run': true }), null);
  assert.equal(marketingProjectGuard(issue, { 'print-prompt': true }), null);
});

test('findUnresolvedDispatchComment: a "Dispatched ..." comment on a now-duplicate issue is not live', () => {
  const dispatched = { body: 'Dispatched abcd1234 to workspace-9 at 2026-08-01T00:00:00Z' };
  const issue = { state: { type: 'duplicate' }, comments: { nodes: [dispatched] } };
  assert.equal(findUnresolvedDispatchComment(issue), null);
});
