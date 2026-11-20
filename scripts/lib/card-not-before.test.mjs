// BRO-7880: a card with a future NOT-BEFORE line is skipped by every board picker,
// and is ordinary work once that time has passed. These tests run the real pickers,
// so they fail if any picker stops asking card-not-before.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.CODEX_TRUST_LADDER_DISABLED = '1';
const nb = require('./card-not-before.js');
const pick = require('./cloud-worker-pick.js');
const drain = require('./linear-drain-parked.js');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const FUTURE = '2026-11-21T01:40:00Z';
const PAST = '2026-11-19T01:40:00Z';
const OLD = new Date(NOW - pick.IDLE_MS - 60_000).toISOString();
const BODY = '## Problem\nRe-check X.\n\n## Acceptance criteria\n`node --test scripts/lib/card-not-before.test.mjs` passes.';

const card = (description, over = {}) => ({
  identifier: 'BRO-9001', title: 'Re-check X', description, priority: 1,
  state: { name: 'Todo', type: 'unstarted' }, updatedAt: OLD, createdAt: OLD, ...over,
});

test('parser: reads the line, newest valid wins, junk is ignored', () => {
  assert.equal(nb.parseNotBeforeMs('no line'), null);
  assert.equal(nb.parseNotBeforeMs(`NOT-BEFORE: ${FUTURE}`), Date.parse(FUTURE));
  assert.equal(nb.parseNotBeforeMs(`**NOT-BEFORE:** ${FUTURE}`), Date.parse(FUTURE));
  assert.equal(nb.parseNotBeforeMs(`NOT\\-BEFORE: ${FUTURE}`), Date.parse(FUTURE), 'Linear-escaped hyphen');
  assert.equal(nb.parseNotBeforeMs(`NOT-BEFORE: ${PAST}\nNOT-BEFORE: ${FUTURE}`), Date.parse(FUTURE));
  assert.equal(nb.parseNotBeforeMs('NOT-BEFORE: tomorrow'), null, 'typo fails open');
  assert.equal(nb.parseNotBeforeMs('NOT-BEFORE: 2026-11-21T01:40:00'), null, 'zone-less date-time is ambiguous');
  assert.equal(nb.parseNotBeforeMs(`Docs mention NOT-BEFORE: ${FUTURE} mid-line`), null, 'only a line of its own counts');
  assert.equal(nb.parseNotBeforeMs('NOT-BEFORE: 2026-11-21'), Date.parse('2026-11-21T00:00:00Z'));
});

test('hold reason: future holds, past and absent do not', () => {
  assert.equal(nb.notBeforeHoldReason(card(`NOT-BEFORE: ${FUTURE}\n${BODY}`), NOW), 'not-before');
  assert.equal(nb.notBeforeHoldReason(card(`NOT-BEFORE: ${PAST}\n${BODY}`), NOW), null);
  assert.equal(nb.notBeforeHoldReason(card(BODY), NOW), null);
  assert.equal(nb.notBeforeHoldReason(null, NOW), null);
});

test('normalize: accepts zoned ISO or a date, refuses the rest', () => {
  assert.equal(nb.normalizeNotBefore('2026-11-21T01:40:00Z'), '2026-11-21T01:40:00Z');
  assert.equal(nb.normalizeNotBefore('2026-11-20T20:40:00-05:00'), '2026-11-21T01:40:00Z');
  assert.equal(nb.normalizeNotBefore('2026-11-21'), '2026-11-21T00:00:00Z');
  for (const bad of ['', 'tomorrow', '2026-11-21T01:40:00', '11/21/2026', '2026-13-45T00:00:00Z']) {
    assert.throws(() => nb.normalizeNotBefore(bad), /--not-before/, bad);
  }
});

