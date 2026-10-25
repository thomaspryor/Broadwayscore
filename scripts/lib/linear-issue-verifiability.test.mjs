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

test('audit batches only refused identifiers once and preserves report order and fields', async () => {
  const calls = [];
  const issues = [corrected({ comments: undefined }), corrected({ identifier: 'BRO-2', description: `VERIFY: ${CMD}`, comments: undefined }), corrected({ identifier: 'BRO-3', comments: undefined })];
  const before = structuredClone(issues);
  const rows = await evaluateLinearIssues(issues, {
    getIssue: () => { assert.fail('audit must not fetch individual issues'); },
    listIssueComments: async (ids) => {
      calls.push(ids);
      return new Map(ids.map((id) => [id, corrected().comments.nodes]));
    },
  });
  assert.deepEqual(calls, [['BRO-2802', 'BRO-3']]);
  assert.deepEqual(rows.map((r) => [r.id, r.armed]), [['BRO-2802', true], ['BRO-2', true], ['BRO-3', true]]);
  assert.deepEqual(issues, before);
  assert.equal(rows[0].status, 'In Progress');
  assert.equal(rows[0].cmd, CMD);
});

test('audit batch failure is logged and leaves every refused card refused', async () => {
  const issues = [corrected({ comments: undefined }), corrected({ identifier: 'BRO-3', comments: undefined }), corrected({ identifier: 'BRO-2', description: `VERIFY: ${CMD}`, comments: undefined })];
  const logs = [];
  let calls = 0;
  const rows = await evaluateLinearIssues(issues, {
    getIssue: () => { assert.fail('audit must not fetch individual issues'); },
    listIssueComments: async (ids) => {
      calls++;
      assert.deepEqual(ids, ['BRO-2802', 'BRO-3']);
      throw new Error('offline');
    },
    log: (s) => logs.push(s),
  });
  assert.equal(calls, 1);
  assert.deepEqual(rows, issues.map(evaluateLinearIssue));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /offline/);
});

test('audit missing and empty comment results leave refused cards refused', async () => {
  const issues = [corrected({ comments: undefined }), corrected({ identifier: 'BRO-3', comments: undefined })];
  const rows = await evaluateLinearIssues(issues, {
    listIssueComments: async () => new Map([['BRO-2802', []]]),
  });
  assert.deepEqual(rows, issues.map(evaluateLinearIssue));
});

test('audit with no refused rows skips comment fetching', async () => {
  const issue = corrected({ comments: undefined, description: `VERIFY: ${CMD}` });
  const opts = { listIssueComments: () => { assert.fail('no refused cards'); } };
  assert.deepEqual(await evaluateLinearIssues([], opts), []);
  assert.deepEqual(await evaluateLinearIssues([issue], opts), [evaluateLinearIssue(issue)]);
});

test('a comment can arm owner judgment while providing no acceptance command', async () => {
  const issue = corrected({ comments: { nodes: [{ body: 'VERIFY: owner-judgment' }] } });
  const [row] = await evaluateLinearIssues([{ ...issue, comments: undefined }], {
    listIssueComments: async () => new Map([[issue.identifier, issue.comments.nodes]]),
  });
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
