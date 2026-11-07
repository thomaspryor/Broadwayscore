// Tests scripts/lib/linear.js — the single injectable Linear client (BRO-374).
//
// Every test require()s the REAL module (never a copy of the logic — CLAUDE.md
// rule 15) and injects a STUB graphql executor that records each call and
// returns canned data. No network, no API key. Covers all five operations in
// the client's surface: createIssue, updateIssue, addComment, delegateToAgent,
// getIssue — plus the injection contract itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  LinearClient,
  createLinearClient,
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_QUERY,
} = require('./linear.js');

// A stub executor: records (query, variables) for assertions and returns
// whatever `responder` produces. This is the injected seam — no fetch, no env.
function makeStub(responder) {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    return typeof responder === 'function' ? responder(query, variables) : responder;
  };
  return { graphql, calls };
}

// ── injection contract ─────────────────────────────────────────────────────

test('constructor throws when no graphql executor is injected', () => {
  assert.throws(() => new LinearClient({}), /requires an injected `graphql/);
  assert.throws(() => new LinearClient({ graphql: 'nope' }), /requires an injected `graphql/);
});

test('constructor keeps the injected executor and default team key', () => {
  const { graphql } = makeStub({});
  const client = new LinearClient({ graphql });
  assert.equal(client.graphql, graphql);
  assert.equal(client.teamKey, 'BRO');
});

// ── 1. createIssue ───────────────────────────────────────────────────────

test('createIssue: sends the create mutation and returns the issue node', async () => {
  const issue = { id: 'uuid-1', identifier: 'BRO-500', title: 'New', url: 'https://x/BRO-500' };
  const { graphql, calls } = makeStub({ issueCreate: { success: true, issue } });
  const client = new LinearClient({ graphql });

  const result = await client.createIssue({
    teamId: 'team-1',
    title: 'New',
    description: 'body',
    priority: 2,
    stateId: 'state-1',
    projectId: 'proj-1',
  });

  assert.deepEqual(result, issue);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, ISSUE_CREATE_MUTATION);
  assert.deepEqual(calls[0].variables.input, {
    teamId: 'team-1',
    title: 'New',
    description: 'body',
    priority: 2,
    stateId: 'state-1',
    projectId: 'proj-1',
    assigneeId: undefined,
  });
});

test('createIssue: requires teamId and title before touching the client', async () => {
  const { graphql, calls } = makeStub({});
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.createIssue({ title: 'x' }), /teamId is required/);
  await assert.rejects(() => client.createIssue({ teamId: 't' }), /title is required/);
  assert.equal(calls.length, 0, 'validation must run before any graphql call');
});

test('createIssue: throws when the API reports success:false', async () => {
  const { graphql } = makeStub({ issueCreate: { success: false, issue: null } });
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.createIssue({ teamId: 't', title: 'Oops' }), /issueCreate failed for "Oops"/);
});

// ── 2. updateIssue ─────────────────────────────────────────────────────────

test('updateIssue: sends the update mutation with id + input', async () => {
  const { graphql, calls } = makeStub({ issueUpdate: { success: true, issue: { id: 'uuid-1', identifier: 'BRO-500' } } });
  const client = new LinearClient({ graphql });

  const result = await client.updateIssue('uuid-1', { stateId: 'in-review' });

  assert.equal(result.success, true);
  assert.equal(calls[0].query, ISSUE_UPDATE_MUTATION);
  assert.deepEqual(calls[0].variables, { id: 'uuid-1', input: { stateId: 'in-review' } });
});

test('updateIssue: validates id and input', async () => {
  const { graphql, calls } = makeStub({});
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.updateIssue('', { stateId: 's' }), /id is required/);
  await assert.rejects(() => client.updateIssue('uuid-1', null), /input object is required/);
  assert.equal(calls.length, 0);
});

test('updateIssue: throws when success:false', async () => {
  const { graphql } = makeStub({ issueUpdate: { success: false } });
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.updateIssue('uuid-1', { title: 't' }), /issueUpdate failed for uuid-1/);
});

// ── 3. addComment ──────────────────────────────────────────────────────────

