// Tests scripts/lib/linear-issue-create.js's pure state-selection and
// usage-limit-detection logic, plus the module's dispatch-gate wiring — no
// live Linear API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// BRO-2664: recordCreated() appends to the intake ledger. Point it at a temp
// file BEFORE the first require, so no test touches data/audit.
{
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-ledger-'));
  process.env.INTAKE_LEDGER_PATH = path.join(dir, 'intake-ledger.jsonl');
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const { createLinearIssue, pickStateForMode, isUsageLimitExceeded } = require('./linear-issue-create.js');

const STATES = [
  { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
  { id: 'todo-1', name: 'Todo', type: 'unstarted' },
  { id: 'progress-1', name: 'In Progress', type: 'started' },
  { id: 'done-1', name: 'Done', type: 'completed' },
];

test('the intake ledger is redirected away from data/audit (BRO-2664)', () => {
  const { LEDGER_PATH } = require('./intake-breaker.js');
  assert.equal(LEDGER_PATH, process.env.INTAKE_LEDGER_PATH);
  assert.ok(!/[\\/]data[\\/]audit[\\/]/.test(LEDGER_PATH));
});

test('pickStateForMode park: picks the backlog-type state', () => {
  const state = pickStateForMode(STATES, 'park');
  assert.equal(state.type, 'backlog');
});

test('pickStateForMode park: falls back to unstarted when no backlog state exists', () => {
  const noBacklog = STATES.filter((s) => s.type !== 'backlog');
  const state = pickStateForMode(noBacklog, 'park');
  assert.equal(state.type, 'unstarted');
});

test('pickStateForMode park: throws a clear error when neither backlog nor unstarted exists', () => {
  const onlyStarted = STATES.filter((s) => s.type === 'started' || s.type === 'completed');
  assert.throws(() => pickStateForMode(onlyStarted, 'park'), /backlog.*unstarted/);
});

test("pickStateForMode dispatch: picks the unstarted-type state, never 'started'", () => {
  const state = pickStateForMode(STATES, 'dispatch');
  assert.equal(state.type, 'unstarted');
});

test('pickStateForMode dispatch: throws when no unstarted state exists', () => {
  const noUnstarted = STATES.filter((s) => s.type !== 'unstarted');
  assert.throws(() => pickStateForMode(noUnstarted, 'dispatch'), /unstarted/);
});

test('isUsageLimitExceeded: true when linearErrors carries the extensions.code', () => {
  const err = new Error('Linear GraphQL error: nope');
  err.linearErrors = [{ message: 'nope', extensions: { code: 'USAGE_LIMIT_EXCEEDED' } }];
  assert.equal(isUsageLimitExceeded(err), true);
});

test('isUsageLimitExceeded: true when only the message text carries it', () => {
  const err = new Error('Linear GraphQL error: USAGE_LIMIT_EXCEEDED — issue cap reached');
  assert.equal(isUsageLimitExceeded(err), true);
});

test('isUsageLimitExceeded: false for an unrelated error', () => {
  const err = new Error('Linear GraphQL error: Team BRO not found');
  assert.equal(isUsageLimitExceeded(err), false);
});

test('createLinearIssue: rejects with the disposition message when neither flag is given', async () => {
  await assert.rejects(
    () => createLinearIssue({ title: 'x', description: 'y' }),
    (err) => {
      assert.match(err.message, /--dispatch/);
      assert.match(err.message, /--park/);
      return true;
    }
  );
});

test('createLinearIssue: rejects immediately on bad disposition, never calls the Linear client', async () => {
  // No linear-client mocking needed here — a real getTeam() call would throw
  // on a missing LINEAR_API_KEY in this test environment, which would make a
  // false pass indistinguishable from disposition-gate-then-network-call.
  // Asserting the specific dispositionReason instead proves the gate ran
  // FIRST, before any client method was touched.
  try {
    await createLinearIssue({ title: 'x', description: 'y', dispatch: true, park: 'also set' });
    assert.fail('expected rejection');
  } catch (err) {
    assert.equal(err.dispositionReason, 'BOTH_FLAGS');
  }
});

// BRO-4487: a parked issue is never filed as Urgent/High. Nothing dispatches a
// PARKED: card, and CLAUDE.md requires P0/P1 to be dispatched at creation.
const { effectiveCreatePriority, priorityFromTitle, PARKED_MAX_PRIORITY, DEFAULT_CREATE_PRIORITY } = require('./linear-issue-create.js');

test('effectiveCreatePriority: parked High and Urgent are clamped to Medium', () => {
  assert.equal(PARKED_MAX_PRIORITY, 3);
  assert.deepEqual(effectiveCreatePriority({ priority: 2, mode: 'park', title: 'x' }), { priority: 3, clamped: true });
  assert.deepEqual(effectiveCreatePriority({ priority: 1, mode: 'park', title: 'x' }), { priority: 3, clamped: true });
  assert.deepEqual(effectiveCreatePriority({ priority: '2', mode: 'park', title: 'x' }), { priority: 3, clamped: true }, 'a numeric string is still High');
});

test('effectiveCreatePriority: dispatched issues keep the priority they asked for', () => {
  assert.deepEqual(effectiveCreatePriority({ priority: 1, mode: 'dispatch', title: 'P0: x' }), { priority: 1, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: 2, mode: 'dispatch', title: 'x' }), { priority: 2, clamped: false });
});

test('effectiveCreatePriority: an unset priority with a P0:/P1: title prefix is pinned to Medium when parked', () => {
  // priorityOf() reads the title when the field is unset, so leaving it unset
  // would let the prefix re-promote the card to P1.
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'park', title: 'P1: x' }), { priority: 3, clamped: true });
  assert.deepEqual(effectiveCreatePriority({ priority: 0, mode: 'park', title: 'P0: x' }), { priority: 3, clamped: true });
});

