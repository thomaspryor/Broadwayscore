// Tests scripts/linear-brain.js's `update --state <Duplicate-type>` path wired
// to scripts/lib/linear-duplicate-gate.js (crown BRO-343, 2026-09-05).
//
// THE INCIDENT: `update BRO-2711 --state Duplicate --comment "<long writeup>"`
// posted the comment, then died on Linear's `missing duplicate relation`
// error, printing "partially applied before the error: comment posted" and
// exiting 2. The card stayed open. An operator reading exit 2 as "nothing
// happened" re-runs and double-posts. The gate must refuse BEFORE the first
// write, and --duplicate-of must create the relation ahead of the comment.
//
// Driven end-to-end IN A REAL SUBPROCESS for the same reason
// tests/unit/linear-brain-done-gate.test.mjs is: the refusal's process.exit(6)
// sits inside the update body's own try/catch, so an in-process stub that
// throws would be caught and re-exit(2), masking the real refusal code.
// No LINEAR_API_KEY and no live call — every I/O seam is injected via main()'s
// `deps` param.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEAM_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
  { id: 'state-dup', name: 'Duplicate', type: 'duplicate' },
];

function makeIssue(relations) {
  return {
    id: 'issue-uuid-2711',
    identifier: 'BRO-9711',
    title: 'Fixture issue for the duplicate gate',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-9711/fixture',
    description: 'Some defect that turned out to be already fixed elsewhere.',
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
    comments: { nodes: [] },
    relations,
  };
}

const CANONICAL = {
  id: 'issue-uuid-2823',
  identifier: 'BRO-9823',
  title: 'The canonical issue',
  url: 'https://linear.app/broadway-scorecard/issue/BRO-9823/canonical',
  description: '',
  state: { id: 'state-done', name: 'Done', type: 'completed' },
  comments: { nodes: [] },
  relations: { nodes: [] },
};

