// Tests scripts/linear-brain.js's `update --state <Canceled-type>` path wired
// to scripts/lib/linear-cancel-gate.js, and the BRO-3435 bypass-ledger write
// on the Done-gate's --force / LINEAR_DONE_GATE_DISABLED paths.
//
// Driven end-to-end IN A REAL SUBPROCESS for the same reason
// tests/unit/linear-brain-duplicate-gate.test.mjs is: the refusal's
// process.exit(7) sits inside the update body's own try/catch, so an
// in-process stub that throws would be caught and re-exit(2), masking the
// real refusal code. No LINEAR_API_KEY and no live call — every I/O seam is
// injected via main()'s `deps` param.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEAM_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
];

function makeIssue(state) {
  return {
    id: 'issue-uuid-9435',
    identifier: 'BRO-9435',
    title: 'Fixture issue for the cancel gate',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-9435/fixture',
    description: 'Some card headed toward a state change.',
    state,
    comments: { nodes: [] },
    relations: { nodes: [] },
  };
}

// Builds a fixture that requires the real linear-brain.js and injects stub
// I/O, including a bypassRow spy so ledger-write assertions don't touch the
// real filesystem. Every seam announces itself on stderr.
function runUpdate({ argv, fromType = 'unstarted', writesExpected }) {
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue({ id: 'state-from', name: 'From', type: fromType }))};
    main(${JSON.stringify(argv)}, {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      appendBypassRow: (row) => { console.error('BYPASS_ROW ' + JSON.stringify(row)); },
      createComment: async (id, body) => {
        ${writesExpected
          ? "console.error('CREATE_COMMENT_CALLED ' + JSON.stringify(body));"
          : "throw new Error('createComment must not be called — the gate refused before any write');"}
      },
      updateIssue: async () => {
        ${writesExpected
          ? "console.error('UPDATE_ISSUE_CALLED');"
          : "throw new Error('updateIssue must not be called — the gate refused before any write');"}
      },
    });
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
}

test('refused (exit 7) with NOTHING written: --state Canceled with no --cancel-reason', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9435', '--state', 'Canceled'],
    writesExpected: false,
  });
  assert.equal(res.status, 7, `expected exit 7 (cancel-gate refusal), got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(no-cancel-reason\)/);
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/, 'nothing must post once the gate refuses');
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.match(res.stderr, /--cancel-reason "<at least 20 characters>"/);
});

test('refused (exit 7): --cancel-reason given but under the length floor', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9435', '--state', 'Canceled', '--cancel-reason', 'too short'],
    writesExpected: false,
  });
  assert.equal(res.status, 7);
  assert.match(res.stderr, /no-cancel-reason/);
});

test('allowed: a real cancel reason moves the state AND is posted as a comment (ship-check finding, 2026-09-21: it used to be silently discarded)', () => {
  const res = runUpdate({
    argv: [
      'update',
      'BRO-9435',
      '--state',
      'Canceled',
      '--cancel-reason',
      'Superseded by BRO-1 which covers the same fix.',
    ],
    writesExpected: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.match(res.stderr, /CREATE_COMMENT_CALLED/, 'the reason must actually land on the card, not just satisfy the gate');
  assert.match(res.stderr, /Superseded by BRO-1 which covers the same fix\./);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('the cancel reason is APPENDED to an explicit --comment, not replaced by it', () => {
  const res = runUpdate({
    argv: [
      'update',
      'BRO-9435',
      '--state',
      'Canceled',
      '--comment',
      'Closing out the sprint cleanup.',
      '--cancel-reason',
      'Superseded by BRO-1 which covers the same fix.',
    ],
    writesExpected: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  const body = res.stderr.match(/CREATE_COMMENT_CALLED (".*")/)[1];
  assert.match(body, /Closing out the sprint cleanup\./, 'the caller\'s own comment must survive');
  assert.match(body, /Superseded by BRO-1 which covers the same fix\./, 'the cancel reason must also land');
});

test('LINEAR_CANCEL_GATE_DISABLED=1 proceeds past the refusal and logs an env-disabled bypass row', () => {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const { main } = require('./scripts/linear-brain.js');
      const issue = ${JSON.stringify(makeIssue({ id: 'state-from', name: 'From', type: 'unstarted' }))};
      main(['update', 'BRO-9435', '--state', 'Canceled'], {
        getIssue: async () => issue,
        getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
        appendBypassRow: (row) => { console.error('BYPASS_ROW ' + JSON.stringify(row)); },
        updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      });
    `,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, LINEAR_CANCEL_GATE_DISABLED: '1' } }
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /LINEAR_CANCEL_GATE_DISABLED=1/);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  const row = JSON.parse(res.stderr.match(/BYPASS_ROW (\{.*\})/)[1]);
  assert.equal(row.gate, 'cancel');
  assert.equal(row.mechanism, 'env-disabled');
  assert.equal(row.identifier, 'BRO-9435');
});

test('a re-run on an issue ALREADY Canceled is not a real transition and the cancel gate does not fire (no --cancel-reason needed)', () => {
  // Matches the duplicate-gate's own "isRealTransition" precedent: no state
  // change requested means nothing for THIS gate to validate — it must not
  // demand --cancel-reason just because the target state's TYPE is canceled.
  // Unlike the duplicate-type no-op (which the real code special-cases to
  // skip the write entirely, per its own comment "scoped to duplicate-type
  // targets ON PURPOSE"), a canceled-type no-op still reaches the normal
  // updateIssue call, so that seam is stubbed too.
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const { main } = require('./scripts/linear-brain.js');
      const issue = ${JSON.stringify(makeIssue({ id: 'state-canceled', name: 'Canceled', type: 'canceled' }))};
      main(['update', 'BRO-9435', '--state', 'Canceled', '--comment', 'still canceled'], {
        getIssue: async () => issue,
        getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
        createComment: async () => { console.error('CREATE_COMMENT_CALLED'); },
        updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      });
    `,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 }
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /REFUSED/, 'the cancel gate must not demand a reason for a non-transition');
  assert.match(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('--cancel-reason on a non-canceled --state is refused (exit 1), matching the --duplicate-of precedent', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9435', '--state', 'Done', '--cancel-reason', 'this flag would do nothing here'],
    writesExpected: false,
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /--cancel-reason only applies to a move into a canceled-type state/);
});

test('the Done gate --force bypass logs a "force" row with the reason', () => {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const { main } = require('./scripts/linear-brain.js');
      const issue = ${JSON.stringify(makeIssue({ id: 'state-from', name: 'From', type: 'unstarted' }))};
      main(['update', 'BRO-9435', '--state', 'Done', '--force', 'manually verified in production'], {
        getIssue: async () => issue,
        getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
        appendBypassRow: (row) => { console.error('BYPASS_ROW ' + JSON.stringify(row)); },
        updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      });
    `,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 }
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  const row = JSON.parse(res.stderr.match(/BYPASS_ROW (\{.*\})/)[1]);
  assert.equal(row.gate, 'done');
  assert.equal(row.mechanism, 'force');
  assert.equal(row.reason, 'manually verified in production');
  assert.equal(row.identifier, 'BRO-9435');
});