test('cloud board worker + Codex runner (skipReason / pickCloudCard) skip a future hold, take a past one', () => {
  const held = card(`NOT-BEFORE: ${FUTURE}\n${BODY}`);
  const due = card(`NOT-BEFORE: ${PAST}\n${BODY}`, { identifier: 'BRO-9002' });
  assert.equal(pick.skipReason(held, NOW), 'not-before');
  assert.equal(pick.skipReason(held, NOW, { codex: true }), 'not-before');
  assert.equal(pick.skipReason(held, Date.parse(FUTURE) + pick.IDLE_MS + 1), null, 'eligible after the time');
  assert.equal(pick.skipReason(due, NOW), null);
  const r = pickCloudCard([held], NOW);
  assert.equal(r.pick, null);
  assert.equal(pickCloudCard([held, due], NOW).pick.identifier, 'BRO-9002');
  // The P2/P3 fallback tiers hold too.
  assert.equal(pick.skipReason(card(`NOT-BEFORE: ${FUTURE}\n${BODY}`, { priority: 3 }), NOW, { tier: 'p2' }), 'not-before');
});

test('a START-NOW card still waits for its NOT-BEFORE', () => {
  const filed = new Date(NOW - pick.START_NOW_MIN_AGE_MS - 60_000).toISOString();
  const c = card(`START-NOW: urgent\nNOT-BEFORE: ${FUTURE}\n${BODY}`, { priority: 2, createdAt: filed, updatedAt: filed });
  assert.equal(pick.skipReason(c, NOW), 'not-before');
});

test('Mac drain (selectDrainCandidates) skips a held mac-only card', () => {
  const VERIFY = '\n\nVERIFY: `node --test scripts/lib/card-not-before.test.mjs`\n';
  const line = `MAC-ONLY: needs the Mac keychain${VERIFY}`;
  const cards = [
    card(`NOT-BEFORE: ${FUTURE}\n${line}`, { identifier: 'BRO-1' }),
    card(`NOT-BEFORE: ${PAST}\n${line}`, { identifier: 'BRO-2' }),
  ];
  assert.deepEqual(drain.selectDrainCandidates(cards, { nowMs: NOW }).map((i) => i.identifier), ['BRO-2']);
  assert.deepEqual(drain.selectDrainCandidates(cards, { nowMs: Date.parse(FUTURE) + 1 }).map((i) => i.identifier), ['BRO-1', 'BRO-2']);
});

function pickCloudCard(issues, nowMs) { return pick.pickCloudCard(issues, { nowMs }); }

test('a short hold is not stretched by the 6 h idle wait; touches after the hold still count', () => {
  const hold = '2026-11-20T13:00:00Z';
  const filed = '2026-11-20T11:00:00Z'; // filed 1 h before NOW, hold 1 h after
  const c = card(`NOT-BEFORE: ${hold}\n${BODY}`, { createdAt: filed, updatedAt: filed });
  assert.equal(pick.skipReason(c, NOW), 'not-before');
  assert.equal(pick.skipReason(c, Date.parse(hold) + 60_000), null, 'due a minute after the hold, not 6 h after filing');
  const touched = { ...c, updatedAt: '2026-11-20T13:30:00Z' };
  assert.equal(pick.skipReason(touched, Date.parse('2026-11-20T13:31:00Z')), 'recent-activity');
});

test('START-NOW window restarts at the hold time', () => {
  const filed = '2026-11-10T00:00:00Z';
  const c = card(`START-NOW: urgent\nNOT-BEFORE: 2026-11-20T00:00:00Z\n${BODY}`, { priority: 2, createdAt: filed, updatedAt: filed });
  assert.equal(pick.isStartNow(c, NOW), true, 'ten days after filing, but 12 h after the hold');
});

test('Mac watchdog (ineligibleReason) and red-first dispatcher skip a held card', () => {
  const wd = require('./linear-watchdog-source.js');
  const VERIFY = '\n\nVERIFY: `node --test scripts/lib/card-not-before.test.mjs`\n';
  assert.equal(wd.ineligibleReason(card(`NOT-BEFORE: ${FUTURE}${VERIFY}`), { nowMs: NOW }), 'not-before');
  assert.notEqual(wd.ineligibleReason(card(`NOT-BEFORE: ${PAST}${VERIFY}`), { nowMs: NOW }), 'not-before');
  const rf = require('./red-first-dispatch.js');
  const marker = require('./linear-drain-parked.js').DISPATCH_AT_FILING_MARKER;
  assert.ok(marker, "red-first marker exported");
  {
    const red = card(`NOT-BEFORE: ${FUTURE}\n${marker}${VERIFY}`, { state: { type: 'backlog' } });
    const out = rf.selectRedFirstCandidates([red], { now: NOW });
    assert.deepEqual(out.skipped.map((s) => s.reason), ['not-before']);
  }
});

