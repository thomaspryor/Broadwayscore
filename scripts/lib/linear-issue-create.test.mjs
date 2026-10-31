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

for (const [label, extra] of [['after', false], ['before', true]]) {
  test(`pickStateForMode park: plain Backlog wins over a Paused backlog-type state listed ${label} it (BRO-2857)`, () => {
    const paused = { id: 'paused-1', name: 'Paused', type: 'backlog' };
    const states = extra ? [paused, ...STATES] : [...STATES, paused];
    assert.equal(pickStateForMode(states, 'park').name, 'Backlog');
  });
}

test('pickStateForMode park: with Backlog renamed, a non-Paused backlog-type state still beats Paused', () => {
  const states = [
    { id: 'paused-1', name: 'Paused', type: 'backlog' },
    { id: 'ice-1', name: 'Icebox', type: 'backlog' },
    ...STATES.filter((s) => s.type !== 'backlog'),
  ];
  assert.equal(pickStateForMode(states, 'park').name, 'Icebox');
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
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'today', park: 'auto-filed parked for triage', client: board.client, source: 'session' });
  assert.equal(r.mode, 'reused');
  assert.equal(r.issue.identifier, 'BRO-100');
  assert.ok(r.nearDuplicate.score >= 0.85);
  assert.equal(board.created.length, 0);
  assert.match(board.comments[0].body, /^Filed again on .*near-duplicate/);
}));

test('BRO-5488: a genuinely new title still files, stamped with its source', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'Review gap — "The Wiz" missing 6 cited review(s)', state: { name: 'Backlog', type: 'backlog' } }] });
  const r = await createLinearIssue({ title: 'Review gap — "Tru" missing 3 cited review(s)', description: 'body', park: 'needs a budget decision on spend', client: board.client, source: 'session' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
  assert.match(board.created[0].description, /\n\nFiled by: session \(kind: review gap missing cited\)$/);
}));

test('BRO-5488: near-dup is ON by default; a named opt-out or a contract marker files', () => withTeam(async () => {
  const open = [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Backlog', type: 'backlog' } }];
  const a = fakeBoard({ open });
  const ra = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'auto-filed parked for triage', client: a.client });
  assert.equal(ra.mode, 'reused', 'default caller: noted on the open card');
  assert.equal(a.created.length, 0);
  const o = fakeBoard({ open });
  await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'auto-filed parked for triage', client: o.client, dedupeOptOut: 'alert-router' });
  assert.equal(o.created.length, 1, 'named opt-out: files');
  const n = fakeBoard({ open });
  await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'auto-filed parked for triage', client: n.client, newAnyway: 'different rebuild, different cause' });
  assert.equal(n.created.length, 1, '--new-anyway: files');
  const b = fakeBoard({ open });
  await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'Auto-filed by digest-autofix (health row)', park: 'auto-filed parked for triage', client: b.client });
  assert.equal(b.created.length, 1, 'per-card contract guard: files');
  assert.match(b.created[0].description, /Filed by: digest-autofix/);
}));

test('BRO-5488: an opt-out name not in DEDUPE_OPT_OUTS throws before any API call', () => withTeam(async () => {
  const board = fakeBoard();
  await assert.rejects(createLinearIssue({ title: 'Some finding about the site', description: 'x', park: 'auto-filed parked for triage', client: board.client, dedupeOptOut: 'my-new-filer' }), /DEDUPE_OPT_OUTS/);
  assert.equal(board.created.length, 0);
}));