// Builds a fixture that requires the real linear-brain.js and injects stub
// I/O. Every seam announces itself on stderr so the test can assert on the
// ORDER of the writes, not merely that they happened.
function runUpdate({ argv, relations, canonicalFound = true, writesExpected }) {
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue(relations))};
    const canonical = ${canonicalFound ? JSON.stringify(CANONICAL) : 'null'};
    main(${JSON.stringify(argv)}, {
      getIssue: async (ref) => (ref === 'BRO-9823' ? canonical : issue),
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      createIssueRelation: async (a, b, t) => {
        ${writesExpected
          ? "console.error('RELATION_CREATED ' + a + ' -> ' + b + ' as ' + t);"
          : "throw new Error('createIssueRelation must not be called — the gate refused before any write');"}
      },
      createComment: async () => {
        ${writesExpected
          ? "console.error('CREATE_COMMENT_CALLED');"
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

test('refused (exit 6) with NOTHING written: --state Duplicate on an issue with no duplicate relation', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate', '--comment', 'Closing as a duplicate.'],
    relations: { nodes: [] },
    writesExpected: false,
  });
  assert.equal(res.status, 6, `expected exit 6 (duplicate-gate refusal), got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(no-duplicate-relation\)/);
  assert.match(res.stderr, /missing duplicate relation/);
  // The whole point: the comment must NOT have landed ahead of the refusal.
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/, 'the comment must never post once the gate refuses');
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /partially applied/, 'a pre-write refusal must not report a partial write');
  // And it must tell the operator how to succeed, not just that it failed.
  assert.match(res.stderr, /--duplicate-of <BRO-N>/);
});

test('allowed: an issue that already owns a duplicate relation moves with no relation write', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate'],
    relations: { nodes: [{ type: 'duplicate', relatedIssue: { id: 'issue-uuid-2823', identifier: 'BRO-9823' } }] },
    writesExpected: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /RELATION_CREATED/, 'an existing relation must not be duplicated');
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('--duplicate-of creates the relation BEFORE the comment and the state move', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate', '--duplicate-of', 'BRO-9823', '--comment', 'Dupe of BRO-9823.'],
    relations: { nodes: [] },
    writesExpected: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /RELATION_CREATED issue-uuid-2711 -> issue-uuid-2823 as duplicate/);
  const order = ['RELATION_CREATED', 'CREATE_COMMENT_CALLED', 'UPDATE_ISSUE_CALLED'].map((m) => res.stderr.indexOf(m));
  assert.ok(order.every((i) => i >= 0), `all three writes must run. stderr:\n${res.stderr}`);
  assert.ok(order[0] < order[1] && order[1] < order[2], `write order must be relation -> comment -> state, got ${order}`);
});

test('--duplicate-of naming an issue that does not exist fails with nothing written', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate', '--duplicate-of', 'BRO-9823', '--comment', 'x'],
    relations: { nodes: [] },
    canonicalFound: false,
    writesExpected: false,
  });
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /--duplicate-of: no such issue: BRO-9823/);
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('an issue cannot be marked a duplicate of itself', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate', '--duplicate-of', 'BRO-9711'],
    relations: { nodes: [] },
    writesExpected: false,
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /cannot be a duplicate of itself/);
});

test('not gated: a move to a non-duplicate state never consults the gate, even with no relations', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'In Progress'],
    relations: { nodes: [] },
    writesExpected: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('the Duplicate gate is keyed on state TYPE, not on the name "Duplicate"', () => {
  // A team rename must not silently stop gating — the same drift trap
  // linear-done-gate.js's header documents for "Done".
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue({ nodes: [] }))};
    main(['update','BRO-9711','--state','Superseded'], {
      getIssue: async () => issue,
      getTeam: async () => ({ states: [{ id: 'state-sup', name: 'Superseded', type: 'duplicate' }] }),
      createIssueRelation: async () => { throw new Error('no write expected'); },
      createComment: async () => { throw new Error('no write expected'); },
      updateIssue: async () => { throw new Error('no write expected'); },
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 6, `a renamed duplicate-type state must still gate. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /not moved to Superseded/);
});

test('buildIssueQuery actually fetches relations — the gate is inert without it', () => {
  // ABSENCE OF A SIGNAL LOOKS LIKE THE SAFE OUTCOME: if a future edit drops
  // `relations` from the query, every issue reads as having none and the gate
  // refuses every legitimate duplicate close instead of passing it. Assert the
  // read the gate depends on is really in the query the update path runs.
  const query = require('../../scripts/lib/linear-dispatch.js').buildIssueQuery();
  assert.match(query, /relations\(first: \d+\)/, 'buildIssueQuery must fetch relations');
  assert.match(query, /relatedIssue\s*\{[^}]*identifier/, 'relations must include relatedIssue.identifier');
});

// ── adversarial + fresh-eyes review findings, 2026-09-05 ───────────────────

test('refused (exit 6): --duplicate-of disagrees with the duplicate relation already on the issue', () => {
  // Before the fix this exited 0: the gate saw an existing relation, returned
  // allowed, and BRO-9823 was never created or even mentioned. The card kept
  // BRO-9010 and the operator had no way to tell from the output.
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate', '--duplicate-of', 'BRO-9823', '--comment', 'x'],
    relations: { nodes: [{ type: 'duplicate', relatedIssue: { id: 'uuid-9010', identifier: 'BRO-9010' } }] },
    writesExpected: false,
  });
  assert.equal(res.status, 6, `expected exit 6, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(duplicate-target-mismatch\)/);
  assert.match(res.stderr, /BRO-9010/);
  assert.match(res.stderr, /BRO-9823/);
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/);
  // The fill-in-the-blank command is for the MISSING-relation case only;
  // echoing a <BRO-N> placeholder here reads as if the flag were absent.
  assert.doesNotMatch(res.stderr, /--duplicate-of <BRO-N>/);
});

test('refused (exit 1): --duplicate-of on a NON-duplicate state move, instead of being silently ignored', () => {
  // `update BRO-1 --comment x --duplicate-of BRO-2` used to exit 0 having
  // posted only the comment, while the operator believed the flag applied.
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'In Progress', '--duplicate-of', 'BRO-9823'],
    relations: { nodes: [] },
    writesExpected: false,
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /--duplicate-of only applies to a move into a duplicate-type state/);
  assert.match(res.stderr, /started-type state/);
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('refused (exit 1): --duplicate-of with a comment but NO --state at all', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--comment', 'x', '--duplicate-of', 'BRO-9823'],
    relations: { nodes: [] },
    writesExpected: false,
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /No --state was given/);
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('an issue ALREADY in the duplicate state is not a transition — the comment still posts', () => {
  // The gate used to fire on any `--state Duplicate`, so re-commenting on a
  // card already sitting in Duplicate (legacy or externally-created data) was
  // refused and the comment suppressed. No state change is requested, so
  // there is nothing for Linear to validate.
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify({ ...makeIssue({ nodes: [] }), state: { id: 'state-dup', name: 'Duplicate', type: 'duplicate' } })};
    main(['update','BRO-9711','--state','Duplicate','--comment','still a dupe'], {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      createIssueRelation: async () => { console.error('RELATION_CREATED'); },
      createComment: async () => { console.error('CREATE_COMMENT_CALLED'); },
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /CREATE_COMMENT_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('LINEAR_DUPLICATE_GATE_DISABLED=1 restores the pre-gate behaviour', () => {
  // The gate encodes a server rule we OBSERVED, not one Linear documents. If
  // that rule ever relaxes, this kill switch (matching LINEAR_DONE_GATE_DISABLED)
  // is the rollback path that does not need a code change.
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue({ nodes: [] }))};
    main(['update','BRO-9711','--state','Duplicate'], {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      createIssueRelation: async () => { console.error('RELATION_CREATED'); },
      createComment: async () => { console.error('CREATE_COMMENT_CALLED'); },
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, LINEAR_DUPLICATE_GATE_DISABLED: '1' },
  });
  assert.equal(res.status, 0, `expected exit 0 with the gate disabled, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('the success JSON names the canonical twin, both when created and when pre-existing', () => {
  // Without this the operator cannot tell from the output whether the relation
  // — the part that makes the state move legal at all — actually happened.
  const created = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate', '--duplicate-of', 'BRO-9823'],
    relations: { nodes: [] },
    writesExpected: true,
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).duplicateOf, 'BRO-9823');

  const preexisting = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'Duplicate'],
    relations: { nodes: [{ type: 'duplicate', relatedIssue: { id: 'uuid-9823', identifier: 'BRO-9823' } }] },
    writesExpected: true,
  });
  assert.equal(preexisting.status, 0, preexisting.stderr);
  assert.equal(JSON.parse(preexisting.stdout).duplicateOf, 'BRO-9823');
});

test('a non-duplicate update does NOT carry a duplicateOf key at all', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9711', '--state', 'In Progress'],
    relations: { nodes: [] },
    writesExpected: true,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!('duplicateOf' in JSON.parse(res.stdout)), 'duplicateOf must be absent, not null');
});
