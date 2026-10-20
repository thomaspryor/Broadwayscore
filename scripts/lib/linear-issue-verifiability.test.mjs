import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateLinearIssue, evaluateLinearIssues, fetchIssuesWithComments } = require('./linear-issue-verifiability.js');
const { evaluateVerifiability } = require('./verify-gate.js');
const { sortedCommentBodies } = require('./linear-dispatch.js');

const CMD = 'node --test scripts/lib/linear-dispatch.test.mjs';
const corrected = (extra = {}) => ({
  identifier: 'BRO-2802', title: 'Correction', description: 'VERIFY: broken command',
  state: { type: 'started', name: 'In Progress' },
  comments: { nodes: [
    { body: `VERIFY: ${CMD}`, createdAt: '2026-10-11T08:42:00Z' },
    { body: 'VERIFY: node --test scripts/lib/verify-gate.test.mjs', createdAt: '2026-10-10T08:42:00Z' },
  ] }, ...extra,
});

test('audit evaluator uses the newest comment correction without mutating comment order', () => {
  const issue = corrected();
  const before = structuredClone(issue);
  assert.equal(evaluateLinearIssue({ ...issue, comments: undefined }).armed, false);
  assert.equal(evaluateLinearIssue(issue).cmd, CMD);
  assert.deepEqual(issue, before);
});

test('audit refreshes only refused bulk rows and preserves report order and fields', async () => {
  const calls = [];
  const issues = [corrected({ comments: undefined }), corrected({ identifier: 'BRO-2', description: `VERIFY: ${CMD}`, comments: undefined })];
  const rows = await evaluateLinearIssues(issues, { getIssue: async (id) => { calls.push(id); return corrected(); } });
  assert.deepEqual(calls, ['BRO-2802']);
  assert.deepEqual(rows.map((r) => [r.id, r.armed]), [['BRO-2802', true], ['BRO-2', true]]);
  assert.equal(rows[0].status, 'In Progress');
  assert.equal(rows[0].cmd, CMD);
});

test('audit failed or absent fresh reads leave refused cards refused', async () => {
  const issue = corrected({ comments: undefined });
  for (const getIssue of [async () => null, async () => { throw new Error('offline'); }]) {
    const logs = [];
    const [row] = await evaluateLinearIssues([issue], { getIssue, log: (s) => logs.push(s) });
    assert.equal(row.armed, false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /BRO-2802/);
  }
});

test('a comment can arm owner judgment while providing no acceptance command', async () => {
  const issue = corrected({ comments: { nodes: [{ body: 'VERIFY: owner-judgment' }] } });
  const [row] = await evaluateLinearIssues([{ ...issue, comments: undefined }], { getIssue: async () => issue });
  assert.equal(row.armed, true);
  assert.equal(row.ownerJudgment, true);
  assert.equal(row.cmd, null);
});

test('landed acceptance shortlist reads the corrected command from the fresh issue', async () => {
  const issue = corrected({ comments: undefined, description: 'VERIFY: node --test scripts/lib/verify-gate.test.mjs' });
  const calls = [];
  const [fresh] = await fetchIssuesWithComments([issue], { getIssue: async (id) => { calls.push(id); return corrected(); } });
  assert.deepEqual(calls, [issue.identifier]);
  const gate = evaluateVerifiability(fresh.description, sortedCommentBodies(fresh));
  assert.equal(gate.cmd, CMD);
});

test('failed comment reads never provide a stale acceptance command', async () => {
  const issue = corrected({ description: `VERIFY: ${CMD}` });
  assert.deepEqual(await fetchIssuesWithComments([issue], { getIssue: async () => null }), []);
});

test('empty shortlist makes no API calls', async () => {
  assert.deepEqual(await fetchIssuesWithComments([], { getIssue: () => { assert.fail('no candidates'); } }), []);
});