test('effectiveCreatePriority: parked Medium/Low issues are left alone', () => {
  assert.deepEqual(effectiveCreatePriority({ priority: 3, mode: 'park', title: 'P1: x' }), { priority: 3, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: 4, mode: 'park', title: 'x' }), { priority: 4, clamped: false });
});

test('effectiveCreatePriority: a parked card with no priority and no prefix is filed at Medium, not No priority', () => {
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'park', title: 'x' }), { priority: 3, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'park', title: 'P2: x' }), { priority: 3, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'park', title: 'P3: x' }), { priority: 4, clamped: false });
});

// 2026-10-11: 341 of 993 open cards had no priority; the cloud worker reads
// only the field, so an unset dispatched "P1: ..." card was never picked.
test('effectiveCreatePriority: an unset priority takes the P0-P3 title prefix', () => {
  const cases = [['P0: x', 1], ['P1: x', 2], ['P2: x', 3], ['P3: x', 4], ['  P1 fix it', 2]];
  for (const [title, want] of cases) {
    assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'dispatch', title }), { priority: want, clamped: false }, title);
  }
  assert.deepEqual(effectiveCreatePriority({ priority: 0, mode: 'dispatch', title: 'P1: x' }), { priority: 2, clamped: false }, '0 is Linear "No priority", i.e. unset');
  assert.deepEqual(effectiveCreatePriority({ priority: null, mode: 'dispatch', title: 'P0: x' }), { priority: 1, clamped: false });
  assert.equal(priorityFromTitle('P10: x'), null, 'P10 is not a P1 prefix');
  assert.equal(priorityFromTitle('Fix P1: x'), null, 'prefix only, never mid-title');
  assert.equal(priorityFromTitle('P4: x'), null);
});

test('effectiveCreatePriority: no priority and no prefix defaults to Medium', () => {
  assert.equal(DEFAULT_CREATE_PRIORITY, 3);
  for (const priority of [undefined, null, '', 0, 'abc']) {
    assert.deepEqual(effectiveCreatePriority({ priority, mode: 'dispatch', title: 'Fix the thing' }), { priority: 3, clamped: false }, String(priority));
  }
  assert.deepEqual(effectiveCreatePriority({ priority: undefined, mode: 'dispatch', title: '' }), { priority: 3, clamped: false });
});

test('effectiveCreatePriority: an explicit caller priority wins over the title prefix', () => {
  assert.deepEqual(effectiveCreatePriority({ priority: 4, mode: 'dispatch', title: 'P0: x' }), { priority: 4, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: 1, mode: 'dispatch', title: 'P3: x' }), { priority: 1, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: '2', mode: 'dispatch', title: 'x' }), { priority: 2, clamped: false });
  assert.deepEqual(effectiveCreatePriority({ priority: 4, mode: 'park', title: 'P0: x' }), { priority: 4, clamped: false }, 'parked explicit Low stays Low');
});

