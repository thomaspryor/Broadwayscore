// Tests scripts/linear-brain.js's `update --state <Done-type>` path wired to
// scripts/lib/linear-done-gate.js / done-semantics-gate.js (BRO-457).
// done-semantics-gate.js's evaluateDoneTransition() was built and unit-tested
// in BRO-379 but had zero callers — this proves it's now actually enforced at
// the one place a Linear issue's state moves to a completed-type state.
//
// Driven end-to-end IN A REAL SUBPROCESS, not an in-process call with
// process.exit stubbed to throw: the refusal's process.exit(5) sits inside
// the same `try { ... } catch (err) { ...; process.exit(2); }` that wraps the
// whole update body (pre-existing shape — the "unknown state name" exit(1)
// a few lines above it has the identical nesting), so a throwing stub would
// be caught by that same catch and re-exit(2), masking the real refusal
// code. tests/unit/linear-next.test.mjs's "guard parity" test documents this
// exact class of problem and uses the same real-subprocess fix. No
// LINEAR_API_KEY, no live Linear call — getIssue/getTeam/updateIssue/
// createComment are all injected via main()'s `deps` param.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEAM_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
];

function makeIssue(description, commentBodies = []) {
  return {
    id: 'issue-uuid-457',
    identifier: 'BRO-9457',
    title: 'Fixture issue for the done-semantics gate',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-9457/fixture',
    description,
    state: { id: 'state-progress', name: 'In Progress', type: 'started' },
    // getIssue()'s real query already fetches comments(first: 20) — this
    // fixture matches that shape so the gate's existingComments read is
    // exercised, not just its description/commentText reads.
    comments: { nodes: commentBodies.map((body, i) => ({ id: `c${i}`, body, createdAt: null, user: null })) },
  };
}

// Builds a runnable fixture script that requires the real linear-brain.js,
// injects stub I/O via main()'s deps param, and calls it with the given argv.
function runUpdate({ argv, description, comments = [], updateShouldBeCalled }) {
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue(description, comments))};
    main(${JSON.stringify(argv)}, {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      updateIssue: async () => {
        ${updateShouldBeCalled ? "console.error('UPDATE_ISSUE_CALLED');" : "throw new Error('updateIssue must not be called — the gate refused before any write');"}
      },
      createComment: async () => {
        ${updateShouldBeCalled ? "console.error('CREATE_COMMENT_CALLED');" : "throw new Error('createComment must not be called — the gate refused before any write');"}
      },
    });
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
}

test('refused: moving to a completed-type state with neither PR evidence nor a verify command', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: false,
  });
  assert.equal(res.status, 5, `expected exit 5 (done-gate refusal), got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(no-done-evidence\)/);
  assert.match(res.stderr, /no PR reference recorded/);
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/, 'updateIssue must never run once the gate refuses');
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('allowed: a safe-form verify command in the acceptance criteria', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: '## Acceptance criteria\n- `node --test tests/unit/done-semantics-gate.test.mjs` passes',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('allowed: a PR-EVIDENCE marker recording merged+deployed+checked', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/pull/999)',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('allowed: PR-EVIDENCE arrives via the --comment posted in the same call, not the description', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done', '--comment', 'PR-EVIDENCE: merged deployed checked'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.match(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('allowed: PR-EVIDENCE recorded in a PAST comment (no --comment on this call) — getIssue()\'s comments(first: 20) read must be consulted, not just description', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'Fixed the thing, looks good.',
    comments: ['Started work.', 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/pull/1000)'],
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('refused: a PR-EVIDENCE marker present but only partially true (not deployed)', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'PR-EVIDENCE: merged',
    updateShouldBeCalled: false,
  });
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /not merged\+deployed\+checked/);
  assert.match(res.stderr, /deployed=false/);
});

test('not gated: moving to a non-completed state (In Progress) never consults the gate', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'In Progress'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('--force with a reason ≥10 chars bypasses the gate', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done', '--force', 'owner said ship it now'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('LINEAR_DONE_GATE_DISABLED=1 bypasses the gate for automation', () => {
  const script = `
    process.env.LINEAR_DONE_GATE_DISABLED = '1';
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue('Fixed the thing, looks good.'))};
    main(['update', 'BRO-9457', '--state', 'Done'], {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      createComment: async () => {},
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});