test('BRO-5488: every dedupe opt-out in the repo is on the allowed list, and the list is exactly these', async () => {
  const { DEDUPE_OPT_OUTS } = require('./card-dedupe.js');
  // Adding a name here is a reviewed decision: the filer must group its own filings.
  assert.deepEqual(Object.keys(DEDUPE_OPT_OUTS).sort(), ['alert-router', 'auto-fix-first', 'digest-autofix', 'posthog-friction', 'press-night-digest', 'rollup', 'sentry-triage']);
  for (const reason of Object.values(DEDUPE_OPT_OUTS)) assert.ok(reason.length >= 30, 'each opt-out carries its reason');
  const fs = require('fs'); const path = require('path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const used = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'worktrees') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.((c|m)?js|ts|sh|ya?ml)$/.test(e.name) && !/\.test\./.test(e.name)) {
        const t = fs.readFileSync(f, 'utf8');
        const rel = path.relative(root, f);
        // Every mention outside the plumbing must be the literal form checked below,
        // so a computed name or a shorthand cannot slip past this list.
        if (!['scripts/lib/linear-issue-create.js', 'scripts/linear-brain.js', 'scripts/lib/card-dedupe.js'].includes(rel)) {
          const any = (t.match(/dedupeOptOut|dedupe-opt-out/g) || []).length;
          const lit = (t.match(/dedupeOptOut:\s*'[\w-]+'|'--dedupe-opt-out', '[\w-]+'|--dedupe-opt-out [\w-]+/g) || []).length;
          assert.equal(any, lit, `${rel}: write dedupe opt-outs as a literal name`);
          for (const m of t.matchAll(/dedupeOptOut:\s*['"]([^'"]+)['"]/g)) used.add(`${m[1]}\t${rel}`);
          for (const m of t.matchAll(/--dedupe-opt-out['"]?[,\s=]+['"]?([\w-]+)/g)) used.add(`${m[1]}\t${rel}`);
        }
      }
    }
  };
  for (const d of ['scripts', '.github', '.claude/hooks']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  for (const u of used) assert.ok(Object.prototype.hasOwnProperty.call(DEDUPE_OPT_OUTS, u.split('\t')[0]), `unlisted dedupe opt-out: ${u}`);
  assert.ok([...used].some((u) => u.startsWith('alert-router\t')) && [...used].some((u) => u.startsWith('digest-autofix\t')), 'router and digest-autofix opt out by name');
});

test('BRO-5488: N same-kind workflow filings in 24h become 1 rollup card', () => withTeam(async () => {
  const board = fakeBoard();
  const shows = ['Fish', 'Triumph', 'The Ask', 'Midnight', 'Torera', 'Soon'];
  const results = [];
  for (const s of shows) {
    results.push(await createLinearIssue({ title: `${s}: 2 roundup-listed review(s) still not captured`, description: `finding for ${s}`, park: 'daily audit finding for triage', client: board.client, source: 'workflow:Audit' }));
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
    await createLinearIssue({ title: `Review gap — "${s}" missing 1 cited review(s)`, description: 'Auto-filed by owner-alert-router (condition: x)', park: 'Auto-filed by owner-alert-router (condition: x)', client: board.client, source: 'workflow:Audit' });
  }
  assert.equal(board.created.length, 5);
}));

test('BRO-5488: lookup failures fail open (file the card)', () => withTeam(async () => {
  const board = fakeBoard();
  board.client.listOpenIssueTitles = async () => { throw new Error('network'); };
  board.client.listRecentIssues = async () => { throw new Error('network'); };
  const r = await createLinearIssue({ title: 'Something new broke in the pipeline', description: 'x', park: 'auto-filed parked for triage', client: board.client, source: 'workflow:X' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
}));

// Ship-check findings (BRO-5488 review).
test('BRO-5488: digest-autofix (marker only in the park reason) is never handed a near-duplicate', () => withTeam(async () => {
  const { AUTOFIX_FILED_MARKER } = require('./autofix-filed-marker.js');
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'Rebuild dropped 41 reviews on the show pages', state: { name: 'Backlog', type: 'backlog' } }] });
  const r = await createLinearIssue({ title: 'Rebuild dropped 49 reviews on the show pages', description: 'raw notes, no marker', park: `${AUTOFIX_FILED_MARKER}; runAutofix dispatches`, client: board.client, source: 'workflow:Daily Digest' });
  assert.equal(r.mode, 'park');
  assert.equal(board.created.length, 1);
}));