test('createLinearIssue: a dispatched "P1:" card with no priority reaches the Linear client at High', async () => {
  const fs = require('fs');
  const linearClient = require('./linear-client.js');
  const { LEDGER_PATH } = require('./intake-breaker.js');
  const title = `P1: card-default-priority-test-${process.pid}-${Date.now()}`;
  const realGetTeam = linearClient.getTeam;
  linearClient.getTeam = async () => ({ id: 'team-1', states: { nodes: STATES } });
  const sent = [];
  try {
    const client = { createIssue: async (input) => { sent.push(input); return { identifier: 'BRO-0', id: 'i' }; } };
    await createLinearIssue({ title, description: 'body', dispatch: true, client });
    await createLinearIssue({ title: `${title} no-prefix`.slice(4), description: 'body', dispatch: true, client });
  } finally {
    linearClient.getTeam = realGetTeam;
    if (fs.existsSync(LEDGER_PATH)) {
      const tag = title.slice(4);
      const kept = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((line) => !line.includes(tag));
      fs.writeFileSync(LEDGER_PATH, kept.join('\n'));
    }
  }
  assert.equal(sent[0].priority, 2);
  assert.doesNotMatch(sent[0].description, /PARKED/);
  assert.equal(sent[1].priority, 3, 'no prefix, no priority: Medium');
});

test('createLinearIssue: a parked High issue reaches the Linear client at Medium with a note', async () => {
  const fs = require('fs');
  const linearClient = require('./linear-client.js');
  const { LEDGER_PATH } = require('./intake-breaker.js');
  const title = `bro-4487-clamp-test-${process.pid}-${Date.now()}`;
  const realGetTeam = linearClient.getTeam;
  linearClient.getTeam = async () => ({ id: 'team-1', states: { nodes: STATES } });
  let sent = null;
  try {
    const client = { createIssue: async (input) => { sent = input; return { identifier: 'BRO-0', id: 'i' }; } };
    await createLinearIssue({ title, description: 'body', park: 'auto-filed parked for triage', priority: 2, client });
  } finally {
    linearClient.getTeam = realGetTeam;
    // recordCreated() appends to the real intake ledger; remove only this
    // test's own row (BRO-2656), never a whole-file restore that could drop a
    // concurrent real filer's row.
    if (fs.existsSync(LEDGER_PATH)) {
      const kept = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((line) => !line.includes(title));
      fs.writeFileSync(LEDGER_PATH, kept.join('\n'));
    }
  }
  assert.equal(sent.priority, 3);
  assert.equal(sent.stateId, 'backlog-1');
  assert.match(sent.description, /^PARKED: /);
  assert.match(sent.description, /filed at Medium because it is parked/);
});

test('createLinearIssue: model stamps a Model: line the dispatcher reads; a conflict is refused before any API call', async () => {
  const fs = require('fs');
  const linearClient = require('./linear-client.js');
  const { LEDGER_PATH } = require('./intake-breaker.js');
  const { explicitModelHint } = require('./bsc-next-model.js');
  const title = `bro-4535-model-test-${process.pid}-${Date.now()}`;
  const realGetTeam = linearClient.getTeam;
  let teamCalls = 0;
  linearClient.getTeam = async () => { teamCalls += 1; return { id: 'team-1', states: { nodes: STATES } }; };
  let sent = null;
  try {
    const client = { createIssue: async (input) => { sent = input; return { identifier: 'BRO-0', id: 'i' }; } };
    await createLinearIssue({ title, description: 'body', park: 'needs triage', priority: 3, model: 'opus', client });
    assert.match(sent.description, /\n\nModel: Opus\n\nFiled by: /);
    assert.equal(explicitModelHint({ description: sent.description }, null), 'opus');
    teamCalls = 0;
    sent = null;
    await assert.rejects(
      createLinearIssue({ title: `${title}-b`, description: 'Model: Sonnet', park: 'needs triage first', model: 'opus', client }),
      /conflicts with --model opus/,
    );
    assert.equal(teamCalls, 0);
    assert.equal(sent, null);
  } finally {
    linearClient.getTeam = realGetTeam;
    if (fs.existsSync(LEDGER_PATH)) {
      const kept = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((line) => !line.includes(title));
      fs.writeFileSync(LEDGER_PATH, kept.join('\n'));
    }
  }
});

test('createLinearIssue: a card whose exact title is already open is noted there, not filed again (BRO-4956)', async () => {
  const { createLinearIssue } = require('./linear-issue-create.js');
  const calls = { create: 0, comments: [] };
  const twin = { id: 'u1', identifier: 'BRO-77', title: 'Dispatch watchdog is down', url: 'https://x', state: { name: 'Backlog', type: 'backlog' } };
  const client = {
    findOpenIssueByTitle: async (t) => (t.toLowerCase() === 'dispatch watchdog is down' ? twin : null),
    addComment: async (id, body) => { calls.comments.push([id, body]); },
    createIssue: async () => { calls.create++; return { identifier: 'BRO-0', id: 'i' }; },
  };
  const r = await createLinearIssue({ title: 'Dispatch watchdog is down', description: 'second sighting', park: 'auto-filed parked for triage', client, reuseTwin: true });
  assert.equal(r.mode, 'reused');
  assert.equal(r.issue.identifier, 'BRO-77');
  assert.equal(calls.create, 0);
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0][1], /second sighting/);
});