test('linear-next notBeforeGuard refuses a held card unless --force', () => {
  const ld = require('./linear-dispatch.js');
  const held = card(`NOT-BEFORE: ${FUTURE}\n${BODY}`);
  assert.match(ld.notBeforeGuard(held, {}, NOW), /held until 2026-11-21T01:40:00\.000Z/);
  assert.equal(ld.notBeforeGuard(held, { force: true }, NOW), null);
  assert.equal(ld.notBeforeGuard(card(`NOT-BEFORE: ${PAST}\n${BODY}`), {}, NOW), null);
});

const STATES = [
  { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
  { id: 'todo-1', name: 'Todo', type: 'unstarted' },
  { id: 'progress-1', name: 'In Progress', type: 'started' },
];
async function withTeam(fn) {
  const lc = require('./linear-client.js');
  const real = lc.getTeam;
  lc.getTeam = async () => ({ id: 'team-1', states: { nodes: STATES } });
  try { return await fn(); } finally { lc.getTeam = real; }
}
function fakeBoard(open = []) {
  const board = { open: [...open], comments: [], created: [] };
  board.client = {
    findOpenIssueByTitle: async (t) => board.open.find((c) => c.title.toLowerCase() === String(t).toLowerCase()) || null,
    listOpenIssueTitles: async () => board.open,
    listRecentIssues: async () => [],
    addComment: async (id, body) => { board.comments.push({ id, body }); },
    createIssue: async (input) => { const i = { id: 'n1', identifier: 'BRO-N1', title: input.title, description: input.description, state: { name: 'Todo', type: 'unstarted' } }; board.created.push(i); return i; },
  };
  return board;
}

test('createLinearIssue notBefore: writes the line first, needs --dispatch, refuses a card that could never run, never hides the hold in a twin comment', () => withTeam(async () => {
  const fs = require('fs');
  const { LEDGER_PATH } = require('./intake-breaker.js');
  const { createLinearIssue } = require('./linear-issue-create.js');
  const tag = `bro-7880-nb-test-${process.pid}`;
  const notes = '## Problem\nAudit the reviewer.\n\nVERIFY: `node --test scripts/lib/card-not-before.test.mjs`';
  try {
    const b = fakeBoard();
    await createLinearIssue({ title: `${tag} audit`, description: notes, dispatch: true, priority: 1, notBefore: '2026-11-20T20:40:00-05:00', client: b.client, reuseTwin: true, source: 'session' });
    assert.match(b.created[0].description, /^NOT-BEFORE: 2026-11-21T01:40:00Z\n/);
    assert.equal(nb.parseNotBeforeMs(b.created[0].description), Date.parse(FUTURE));
    await assert.rejects(createLinearIssue({ title: `${tag} p`, description: notes, park: 'needs the owner call on spend', notBefore: FUTURE, client: fakeBoard().client }), /use it with --dispatch/);
    await assert.rejects(createLinearIssue({ title: `${tag} bad`, description: notes, dispatch: true, notBefore: 'tomorrow', client: fakeBoard().client }), /--not-before needs a date/);
    await assert.rejects(createLinearIssue({ title: `${tag} nv`, description: '## Problem\nno verify', dispatch: true, notBefore: FUTURE, client: fakeBoard().client, reuseTwin: true }), /never be picked once due \(no-safe-verify\)/);
    // An exact-title open twin: the hold must not become a comment no picker reads.
    const twin = fakeBoard([{ id: 'o1', identifier: 'BRO-50', title: `${tag} twin`, state: { name: 'Todo', type: 'unstarted' } }]);
    await createLinearIssue({ title: `${tag} twin`, description: notes, dispatch: true, priority: 1, notBefore: FUTURE, client: twin.client, reuseTwin: true, source: 'session' }).catch((e) => assert.match(e.message, /already open/));
    assert.equal(twin.comments.length, 0, 'no twin comment carrying the hold');
  } finally {
    if (fs.existsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter((l) => !l.includes('bro-7880-nb-test')).join('\n'));
  }
}));