test('addComment: sends the comment mutation and returns the comment node', async () => {
  const { graphql, calls } = makeStub({ commentCreate: { success: true, comment: { id: 'comment-1' } } });
  const client = new LinearClient({ graphql });

  const result = await client.addComment('uuid-1', 'Dispatched at noon');

  assert.deepEqual(result, { id: 'comment-1' });
  assert.equal(calls[0].query, COMMENT_CREATE_MUTATION);
  assert.deepEqual(calls[0].variables, { issueId: 'uuid-1', body: 'Dispatched at noon' });
});

test('addComment: validates issueId and body', async () => {
  const { graphql, calls } = makeStub({});
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.addComment('', 'hi'), /issueId is required/);
  await assert.rejects(() => client.addComment('uuid-1', ''), /body is required/);
  assert.equal(calls.length, 0);
});

test('addComment: throws when success:false', async () => {
  const { graphql } = makeStub({ commentCreate: { success: false } });
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.addComment('uuid-1', 'x'), /commentCreate failed for issue uuid-1/);
});

// ── 4. delegateToAgent ──────────────────────────────────────────────────────

test('delegateToAgent: delegates via an issueUpdate carrying delegateId', async () => {
  const { graphql, calls } = makeStub({ issueUpdate: { success: true, issue: { id: 'uuid-1', identifier: 'BRO-500' } } });
  const client = new LinearClient({ graphql });

  const result = await client.delegateToAgent('uuid-1', 'agent-app-user-1');

  assert.equal(result.success, true);
  // Delegation IS an issueUpdate with delegateId — assert it went out as one.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, ISSUE_UPDATE_MUTATION);
  assert.deepEqual(calls[0].variables, { id: 'uuid-1', input: { delegateId: 'agent-app-user-1' } });
});

test('delegateToAgent: validates issueId and agentId', async () => {
  const { graphql, calls } = makeStub({});
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.delegateToAgent('', 'agent-1'), /issueId is required/);
  await assert.rejects(() => client.delegateToAgent('uuid-1', ''), /agentId is required/);
  assert.equal(calls.length, 0);
});

// ── 5. getIssue ────────────────────────────────────────────────────────────

test('getIssue: reads by identifier and returns the issue node', async () => {
  const issue = { id: 'uuid-1', identifier: 'BRO-374', title: 'Phase 1', state: { type: 'started' } };
  const { graphql, calls } = makeStub({ issue });
  const client = new LinearClient({ graphql });

  const result = await client.getIssue('BRO-374');

  assert.deepEqual(result, issue);
  assert.equal(calls[0].query, ISSUE_QUERY);
  assert.deepEqual(calls[0].variables, { id: 'BRO-374' });
});

test('getIssue: returns null when the identifier does not resolve', async () => {
  const { graphql } = makeStub({ issue: null });
  const client = new LinearClient({ graphql });
  assert.equal(await client.getIssue('BRO-999999'), null);
});

test('getIssue: requires an identifier', async () => {
  const { graphql, calls } = makeStub({});
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.getIssue(''), /identifier is required/);
  assert.equal(calls.length, 0);
});

// ── error propagation from the injected executor ────────────────────────────

test('operations propagate errors thrown by the injected executor', async () => {
  const boom = new Error('Linear GraphQL error: USAGE_LIMIT_EXCEEDED');
  const graphql = async () => {
    throw boom;
  };
  const client = new LinearClient({ graphql });
  await assert.rejects(() => client.createIssue({ teamId: 't', title: 'x' }), /USAGE_LIMIT_EXCEEDED/);
  await assert.rejects(() => client.getIssue('BRO-1'), /USAGE_LIMIT_EXCEEDED/);
});

// ── production wiring stays pure until called ────────────────────────────────

test('createLinearClient returns a LinearClient (executor built lazily)', () => {
  // Requiring the module and constructing the wired client must NOT need an
  // API key or network — only an actual operation would. Just prove the
  // factory returns the right shape.
  const client = createLinearClient({ teamKey: 'BRO' });
  assert.ok(client instanceof LinearClient);
  assert.equal(client.teamKey, 'BRO');
  assert.equal(typeof client.graphql, 'function');
});
