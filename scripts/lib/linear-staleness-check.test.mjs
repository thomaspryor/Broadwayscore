import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIssueStaleness, TERMINAL_STATE_TYPES } from './linear-staleness-check.js';

function issue({ stateType = 'started', stateName = 'In Progress', comments = [] } = {}) {
  return {
    identifier: 'BRO-3456',
    state: { name: stateName, type: stateType },
    comments: { nodes: comments },
  };
}

test('checkIssueStaleness requires an issue', () => {
  assert.throws(() => checkIssueStaleness(null, '2026-09-16T12:00:00Z'), /issue is required/);
});

test('checkIssueStaleness requires sessionKnownAt', () => {
  assert.throws(() => checkIssueStaleness(issue(), undefined), /sessionKnownAt/);
});

test('checkIssueStaleness rejects an invalid sessionKnownAt instead of silently treating it as "nothing changed"', () => {
  assert.throws(() => checkIssueStaleness(issue(), 'not-a-date'), /not a valid date/);
});

test('checkIssueStaleness rejects a future sessionKnownAt instead of silently suppressing every real signal forever', () => {
  const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.throws(() => checkIssueStaleness(issue(), farFuture), /in the future/);
});

test('checkIssueStaleness tolerates a few minutes of clock skew', () => {
  const almostNow = new Date(Date.now() + 60 * 1000).toISOString();
  assert.doesNotThrow(() => checkIssueStaleness(issue(), almostNow));
});

test('checkIssueStaleness is clean when the issue is unchanged since sessionKnownAt', () => {
  const result = checkIssueStaleness(issue(), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, false);
  assert.deepEqual(result.signals, []);
});

test('checkIssueStaleness flags a terminal state reached since last known (BRO-3456: concluded+shipped while this session worked it)', () => {
  const result = checkIssueStaleness(issue({ stateType: 'completed', stateName: 'Done' }), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, true);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].type, 'terminal-state');
  assert.match(result.signals[0].detail, /Done/);
});

test('checkIssueStaleness treats canceled the same as completed as terminal', () => {
  const result = checkIssueStaleness(issue({ stateType: 'canceled', stateName: 'Canceled' }), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, true);
  assert.equal(result.signals[0].type, 'terminal-state');
});

test('checkIssueStaleness does not flag a non-terminal state change (e.g. In Progress -> In Review)', () => {
  const result = checkIssueStaleness(issue({ stateType: 'started', stateName: 'In Review' }), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, false);
});

test('checkIssueStaleness flags comments posted after sessionKnownAt', () => {
  const comments = [
    { id: 'c1', createdAt: '2026-09-16T11:00:00Z', body: 'earlier, already seen', user: { name: 'Alice' } },
    { id: 'c2', createdAt: '2026-09-16T13:00:00Z', body: 'concluded the experiment', user: { name: 'Bob' } },
  ];
  const result = checkIssueStaleness(issue({ comments }), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, true);
  assert.equal(result.signals[0].type, 'new-comments');
  assert.equal(result.signals[0].comments.length, 1);
  assert.equal(result.signals[0].comments[0].id, 'c2');
  assert.match(result.signals[0].detail, /Bob/);
});

test('checkIssueStaleness does not flag comments posted before or exactly at sessionKnownAt', () => {
  const comments = [
    { id: 'c1', createdAt: '2026-09-16T11:00:00Z', body: 'old', user: { name: 'Alice' } },
    { id: 'c2', createdAt: '2026-09-16T12:00:00Z', body: 'exactly at the boundary', user: { name: 'Alice' } },
  ];
  const result = checkIssueStaleness(issue({ comments }), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, false);
});

test('checkIssueStaleness dedupes authors and reports both a terminal state AND new comments together', () => {
  const comments = [{ id: 'c1', createdAt: '2026-09-16T16:57:00Z', body: 'shipped', user: { name: 'Bob' } }];
  const result = checkIssueStaleness(issue({ stateType: 'completed', stateName: 'Done', comments }), '2026-09-16T12:00:00Z');
  assert.equal(result.stale, true);
  assert.equal(result.signals.length, 2);
  const types = result.signals.map((s) => s.type).sort();
  assert.deepEqual(types, ['new-comments', 'terminal-state']);
});

test('checkIssueStaleness tolerates a missing comments connection', () => {
  const result = checkIssueStaleness({ identifier: 'BRO-1', state: { name: 'Todo', type: 'unstarted' } }, '2026-09-16T12:00:00Z');
  assert.equal(result.stale, false);
});

test('TERMINAL_STATE_TYPES is exactly completed/canceled/duplicate', () => {
  // 'duplicate' included per linear-duplicate-gate.js's DUPLICATE_STATE_TYPE
  // constant — this team's "Duplicate" state carries that as its own
  // state.type, not folded into 'canceled' (adversarial review finding).
  assert.deepEqual([...TERMINAL_STATE_TYPES].sort(), ['canceled', 'completed', 'duplicate']);
});

test('checkIssueStaleness treats a Duplicate-closed issue as terminal too', () => {
  const dup = { identifier: 'BRO-1', state: { name: 'Duplicate', type: 'duplicate' }, comments: { nodes: [] } };
  const result = checkIssueStaleness(dup, '2026-09-16T12:00:00Z');
  assert.equal(result.stale, true);
  assert.equal(result.signals[0].type, 'terminal-state');
});