test('createLinearIssue: a failing twin lookup never blocks filing', async () => {
  const { reuseOpenTwin } = require('./linear-issue-create.js');
  const r = await reuseOpenTwin({ title: 't', body: '', client: { findOpenIssueByTitle: async () => { throw new Error('network'); } } });
  assert.equal(r, null);
});

test('twin reuse: never a started card, a parked twin only for a parked request, and only when asked (BRO-4956 review)', async () => {
  const { twinServes, createLinearIssue } = require('./linear-issue-create.js');
  assert.equal(twinServes({ state: { type: 'started' } }, 'park'), false);
  assert.equal(twinServes({ state: { type: 'backlog' } }, 'dispatch'), false);
  assert.equal(twinServes({ state: { type: 'backlog' } }, 'park'), true);
  assert.equal(twinServes({ state: { type: 'unstarted' } }, 'dispatch'), true);
  const linearClient = require('./linear-client.js');
  const realGetTeam = linearClient.getTeam;
  linearClient.getTeam = async () => ({ id: 'team-1', states: { nodes: [{ id: 's1', name: 'Backlog', type: 'backlog' }, { id: 's2', name: 'Todo', type: 'unstarted' }] } });
  try {
    let created = 0;
    const client = { findOpenIssueByTitle: async () => ({ id: 'u', identifier: 'BRO-9', state: { type: 'backlog' } }), addComment: async () => {}, createIssue: async () => { created++; return { identifier: 'BRO-10', id: 'n' }; } };
    const r = await createLinearIssue({ title: 'x', description: 'y', park: 'auto-filed parked for triage', client });
    assert.equal(r.issue.identifier, 'BRO-10', 'no reuse unless asked (alert router, digest-autofix)');
    assert.equal(created, 1);
  } finally { linearClient.getTeam = realGetTeam; }
});

// ---- BRO-5488: near-duplicate, flood rollup, source footer ----
function withTeam(fn) {
  const linearClient = require('./linear-client.js');
  const real = linearClient.getTeam;
  linearClient.getTeam = async () => ({ id: 'team-1', states: { nodes: STATES } });
  return fn().finally(() => { linearClient.getTeam = real; });
}

function fakeBoard({ open = [], recent = [] } = {}) {
  const board = { open: [...open], recent: [...recent], comments: [], created: [] };
  board.client = {
    findOpenIssueByTitle: async (t) => board.open.find((c) => c.title.toLowerCase() === String(t).toLowerCase()) || null,
    listOpenIssueTitles: async () => board.open,
    listRecentIssues: async () => board.recent,
    addComment: async (id, body) => { board.comments.push({ id, body }); },
    createIssue: async (input) => {
      const n = board.created.length + 1;
      const issue = { id: `new-${n}`, identifier: `BRO-N${n}`, title: input.title, description: input.description, createdAt: new Date().toISOString(), state: { name: 'Backlog', type: 'backlog' } };
      board.created.push(issue); board.open.push(issue); board.recent.push(issue);
      return issue;
    },
  };
  return board;
}

test('BRO-5488: a reworded near-duplicate returns the open card, noted there, nothing filed', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Backlog', type: 'backlog' } }] });
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'today', park: 'auto-filed parked for triage', client: board.client, reuseTwin: true, nearDuplicate: true, source: 'session' });
  assert.equal(r.mode, 'reused');
  assert.equal(r.issue.identifier, 'BRO-100');
  assert.ok(r.nearDuplicate.score >= 0.85);
  assert.equal(board.created.length, 0);
  assert.match(board.comments[0].body, /^Filed again on .*near-duplicate/);
}));

test('BRO-5488: a genuinely new title still files, stamped with its source', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'Review gap — "The Wiz" missing 6 cited review(s)', state: { name: 'Backlog', type: 'backlog' } }] });
  const r = await createLinearIssue({ title: 'Review gap — "Tru" missing 3 cited review(s)', description: 'body', park: 'auto-filed parked for triage', client: board.client, nearDuplicate: true, source: 'session' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
  assert.match(board.created[0].description, /\n\nFiled by: session \(kind: review gap missing cited\)$/);
}));