test('BRO-5488: a --dispatch filing that repeats an open card is refused, never swapped; --new-anyway files', () => withTeam(async () => {
  const open = [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Todo', type: 'unstarted' } }];
  const board = fakeBoard({ open });
  await assert.rejects(
    createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', dispatch: true, client: board.client, source: 'session' }),
    (e) => e.code === 'NEAR_DUPLICATE_OPEN' && /^already open: BRO-100 BSC Rebuild: 41 reviews dropped \[SUSPICIOUS\] \[Todo\]/.test(e.message) && e.twin.identifier === 'BRO-100',
  );
  assert.equal(board.created.length, 0);
  assert.equal(board.comments.length, 0, 'nothing noted on the other card');
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', dispatch: true, client: board.client, newAnyway: 'a different rebuild run, new cause' });
  assert.equal(r.mode, 'dispatch');
  const fresh = await createLinearIssue({ title: 'Add a venue map to the show page sidebar', description: 'x', dispatch: true, client: fakeBoard({ open }).client });
  assert.equal(fresh.mode, 'dispatch', 'a new title still files');
}));

test('BRO-5488: a count-only change reuses the exact-title twin, even for an opted-out filer; dates stay distinct', () => withTeam(async () => {
  const open = [
    { id: 'o1', identifier: 'BRO-200', title: 'BSC Daily: Star-band detector: 21 review(s) outside their band', state: { name: 'Backlog', type: 'backlog' } },
    { id: 'o2', identifier: 'BRO-201', title: 'Opening-night watch 2026-10-09', state: { name: 'Backlog', type: 'backlog' } },
  ];
  const board = fakeBoard({ open });
  const r = await createLinearIssue({ title: 'BSC Daily: Star-band detector: 22 review(s) outside their band', description: 'x', park: 'Auto-filed by digest-autofix; runAutofix dispatches', client: board.client, reuseTwin: true, dedupeOptOut: 'digest-autofix' });
  assert.equal(r.mode, 'reused');
  assert.equal(r.issue.identifier, 'BRO-200');
  assert.match(board.comments[0].body, /only a count changed/);
  assert.equal(r.countOnly, true);
  // A --dispatch filing is never handed a card whose title differs by a count.
  const disp = fakeBoard({ open: [{ ...open[0], state: { name: 'Todo', type: 'unstarted' } }] });
  const own = await createLinearIssue({ title: 'BSC Daily: Star-band detector: 22 review(s) outside their band', description: 'x', dispatch: true, client: disp.client, reuseTwin: true, dedupeOptOut: 'digest-autofix' });
  assert.equal(own.mode, 'dispatch');
  assert.equal(disp.comments.length, 0);
  const night = await createLinearIssue({ title: 'Opening-night watch 2026-10-10', description: 'x', park: 'routine log card for the night', client: board.client, reuseTwin: true });
  assert.equal(night.mode, 'park', 'another night is a new card');
  const off = fakeBoard({ open });
  await createLinearIssue({ title: 'BSC Daily: Star-band detector: 22 review(s) outside their band', description: 'x', park: 'Auto-filed by owner-alert-router (condition: x)', client: off.client, dedupeOptOut: 'alert-router' });
  assert.equal(off.created.length, 1, 'no reuseTwin (the router): files');
}));

test('BRO-5488: a failed note files the card instead of losing the finding', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', state: { name: 'Backlog', type: 'backlog' } }] });
  board.client.addComment = async () => { throw new Error('comment API down'); };
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'needs a budget decision on spend', client: board.client, source: 'session' });
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

test('BRO-5488: a near-duplicate of a router/autofix card files instead of noting there', () => withTeam(async () => {
  const board = fakeBoard({ open: [{ id: 'o1', identifier: 'BRO-100', title: 'BSC Rebuild: 41 reviews dropped [SUSPICIOUS]', description: 'Auto-filed by owner-alert-router (condition: x)', state: { name: 'Backlog', type: 'backlog' } }] });
  const r = await createLinearIssue({ title: 'BSC Rebuild: 49 reviews dropped [SUSPICIOUS]', description: 'x', park: 'auto-filed parked for triage', client: board.client });
  assert.equal(r.mode, 'park');
  assert.equal(board.comments.length, 0);
}));

test('BRO-5626: a session discovery with a technical park and a safe VERIFY files in Todo, no PARKED sentinel', () => withTeam(async () => {
  const notes = 'Problem: x\nVERIFY: node --test scripts/lib/cloud-worker-pick.test.mjs';
  const board = fakeBoard({ open: [] });
  const r = await createLinearIssue({ title: 'Tighten the picker skip counter for parked cards', description: notes, park: 'needs its own session, several files', priority: 3, client: board.client, reuseTwin: true });
  assert.equal(r.autoTodo, true);
  assert.equal(r.stateName, 'Todo');
  assert.doesNotMatch(board.created[0].description, /^\s*PARKED\s*:/im);
  // Real blocks and unarmed cards stay parked; the alert router (no reuseTwin) is untouched.
  const mac = fakeBoard({ open: [] });
  const m = await createLinearIssue({ title: 'Rebuild the simulator fixture set', description: notes, park: 'needs the owner Mac simulator', priority: 3, client: mac.client, reuseTwin: true });
  assert.equal(m.autoTodo, false);
  assert.equal(m.stateName, 'Backlog');
  const bare = fakeBoard({ open: [] });
  const b = await createLinearIssue({ title: 'Look into the flaky thing nobody can verify', description: 'Problem: x', park: 'needs its own session', priority: 3, client: bare.client, reuseTwin: true });
  assert.equal(b.autoTodo, false);
  const router = fakeBoard({ open: [] });
  const a = await createLinearIssue({ title: 'Tighten the picker skip counter v2', description: notes, park: 'needs its own session, several files', priority: 3, client: router.client });
  assert.equal(a.autoTodo, false);
}));

