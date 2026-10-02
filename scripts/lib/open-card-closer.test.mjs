import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = require('./open-card-closer.js');

const now = Date.parse('2026-10-02T14:00:00Z');
const old = '2026-10-01T00:00:00Z';
const fresh = '2026-10-02T12:00:00Z';
const mk = (o = {}) => ({ state: 'In Review', stateType: 'started', priority: 2, updatedAt: old, comments: [], labels: [], ...o });
const run = (auditRows, cards, ledgerRows = []) =>
  m.planOpenCardActions({ auditRows, ledgerRows, getCard: (id) => cards[id] ?? null, now });

test('STUCK idle card closes; fresh card skipped', () => {
  const p = run(
    [{ id: 'BRO-1', verdict: 'STUCK', state: 'In Review' }, { id: 'BRO-2', verdict: 'STUCK', state: 'In Progress' }],
    { 'BRO-1': mk(), 'BRO-2': mk({ updatedAt: fresh }) });
  assert.deepEqual(p.map((x) => [x.id, x.action]), [['BRO-1', 'close'], ['BRO-2', 'skip']]);
});

test('a recent comment counts as activity', () => {
  const p = run([{ id: 'BRO-1', verdict: 'STUCK', state: 'In Review' }], { 'BRO-1': mk({ comments: [{ body: 'x', createdAt: fresh }] }) });
  assert.equal(p[0].action, 'skip');
});

test('terminal, held, unreadable cards are skipped', () => {
  const rows = ['BRO-1', 'BRO-2', 'BRO-3'].map((id) => ({ id, verdict: 'STUCK', state: 'In Progress' }));
  const p = run(rows, { 'BRO-1': mk({ state: 'Done', stateType: 'completed' }), 'BRO-2': mk({ labels: ['awaiting-owner'] }) });
  assert.deepEqual(p.map((x) => x.action), ['skip', 'skip', 'skip']);
});

test('ledger passes for BRO ids from today close; stale-day, fail and Notion ids ignored', () => {
  const ledger = [
    { event: 'recheck', status: 'pass', cardId: 'BRO-9', ts: '2026-10-02T13:00:00Z' },
    { event: 'recheck', status: 'pass', cardId: 'BRO-8', ts: '2026-10-01T13:00:00Z' },
    { event: 'recheck', status: 'fail', cardId: 'BRO-7', ts: '2026-10-02T13:00:00Z' },
    { event: 'recheck', status: 'pass', cardId: '3c8637c5-416f', ts: '2026-10-02T13:00:00Z' },
  ];
  const p = run([], { 'BRO-9': mk({ state: 'Paused' }) }, ledger);
  assert.deepEqual(p.map((x) => [x.id, x.action]), [['BRO-9', 'close']]);
});

test('In Review + openCheckFails bounces; In Progress does not; cap at 2', () => {
  const rows = [
    { id: 'BRO-1', verdict: 'UNVERIFIABLE', state: 'In Review', openCheckFails: true, detail: 'boom' },
    { id: 'BRO-2', verdict: 'UNVERIFIABLE', state: 'In Progress', openCheckFails: true },
    { id: 'BRO-3', verdict: 'UNVERIFIABLE', state: 'In Review', openCheckFails: true },
  ];
  const bounced = { body: m.BOUNCE_MARKER, createdAt: old };
  const p = run(rows, { 'BRO-1': mk({ comments: [bounced] }), 'BRO-2': mk({ state: 'In Progress' }), 'BRO-3': mk({ comments: [bounced, bounced] }) });
  assert.deepEqual(p.map((x) => [x.id, x.action]), [['BRO-1', 'bounce'], ['BRO-3', 'skip']]);
  assert.match(p[0].reason, /bounce 2\/2/);
  assert.match(p[1].reason, /cap/);
});

test('a card that is both STUCK and bounce-flagged is only closed', () => {
  const p = run([
    { id: 'BRO-1', verdict: 'STUCK', state: 'In Review' },
    { id: 'BRO-1', verdict: 'UNVERIFIABLE', state: 'In Review', openCheckFails: true },
  ], { 'BRO-1': mk() });
  assert.equal(p.length, 1);
  assert.equal(p[0].action, 'close');
});

test('classifyCard sets openCheckFails only on open cards with a broken check', () => {
  const { classifyCard } = require('./done-evidence-audit.js');
  const r = classifyCard({ card: { id: 'BRO-5', name: 'n', state: 'In Review' }, cmd: 'node --test x', runResult: { status: 'fail', detail: 'nope' } });
  assert.equal(r.openCheckFails, true);
  const pass = classifyCard({ card: { id: 'BRO-5', name: 'n', state: 'In Review' }, cmd: 'node --test x', runResult: { status: 'pass' } });
  assert.notEqual(pass.openCheckFails, true);
});

test('escalatedModel: P0 and bounced cards -> opus, others null', () => {
  const { escalatedModel } = require('./linear-dispatch.js');
  assert.equal(escalatedModel({ priority: 1 }), 'opus');
  assert.equal(escalatedModel({ priority: 2 }), null);
  assert.equal(escalatedModel({ priority: 3, comments: { nodes: [{ body: `${m.BOUNCE_MARKER}\nBounced` }] } }), 'opus');
});

test('buildLinearSeed tells the worker to run the card check on main', () => {
  const { buildLinearSeed } = require('./linear-dispatch.js');
  assert.match(buildLinearSeed({ identifier: 'BRO-1', title: 't', description: 'd' }), /run the issue's own check .* against main/);
});

test('bounce skipped for P2+ cards; close skipped for Todo state and recently-refused ids', () => {
  const p = run([{ id: 'BRO-1', verdict: 'UNVERIFIABLE', state: 'In Review', openCheckFails: true }], { 'BRO-1': mk({ priority: 3 }) });
  assert.match(p[0].reason, /P0\/P1/);
  const rows = [{ id: 'BRO-2', verdict: 'STUCK', state: 'In Review' }, { id: 'BRO-3', verdict: 'STUCK', state: 'In Review' }];
  const q = m.planOpenCardActions({ auditRows: rows, ledgerRows: [], now, skipIds: new Set(['BRO-3']), getCard: (id) => (id === 'BRO-2' ? mk({ state: 'Todo' }) : mk()) });
  assert.deepEqual(q.map((x) => x.action), ['skip', 'skip']);
});

test('open-card check failure carries failDetail for the bounce comment', () => {
  const { classifyCard } = require('./done-evidence-audit.js');
  const r = classifyCard({ card: { id: 'BRO-5', name: 'n', state: 'In Review' }, cmd: 'node --test x', runResult: { status: 'fail', detail: 'AssertionError boom' } });
  assert.match(r.failDetail, /AssertionError boom/);
});