test('BRO-5488: near-dup is opt-in and never applies to alert-router / digest-autofix bodies', () => withTeam(async () => {
  const open = [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Todo', type: 'unstarted' } }];
  const a = fakeBoard({ open });
  await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'auto-filed parked for triage', client: a.client });
  assert.equal(a.created.length, 1, 'not opted in: files');
  const b = fakeBoard({ open });
  await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'Auto-filed by digest-autofix (health row)', park: 'auto-filed parked for triage', client: b.client, nearDuplicate: true, rollup: true });
  assert.equal(b.created.length, 1, 'per-card contract: files');
  assert.match(b.created[0].description, /Filed by: digest-autofix/);
}));

test('BRO-5488: N same-kind workflow filings in 24h become 1 rollup card', () => withTeam(async () => {
  const board = fakeBoard();
  const shows = ['Fish', 'Triumph', 'The Ask', 'Midnight', 'Torera', 'Soon'];
  const results = [];
  for (const s of shows) {
    results.push(await createLinearIssue({ title: `${s}: 2 roundup-listed review(s) still not captured`, description: `finding for ${s}`, park: 'daily audit finding for triage', client: board.client, nearDuplicate: true, rollup: true, source: 'workflow:Audit' }));
  }
  const individual = board.created.filter((c) => !c.title.startsWith('Rollup ('));
  const rollups = board.created.filter((c) => c.title.startsWith('Rollup ('));
  assert.equal(individual.length, 3, 'first 3 file normally');
  assert.equal(rollups.length, 1, 'one rollup card, never one per filing');
  assert.equal(rollups[0].title, 'Rollup (workflow:Audit): roundup listed review captured');
  assert.deepEqual(results.slice(3).map((r) => r.mode), ['rolled-up', 'rolled-up', 'rolled-up']);
  assert.ok(results.slice(3).every((r) => r.issue.identifier === rollups[0].identifier));
  assert.equal(board.comments.filter((c) => c.id === rollups[0].id).length, 3);
  assert.match(rollups[0].description, /Filed by: rollup/);
}));

test('BRO-5488: a flood from the alert router is never rolled up (it keys state on its own card)', () => withTeam(async () => {
  const board = fakeBoard();
  for (const s of ['A', 'B', 'C', 'D', 'E']) {
    await createLinearIssue({ title: `Review gap — "${s}" missing 1 cited review(s)`, description: 'Auto-filed by owner-alert-router (condition: x)', park: 'Auto-filed by owner-alert-router (condition: x)', client: board.client, nearDuplicate: true, rollup: true, source: 'workflow:Audit' });
  }
  assert.equal(board.created.length, 5);
}));

test('BRO-5488: lookup failures fail open (file the card)', () => withTeam(async () => {
  const board = fakeBoard();
  board.client.listOpenIssueTitles = async () => { throw new Error('network'); };
  board.client.listRecentIssues = async () => { throw new Error('network'); };
  const r = await createLinearIssue({ title: 'Something new broke in the pipeline', description: 'x', park: 'auto-filed parked for triage', client: board.client, nearDuplicate: true, rollup: true, source: 'workflow:X' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
}));

// Ship-check findings (BRO-5488 review).
test('BRO-5488: digest-autofix (marker only in the park reason) is never handed a near-duplicate', () => withTeam(async () => {
  const { AUTOFIX_FILED_MARKER } = require('./autofix-filed-marker.js');
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'Rebuild dropped 41 reviews on the show pages', state: { name: 'Backlog', type: 'backlog' } }] });
  const r = await createLinearIssue({ title: 'Rebuild dropped 49 reviews on the show pages', description: 'raw notes, no marker', park: `${AUTOFIX_FILED_MARKER}; runAutofix dispatches`, client: board.client, nearDuplicate: true, rollup: true, source: 'workflow:Daily Digest' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
}));

test('BRO-5488: a --dispatch filing never gets a near-duplicate card (park mode only)', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Todo', type: 'unstarted' } }] });
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', dispatch: true, client: board.client, nearDuplicate: true, source: 'session' });
  assert.notEqual(r.mode, 'reused');
  assert.equal(board.created.length, 1);
}));

test('BRO-5488: a failed note files the card instead of losing the finding', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Backlog', type: 'backlog' } }] });
  board.client.addComment = async () => { throw new Error('comment API down'); };
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'auto-filed parked for triage', client: board.client, nearDuplicate: true, source: 'session' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
}));

test('BRO-5488: a workflow name with parentheses still round-trips through the footer', () => withTeam(async () => {
  const d = require('./card-dedupe.js');
  const board = fakeBoard();
  await createLinearIssue({ title: 'Some new finding about the site', description: 'b', park: 'auto-filed parked for triage', client: board.client, source: 'workflow:Daily Digest (score drift)' });
  const f = d.parseSourceFooter(board.created[0].description);
  assert.equal(f.source, 'workflow:Daily-Digest-score-drift');
}));