test('BRO-6081: a filer named only by dedupeOptOut is stamped with that name off GitHub Actions, not "unknown"', () => withTeam(async () => {
  const saved = process.env.GITHUB_WORKFLOW;
  delete process.env.GITHUB_WORKFLOW;
  try {
    const board = fakeBoard({ open: [] });
    await createLinearIssue({ title: 'Cron failed: Something', description: 'x', park: 'auto-filed parked for triage', client: board.client, dedupeOptOut: 'alert-router' });
    assert.match(board.created[0].description, /Filed by: alert-router/);
    const s = fakeBoard({ open: [] });
    await createLinearIssue({ title: 'Cron failed: Other', description: 'x', park: 'needs a budget decision on spend', client: s.client, dedupeOptOut: 'alert-router', source: 'session' });
    assert.match(s.created[0].description, /Filed by: session/, 'an explicit source still wins');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_WORKFLOW; else process.env.GITHUB_WORKFLOW = saved;
  }
}));

// BRO-6080: --mac-only files a Todo card with a MAC-ONLY line and the mac-only label.
test('createLinearIssue: macOnly writes the MAC-ONLY line and the label, and needs --dispatch', async () => {
  const fs = require('fs');
  const linearClient = require('./linear-client.js');
  const { LEDGER_PATH } = require('./intake-breaker.js');
  const { isMacOnlyCard } = require('./mac-only-marker.js');
  const title = `bro-6080-mac-only-test-${process.pid}-${Date.now()}`;
  const realGetTeam = linearClient.getTeam;
  linearClient.getTeam = async () => ({ id: 'team-1', states: { nodes: STATES } });
  const sent = [];
  try {
    const client = {
      createIssue: async (input) => { sent.push(input); return { identifier: 'BRO-0', id: 'i' }; },
      findOrCreateLabel: async (teamId, name) => ({ id: `label-${name}-${teamId}` }),
    };
    await createLinearIssue({ title, description: 'body\n\nVERIFY: `node --test scripts/lib/linear-issue-create.test.mjs`', dispatch: true, macOnly: 'needs the Mac launchd agent', client });
    // Label lookup failing still files the card, marked by the line.
    const noLabel = { ...client, findOrCreateLabel: async () => { throw new Error('boom'); } };
    await createLinearIssue({ title: `${title}-b`, description: 'body\n\nVERIFY: `node --test scripts/lib/linear-issue-create.test.mjs`', dispatch: true, macOnly: 'needs the Mac launchd agent', client: noLabel });
    // No safe VERIFY on its own line (e.g. a literal "\\n" from a shell): refused, it would sit in Todo forever.
    await assert.rejects(createLinearIssue({ title, description: 'body\\n\\nVERIFY: `node --test scripts/lib/linear-issue-create.test.mjs`', dispatch: true, macOnly: 'needs the Mac launchd agent', client }), /needs a safe "VERIFY/);
    await assert.rejects(createLinearIssue({ title, description: 'body', park: 'needs the owner Mac to run it', macOnly: 'needs the Mac launchd agent', client }), /use it with --dispatch/);
    await assert.rejects(createLinearIssue({ title, description: 'body', dispatch: true, macOnly: 'mac', client }), /at least 10 characters/);
    assert.equal(sent.length, 2, 'refusals file nothing');
  } finally {
    linearClient.getTeam = realGetTeam;
    if (fs.existsSync(LEDGER_PATH)) {
      const kept = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((line) => !line.includes('bro-6080-mac-only-test'));
      fs.writeFileSync(LEDGER_PATH, kept.join('\n'));
    }
  }
  assert.equal(sent.length, 2);
  assert.match(sent[0].description, /^MAC-ONLY: needs the Mac launchd agent\n\nbody/);
  assert.deepEqual(sent[0].labelIds, ['label-mac-only-team-1']);
  assert.equal(sent[1].labelIds, undefined);
  assert.ok(isMacOnlyCard({ description: sent[1].description }), 'the line alone marks the card');
});
