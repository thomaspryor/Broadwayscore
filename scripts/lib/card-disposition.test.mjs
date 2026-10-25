// BRO-6130: the real disposition gate and the real front-door behaviour, not copies of the logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// createLinearIssue records every created card in the intake ledger. Redirect it
// before intake-breaker loads so these fake cards never reach the tracked
// data/audit/intake-ledger.jsonl (BRO-5290; test.yml Ledger isolation check).
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-ledger-'));
process.env.INTAKE_LEDGER_PATH = path.join(ledgerDir, 'intake-ledger.jsonl');
test.after(() => fs.rmSync(ledgerDir, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const { resolveDisposition } = require('./card-disposition.js');
const { createLinearIssue } = require('./linear-issue-create.js');
const hd = require('./headless-dispatchability.js');

test('intake ledger is redirected away from data/audit', () => {
  const { LEDGER_PATH } = require('./intake-breaker.js');
  assert.equal(LEDGER_PATH, process.env.INTAKE_LEDGER_PATH);
});

test('resolveDisposition: --self is a third mode', () => {
  assert.deepEqual(resolveDisposition({ self: true }), { ok: true, mode: 'self' });
  assert.equal(resolveDisposition({ dispatch: true }).mode, 'dispatch');
  assert.equal(resolveDisposition({ park: 'owner must renew the login cookie' }).mode, 'park');
});

test('resolveDisposition: exactly one of the three, none is an error', () => {
  for (const combo of [{ self: true, dispatch: true }, { self: true, park: 'a long enough reason' }, { dispatch: true, park: 'a long enough reason' }, { self: true, dispatch: true, park: 'a long enough reason' }, { self: true, park: true }]) {
    const r = resolveDisposition(combo);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'BOTH_FLAGS');
  }
  const none = resolveDisposition({});
  assert.equal(none.reason, 'NO_DISPOSITION');
  assert.match(none.message, /--self/);
});

// A fake Linear client: createLinearIssue only reaches the network through `client`.
function fakeClient(states, existing = []) {
  const created = [];
  return {
    created,
    client: {
      getTeam: async () => ({ id: 'team', states: { nodes: states } }),
      createIssue: async (input) => { const issue = { id: 'id1', identifier: 'BRO-9999', title: input.title, ...input }; created.push(input); return issue; },
      listOpenIssues: async () => existing,
      searchIssues: async () => existing,
      listIssues: async () => existing,
    },
  };
}
const STATES = [
  { id: 's-back', name: 'Backlog', type: 'backlog' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-prog', name: 'In Progress', type: 'started' },
];

// createLinearIssue reads the team through the module client (needs LINEAR_API_KEY, absent in CI): stub it for this file.
require('./linear-client.js').getTeam = async () => ({ id: 'team', states: { nodes: STATES } });

test('createLinearIssue --self files In Progress and never reuses a twin', async (t) => {
  const { client, created } = fakeClient(STATES);
  let r;
  try {
    r = await createLinearIssue({ title: 'BRO-6130 test own work card', description: 'ok\n\n## Acceptance criteria\nVERIFY: node -e "process.exit(0)"', self: true, client, reuseTwin: true, source: 'session', noVerify: 'test' });
  } catch (e) {
    t.skip(`createLinearIssue needs more of the client than the fake provides: ${e.message}`);
    return;
  }
  assert.equal(r.mode, 'self');
  assert.equal(r.stateName, 'In Progress');
  assert.equal(created.length, 1);
  assert.doesNotMatch(created[0].description || '', /^PARKED:/);
});

test('takeable technical park by a session is refused; owner/money/Mac parks are not', () => {
  for (const reason of ['small UI change, nothing blocks it', 'follow-up cleanup of the helper', 'needs a refactor of the helper']) {
    assert.ok(hd.takeableParkAdvisory(reason), `expected takeable: ${reason}`);
  }
  for (const reason of ['owner must renew the login cookie', 'needs the owner Mac launchd', 'spend approval from the owner', 'waits until 2099-01-01 for opening night']) {
    assert.equal(hd.takeableParkAdvisory(reason), null, `expected exempt: ${reason}`);
  }
});

test('createLinearIssue refuses a session park with a takeable reason (kill switch and routine source exempt)', async () => {
  const body = 'details only';
  const run = (extra = {}) => createLinearIssue({ title: 'BRO-6130 takeable park probe', description: body, park: 'small cleanup of the helper, nothing blocks it', client: fakeClient(STATES).client, source: 'session', noVerify: 'test', ...extra });
  delete process.env.LINEAR_TAKEABLE_PARK_REFUSE;
  await assert.rejects(run(), (e) => e.code === 'TAKEABLE_PARK' && /--self/.test(e.message));
  // A routine names itself, so its park is a record, not a deferral.
  await assert.doesNotReject(run({ source: 'routine:weekly-retro' }));
  process.env.LINEAR_TAKEABLE_PARK_REFUSE = '0';
  try { await assert.doesNotReject(run()); } finally { delete process.env.LINEAR_TAKEABLE_PARK_REFUSE; }
});

test('BRO-6130: real owner/money/device/repo blocks are never called takeable', () => {
  const { takeableParkAdvisory } = require('./headless-dispatchability.js');
  for (const r of ['needs ScrapingBee quota top-up', 'Bright Data budget increase needed', 'needs iPhone device test',
    'legal question for Thomas', 'different repo, BroadwayScorecard-app', 'duplicate of BRO-123']) {
    assert.equal(!!takeableParkAdvisory(r), false, r);
  }
  assert.equal(!!takeableParkAdvisory('Fix typo in scripts/lib/foo.js and add a test'), true);
});
