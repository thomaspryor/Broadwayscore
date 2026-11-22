// Tests scripts/lib/linear-client.js's archived-issue retry path (task
// #1510): createComment/updateIssue must survive a target issue being
// archived (routine under BRO-285's free-tier cap) instead of failing with
// the generic, indistinguishable-from-a-bad-id "Entity not found: Issue"
// error. Mocks global.fetch — no live Linear API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.LINEAR_API_KEY = 'test-key';
const { createComment, updateIssue, issueUnarchive, archiveIssue } = require('../../scripts/lib/linear-client.js');

const ARCHIVED_ISSUE_ERROR = { errors: [{ message: 'Entity not found: Issue' }] };

// Queues canned GraphQL responses and records each call's operation name
// (derived from the query text) in order.
function mockFetch(responses) {
  let i = 0;
  const calls = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const op = /commentCreate/.test(body.query)
      ? 'commentCreate'
      : /issueUnarchive/.test(body.query)
        ? 'issueUnarchive'
        : /issueArchive/.test(body.query)
          ? 'issueArchive'
          : /issueUpdate/.test(body.query)
            ? 'issueUpdate'
            : /archivedAt/.test(body.query)
              ? 'getArchivedAt'
              : 'unknown';
    calls.push({ op, variables: body.variables });
    const resp = responses[i++];
    if (!resp) throw new Error(`no mock response queued for call #${i} (${op})`);
    return { json: async () => resp };
  };
  return calls;
}

test('createComment: retries through unarchive -> retry on an archived issue, and does NOT re-archive', async () => {
  const calls = mockFetch([
    ARCHIVED_ISSUE_ERROR, // commentCreate: fails, issue is archived
    { data: { issue: { archivedAt: '2026-08-14T00:00:00.000Z' } } }, // confirm archived
    { data: { issueUnarchive: { success: true } } }, // unarchive
    { data: { commentCreate: { success: true, comment: { id: 'c1' } } } }, // retry succeeds
  ]);

  const result = await createComment('issue-1', 'Dispatched to ...');

  assert.deepEqual(
    calls.map((c) => c.op),
    ['commentCreate', 'getArchivedAt', 'issueUnarchive', 'commentCreate']
  );
  assert.equal(calls[1].variables.id, 'issue-1');
  assert.equal(calls[2].variables.id, 'issue-1');
  assert.deepEqual(result, { success: true, comment: { id: 'c1' } });
});

test('updateIssue: retries through unarchive -> retry on an archived issue, leaving it unarchived (e.g. dispatch-start moving it to In Progress)', async () => {
  const calls = mockFetch([
    ARCHIVED_ISSUE_ERROR, // issueUpdate: fails, issue is archived
    { data: { issue: { archivedAt: '2026-08-14T00:00:00.000Z' } } },
    { data: { issueUnarchive: { success: true } } },
    { data: { issueUpdate: { success: true } } }, // retry succeeds
  ]);

  await updateIssue('issue-2', { stateId: 'state-in-progress' });

  assert.deepEqual(
    calls.map((c) => c.op),
    ['issueUpdate', 'getArchivedAt', 'issueUnarchive', 'issueUpdate']
  );
});

test('a retry that itself fails rethrows that error, without attempting to re-archive', async () => {
  const calls = mockFetch([
    ARCHIVED_ISSUE_ERROR,
    { data: { issue: { archivedAt: '2026-08-14T00:00:00.000Z' } } },
    { data: { issueUnarchive: { success: true } } },
    { data: { commentCreate: { success: false } } }, // retry itself fails
  ]);

  await assert.rejects(() => createComment('issue-3', 'body'), /commentCreate failed for issue issue-3/);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['commentCreate', 'getArchivedAt', 'issueUnarchive', 'commentCreate']
  );
});

test('not-archived "Entity not found" rethrows the original error without unarchiving', async () => {
  const calls = mockFetch([
    ARCHIVED_ISSUE_ERROR,
    { data: { issue: { archivedAt: null } } }, // exists, but not archived — some other cause
  ]);

  await assert.rejects(() => createComment('issue-4', 'body'), /Entity not found: Issue/);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['commentCreate', 'getArchivedAt']
  );
});

test('a deleted/unknown issue (no issue at all) rethrows the original error without unarchiving', async () => {
  const calls = mockFetch([ARCHIVED_ISSUE_ERROR, { data: { issue: null } }]);

  await assert.rejects(() => createComment('issue-5', 'body'), /Entity not found: Issue/);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['commentCreate', 'getArchivedAt']
  );
});

test('unrelated errors pass straight through with no archived-issue handling', async () => {
  const calls = mockFetch([{ errors: [{ message: 'Some other GraphQL error' }] }]);

  await assert.rejects(() => createComment('issue-6', 'body'), /Some other GraphQL error/);
  assert.deepEqual(calls.map((c) => c.op), ['commentCreate']);
});

test('issueUnarchive is exported alongside archiveIssue and posts the unarchive mutation', async () => {
  assert.equal(typeof issueUnarchive, 'function');
  assert.equal(typeof archiveIssue, 'function');
  const calls = mockFetch([{ data: { issueUnarchive: { success: true } } }]);
  await issueUnarchive('issue-7');
  assert.deepEqual(calls.map((c) => c.op), ['issueUnarchive']);
  assert.equal(calls[0].variables.id, 'issue-7');
});

// BRO-7102: Done/Canceled cards auto-archive ~2 days after close, and Linear's
// issues() filter drops archived issues unless includeArchived is set. A
// by-identifier comment read of a closed card then returned an empty Map, no
// error: ci-green-rate --cause-mix read 76 of 76 closed red cards as untagged.
test('listIssueComments: includes archived issues by default; false opts out', async () => {
  const { listIssueComments } = require('../../scripts/lib/linear-client.js');
  const queries = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    queries.push(body.query);
    const archived = /includeArchived: true/.test(body.query);
    return { ok: true, status: 200, json: async () => ({ data: { issues: { nodes: archived ? [{ identifier: 'BRO-9', comments: { nodes: [{ body: 'CAUSE: flake', createdAt: '2026-11-13' }] } }] : [] } } }) };
  };
  const byDefault = await listIssueComments(['BRO-9']);
  assert.equal((byDefault.get('BRO-9') || []).length, 1, 'an archived (closed) card must still return its comments');
  assert.match(queries[0], /includeArchived: true/);
  const optedOut = await listIssueComments(['BRO-9'], undefined, { includeArchived: false });
  assert.equal(optedOut.has('BRO-9'), false);
  assert.doesNotMatch(queries[1], /includeArchived/);
});
