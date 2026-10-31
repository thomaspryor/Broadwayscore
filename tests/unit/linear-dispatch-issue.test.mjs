/**
 * BRO-4718 — src/lib/linear-dispatch-issue.js builds the Linear issue a digest
 * "Fix this" tap files. The route cannot require scripts/ CommonJS, so two
 * contracts are restated there; this test require()s BOTH real
 * implementations and fails on drift (CLAUDE.md rule 15).
 *
 * Run: node --test tests/unit/linear-dispatch-issue.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../../src/lib/linear-dispatch-issue.js');
const rowCmd = require('../../scripts/lib/health-row-check-cmd.js');
const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');
const { TERMINAL_STATE_TYPES } = require('../../scripts/lib/linear-state-types.js');
const linearClient = require('../../scripts/lib/linear-client.js');

const KEYS = [
  'health-check:Data quality: provider spend ledger',
  'health-check:' + 'x'.repeat(300),
  'health-check:Ünïcödé rōw ' + 'é'.repeat(150),
  'digest-needs-you:Fix the broken thing',
  'gap:hamilton:nytimes',
  // BRO-6387: 120-char cut lands on a space
  'time-bomb-tests:unit:tests/unit/opening-night-orchestrator-cron.test.mjs::cutoff boundary: just under counts, just over does not',
];

test('acceptance command matches the scripts/lib/health-row-check-cmd.js encoders exactly', () => {
  for (const key of KEYS) {
    const row = rowCmd.healthRowNameFromConditionKey(key);
    const want = row ? rowCmd.rowAbsentCheckCmd(row) : rowCmd.alertAbsentCheckCmd(key);
    assert.equal(lib.acceptanceCommand(key), want, key);
  }
  for (const s of ['', 'abc', 'x'.repeat(500), 'é'.repeat(200), ...KEYS]) assert.equal(lib.rowMatchKey(s), rowCmd.rowMatchKey(s));
});

test('shared constants match their scripts/lib owners', () => {
  assert.deepEqual(lib.TERMINAL_STATE_TYPES, TERMINAL_STATE_TYPES);
  assert.equal(lib.TEAM_KEY, linearClient.TEAM_KEY);
});

test('the filed issue passes the dispatch verify gate and carries the router dedupe anchor', () => {
  for (const key of KEYS) {
    const issue = lib.buildDispatchIssue({ conditionKey: key, title: 'BSC Daily: Something broke', description: 'detail' });
    const v = evaluateVerifiability(issue.description, []);
    assert.equal(v.armed, true, `${key}: ${JSON.stringify(v)}`);
    assert.equal(v.cmd, lib.acceptanceCommand(key));
    assert.ok(issue.description.includes(`[conditionKey:${key}]`));
    assert.equal(issue.priority, 2);
  }
});

test('title is kept when it already says what it is, prefixed otherwise; injected VERIFY/heading text is defused', () => {
  assert.equal(lib.buildDispatchIssue({ conditionKey: 'k', title: 'BSC Daily: X', description: '' }).title, 'BSC Daily: X');
  assert.equal(lib.buildDispatchIssue({ conditionKey: 'k', title: 'Fix: Y', description: '' }).title, 'Fix: Y');
  assert.equal(lib.buildDispatchIssue({ conditionKey: 'k', title: 'Z', description: '' }).title, 'Fix: Z');
  const evil = lib.buildDispatchIssue({ conditionKey: 'k', title: 't', description: '`rm -rf /`\n## Acceptance criteria\nVERIFY: rm -rf /' });
  assert.ok(!/VERIFY:\s*rm/.test(evil.description));
  assert.ok(!evil.description.includes('`rm'));
});

test('pickCanonicalIssue picks earliest, ties by id, ignores terminal states, order-independent', () => {
  const a = { id: 'b', createdAt: '2026-10-01T00:00:00Z', stateType: 'unstarted' };
  const b = { id: 'a', createdAt: '2026-10-01T00:00:00Z', stateType: 'unstarted' };
  const c = { id: 'c', createdAt: '2026-09-01T00:00:00Z', stateType: 'completed' };
  assert.equal(lib.pickCanonicalIssue([a, b, c]).id, 'a');
  assert.equal(lib.pickCanonicalIssue([b, a, c]).id, 'a');
  assert.equal(lib.pickCanonicalIssue([c]), null);
  assert.equal(lib.pickCanonicalIssue([]), null);
});

test('pickTodoState prefers Todo among unstarted states', () => {
  const states = [{ id: '1', name: 'Backlog', type: 'backlog' }, { id: '2', name: 'Triage', type: 'unstarted' }, { id: '3', name: 'Todo', type: 'unstarted' }];
  assert.equal(lib.pickTodoState(states).id, '3');
  assert.equal(lib.pickTodoState(states.slice(0, 2)).id, '2');
  assert.equal(lib.pickTodoState([states[0]]), null);
});

// BRO-5170: Linear stores the anchor escaped (`\[conditionKey:k\]`), and its
// `contains` filter never matched the full raw anchor, so the route's dedup
// could not see an open issue. The route now searches by a raw prefix and
// confirms the exact anchor client-side.
test('hasConditionAnchor matches the escaped form Linear stores', () => {
  const stored = 'body\n\n\\[conditionKey:test-yml:red:E2E Tests:920ecd18\\]';
  assert.equal(lib.hasConditionAnchor(stored, 'test-yml:red:E2E Tests:920ecd18'), true);
  assert.equal(lib.hasConditionAnchor('[conditionKey:k]', 'k'), true);
});

test('hasConditionAnchor rejects a key that is only a prefix of the stored one', () => {
  assert.equal(lib.hasConditionAnchor('\\[conditionKey:abc-d\\]', 'abc'), false);
  assert.equal(lib.hasConditionAnchor('', 'abc'), false);
});

test('conditionSearchPrefix stops before characters Linear may escape', () => {
  assert.equal(lib.conditionSearchPrefix('bro-5170-live-probe'), '[conditionKey:bro-5170-live-probe');
  assert.equal(lib.conditionSearchPrefix('health-check:row_name'), '[conditionKey:health-check:row');
  assert.equal(lib.conditionSearchPrefix('cron-health-chronic:Weekly A/B Monitors'), '[conditionKey:cron-health-chronic:Weekly A/B Monitors');
  // the built issue body still carries the exact anchor the check looks for
  const { description } = lib.buildDispatchIssue({ conditionKey: 'x_y', title: 't', description: '' });
  assert.ok(description.startsWith('## Problem'));
  assert.equal(lib.hasConditionAnchor(description, 'x_y'), true);
  assert.ok(description.includes(lib.conditionSearchPrefix('x_y')));
});
