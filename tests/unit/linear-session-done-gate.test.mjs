// Tests scripts/linear-session.js's `report --status=done` path wired to
// scripts/lib/linear-done-gate.js (BRO-457, follow-up to the linear-brain.js
// wiring). `report --status=done` — not `linear-brain.js update` — is the
// call site every session actually uses to close out Linear work (it's what
// the file's own header says the Stop-hook gates on), so done-semantics-gate
// had no real-world effect until this path was gated too.
//
// Mocks global.fetch — no live Linear API calls — same convention as
// tests/unit/linear-client-archived-issue.test.mjs. cmdReport() is called
// in-process (not a subprocess): unlike linear-brain.js's `update`,
// cmdReport's process.exit(5) refusal path has no surrounding try/catch to
// swallow a thrown process.exit stub (main()'s own .catch() only wraps
// main(), never a direct cmdReport() call), so a stub-that-throws propagates
// cleanly as a rejected promise here.
import { test, afterEach } from 'node:test';
import { guardProcessExit } from '../helpers/process-exit-guard.mjs';
// Same class as tests/unit/linear-next.test.mjs: this file stubs process.exit,
// but code under test can also signal failure with `process.exitCode = 1`,
// which a per-test finally cannot restore because it lives on the runner's own
// process. node --test then fails the whole FILE with no named failing subtest.
// Resetting after each test clears only that leak; a genuinely failing test
// still fails the file (verified).
afterEach(() => {
  process.exitCode = 0;
});

// BRO-2647: turn any unstubbed process.exit into a NAMED failing subtest
// instead of a decapitated TAP stream. See tests/helpers/process-exit-guard.mjs.
guardProcessExit();

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.LINEAR_API_KEY = 'test-key';
const { cmdReport } = require('../../scripts/linear-session.js');

// Mirrors this team's real states (queried live: In Review, Canceled, Todo,
// Backlog, Duplicate, Done, In Progress) closely enough to exercise
// planCompletion()'s exact-name matching rather than falling back to
// type-based matching, which would silently mask a wrong-state bug here.
const TEAM_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-review', name: 'In Review', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
];

function makeIssueResponse({ description, commentBodies = [] }) {
  return {
    data: {
      issue: {
        id: 'issue-uuid-457b',
        identifier: 'BRO-9458',
        title: 'Fixture issue for the report --status=done gate',
        description,
        priority: 2,
        url: 'https://linear.app/broadway-scorecard/issue/BRO-9458/fixture',
        state: { id: 'state-progress', name: 'In Progress', type: 'started' },
        labels: { nodes: [] },
        comments: { nodes: commentBodies.map((body, i) => ({ id: `c${i}`, body, createdAt: null, user: null })) },
      },
    },
  };
}

// Queues responses keyed by a substring match against the outgoing query
// text, same op-detection style as linear-client-archived-issue.test.mjs's
// mockFetch — order-independent since cmdReport's call order across
// getIssue/createComment/getTeam/updateIssue is exactly what this proves.
function mockFetch({ issue, updateShouldBeCalled }) {
  const calls = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const q = body.query;
    calls.push({ query: q, variables: body.variables });
    if (q.includes('issue(id:')) return { json: async () => makeIssueResponse(issue) };
    if (q.includes('commentCreate')) return { json: async () => ({ data: { commentCreate: { success: true, comment: { id: 'c-new' } } } }) };
    if (q.includes('teams(filter:')) {
      return { json: async () => ({ data: { teams: { nodes: [{ id: 'team-1', key: 'BRO', states: { nodes: TEAM_STATES } }] } } }) };
    }
    if (q.includes('issueUpdate')) {
      if (!updateShouldBeCalled) throw new Error('issueUpdate must not be called — the gate refused before any write');
      return { json: async () => ({ data: { issueUpdate: { success: true } } }) };
    }
    throw new Error(`no mock handler for query: ${q.slice(0, 80)}`);
  };
  return calls;
}

function withStubbedExit(fn) {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('EXIT');
  };
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const origLog = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  return fn({ getExitCode: () => exitCode, getErrors: () => errors.join('\n'), getLogs: () => logs.join('\n') })
    .finally(() => {
      process.exit = origExit;
      console.error = origError;
      console.log = origLog;
    });
}

test('refused: report --status=done with neither PR evidence nor a verify command', async () => {
  await withStubbedExit(async (h) => {
    mockFetch({ issue: { description: 'Fixed the thing, looks good.' }, updateShouldBeCalled: false });
    await assert.rejects(
      () => cmdReport({ issue: 'BRO-9458', status: 'done', summary: 'did the work' }),
      /EXIT/
    );
    assert.equal(h.getExitCode(), 5);
    assert.match(h.getErrors(), /REFUSED \(no-done-evidence\)/);
    // The outcome comment still posts (the marker is still printed) — only
    // the state move is refused.
    assert.match(h.getLogs(), /__LINEAR_ISSUE_ID__=issue-uuid-457b/);
    assert.match(h.getLogs(), /"doneGateRefused":true/);
  });
});

test('allowed: a safe-form verify command in the issue description', async () => {
  await withStubbedExit(async (h) => {
    mockFetch({
      issue: { description: '## Acceptance criteria\n- `node --test tests/unit/done-semantics-gate.test.mjs` passes' },
      updateShouldBeCalled: true,
    });
    await cmdReport({ issue: 'BRO-9458', status: 'done', summary: 'did the work' });
    assert.match(h.getLogs(), /"doneGateRefused":false/);
    assert.match(h.getLogs(), /"stateName":"Done"/);
  });
});

test('allowed: PR-EVIDENCE recorded in a past comment (not the description or this report)', async () => {
  await withStubbedExit(async (h) => {
    mockFetch({
      issue: {
        description: 'Fixed the thing, looks good.',
        commentBodies: ['PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/pull/1001)'],
      },
      updateShouldBeCalled: true,
    });
    await cmdReport({ issue: 'BRO-9458', status: 'done', summary: 'did the work' });
    assert.match(h.getLogs(), /"doneGateRefused":false/);
  });
});

test('not gated: report --status=in-review never consults the gate even with zero evidence', async () => {
  await withStubbedExit(async (h) => {
    mockFetch({ issue: { description: 'Fixed the thing, looks good.' }, updateShouldBeCalled: true });
    await cmdReport({ issue: 'BRO-9458', status: 'in-review', summary: 'did the work' });
    assert.match(h.getLogs(), /"stateName":"In Review"/);
  });
});

test('--force with a reason ≥10 chars bypasses the gate', async () => {
  await withStubbedExit(async (h) => {
    mockFetch({ issue: { description: 'Fixed the thing, looks good.' }, updateShouldBeCalled: true });
    await cmdReport({ issue: 'BRO-9458', status: 'done', summary: 'did the work', force: 'owner said ship it now' });
    assert.match(h.getLogs(), /"doneGateRefused":false/);
  });
});

test('LINEAR_DONE_GATE_DISABLED=1 bypasses the gate for automation', async () => {
  await withStubbedExit(async (h) => {
    process.env.LINEAR_DONE_GATE_DISABLED = '1';
    try {
      mockFetch({ issue: { description: 'Fixed the thing, looks good.' }, updateShouldBeCalled: true });
      await cmdReport({ issue: 'BRO-9458', status: 'done', summary: 'did the work' });
      assert.match(h.getLogs(), /"doneGateRefused":false/);
    } finally {
      delete process.env.LINEAR_DONE_GATE_DISABLED;
    }
  });
});
