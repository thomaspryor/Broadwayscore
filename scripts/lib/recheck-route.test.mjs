// BRO-7138 part 3: failed rechecks are routed to ONE batched worker card,
// shadow-logged until the arm date, with an off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { routeMode, heldForOwner, buildRouteBatch, fileRouteBatch, MAX_ROUTED, DEFAULT_ROUTE_FROM } = require('./recheck-route.js');

const realRows = fs.readFileSync(path.join(here, '..', '..', 'tests', 'fixtures', 'recheck-real-fails-2026-11.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const TSX = new Set(['tests/unit/gate-logic.test.mjs', 'tests/unit/seo-show-no-venue.test.mjs', 'tests/unit/uk-regional-placement.test.mjs']);
const NOW = Date.parse('2026-11-16T08:00:00Z');

test('routeMode: off switch wins, shadow before the arm date, live after, a bad date never arms early', () => {
  assert.equal(routeMode({ env: { RECHECK_ROUTE: 'off' }, now: NOW }).mode, 'off');
  assert.equal(routeMode({ env: { RECHECK_ROUTE: 'OFF', RECHECK_ROUTE_FROM: '2020-01-01' }, now: NOW }).mode, 'off');
  assert.equal(routeMode({ env: {}, now: Date.parse(`${DEFAULT_ROUTE_FROM}T00:00:00Z`) - 1 }).mode, 'shadow');
  assert.equal(routeMode({ env: {}, now: Date.parse(`${DEFAULT_ROUTE_FROM}T00:00:00Z`) }).mode, 'live');
  assert.equal(routeMode({ env: { RECHECK_ROUTE_FROM: '2026-12-01' }, now: NOW }).mode, 'shadow');
  assert.equal(routeMode({ env: { RECHECK_ROUTE_FROM: '2026-02-30' }, now: Date.parse('2026-11-10T00:00:00Z') }).mode, 'shadow', 'an impossible date never arms');
  const bad = routeMode({ env: { RECHECK_ROUTE_FROM: 'next week' }, now: Date.parse('2026-11-10T00:00:00Z') });
  assert.equal(bad.mode, 'shadow');
  assert.match(bad.why, /unreadable, default used/);
});

test('real ledger fails: only the 67 real ones are routable, capped at one batch', () => {
  const b = buildRouteBatch({ rows: realRows, now: NOW, tsxTests: TSX, sha: 'abc1234def5678' });
  assert.equal(b.skipped.env, 18);
  assert.equal(b.cards.length, MAX_ROUTED);
  assert.equal(b.overflow, 67 - MAX_ROUTED);
  assert.match(b.title, /^Recheck 2026-11-16: 67 done claims no longer hold on main$/);
  assert.match(b.body, /## Acceptance criteria/);
  assert.match(b.body, /Do not reopen the original cards/);
  // Each entry names the fresh-main commit and the END of the output (where the failure is).
  assert.equal((b.body.match(/failed on main at abc1234def56, output tail: /g) || []).length, MAX_ROUTED);
  const long = buildRouteBatch({ rows: [{ cardId: 'BRO-9', name: 'n', status: 'fail', verifyCmd: 'node --test x.test.mjs', detail: `${'setup noise '.repeat(40)}AssertionError: expected 3 got 0` }], now: NOW, tsxTests: new Set() });
  assert.match(long.body, /output tail: \.\.\..*AssertionError: expected 3 got 0/);
  assert.match(long.body, /failed on main at unknown/);
  for (const c of b.cards) assert.ok(b.body.includes(c.cardId) && b.body.includes(c.verifyCmd), c.cardId);
  // No env-cause card ever appears.
  for (const r of realRows.filter((x) => x.expect !== 'real')) assert.ok(!b.cards.some((c) => c.cardId === r.cardId), r.cardId);
});

test('dedup: cards a live route filed are not routed again; shadow rows and old rows do not count', () => {
  const rows = [
    { cardId: 'BRO-1', name: 'a', status: 'fail', detail: 'x', verifyCmd: 'node --test a.test.mjs' },
    { cardId: 'BRO-2', name: 'b', status: 'fail', detail: 'y', verifyCmd: 'node --test b.test.mjs' },
    { cardId: 'BRO-3', name: 'c', status: 'fail', detail: 'z', verifyCmd: 'node --test c.test.mjs' },
    { cardId: 'BRO-4', name: 'd', status: 'pass', verifyCmd: 'node --test d.test.mjs' },
    { cardId: 'BRO-5', name: 'e', status: null, skip: 'someone is working it' },
    { cardId: 'BRO-6', name: 'f', status: 'fail', detail: 'w', verifyCmd: 'node --test f.test.mjs' },
  ];
  const ledgerEntries = [
    { event: 'recheck-route', ts: '2026-11-15T07:00:00Z', mode: 'live', filed: true, cardIds: ['BRO-1'] },
    { event: 'recheck-route', ts: '2026-11-15T07:00:00Z', mode: 'shadow', filed: false, cardIds: ['BRO-2'] },
    { event: 'recheck-route', ts: '2026-09-01T07:00:00Z', mode: 'live', filed: true, cardIds: ['BRO-3'] },
    { event: 'recheck-route', ts: '2026-11-15T07:00:00Z', mode: 'live', filed: false, maybeFiled: true, cardIds: ['BRO-6'] },
  ];
  const b = buildRouteBatch({ rows, ledgerEntries, handedOff: [], now: NOW, tsxTests: new Set() });
  assert.deepEqual(b.cards.map((c) => c.cardId), ['BRO-2', 'BRO-3']);
  assert.equal(b.skipped.routed, 2, 'a live create that timed out counts as maybe filed');
  const h = buildRouteBatch({ rows, ledgerEntries: [], handedOff: ['BRO-2', 'BRO-3', 'BRO-1', 'BRO-6'], now: NOW, tsxTests: new Set() });
  assert.equal(h.title, null);
  assert.equal(h.skipped.handedOff, 4);
});

test('fileRouteBatch: one create with --dispatch --new-anyway, card id read from linear-brain output, exit trapped', async () => {
  let argv = null;
  const ok = await fileRouteBatch({ title: 'T', body: 'B', linearBrainMain: async (a) => { argv = a; console.error('__BOARD_CARD_ID__=BRO-9001'); process.exit(0); } });
  assert.deepEqual(ok, { filed: true, identifier: 'BRO-9001', error: null });
  assert.equal(argv[0], 'create');
  for (const f of ['--dispatch', '--new-anyway', '--notes']) assert.ok(argv.includes(f), f);
  assert.equal(argv[argv.indexOf('--priority') + 1], '2', 'P2 per the card');
  const refused = await fileRouteBatch({ title: 'T', body: 'B', linearBrainMain: async () => { process.exit(2); } });
  assert.deepEqual([refused.filed, refused.error], [false, 'linear-brain create exited 2']);
  const threw = await fileRouteBatch({ title: 'T', body: 'B', linearBrainMain: async () => { throw new Error('linear down'); } });
  assert.deepEqual([threw.filed, threw.error], [false, 'linear down']);
});

test('fileRouteBatch timeout: maybeFiled, and a late exit from main stays trapped (BRO-7138 review)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const realExit = process.exit;
  const keepAlive = setInterval(() => {}, 1000); // the route timer is unref'd
  const out = await fileRouteBatch({ title: 'T', body: 'B', timeoutMs: 20, linearBrainMain: async () => { await gate; process.exit(2); } });
  assert.deepEqual([out.filed, out.maybeFiled], [false, true]);
  assert.match(out.error, /timed out/);
  assert.notEqual(process.exit, realExit, 'exit stays trapped while main() is still running');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(process.exit, realExit, 'restored once main() settles');
  clearInterval(keepAlive);
});

// Replay finding (2026-11-08): alert-absent checks kept failing for days after
// the alert stopped (8 cards, 61-138h quiet). They still route (a Done card is
// rechecked one night only, so holding would drop it) with a note to look first.
test('quiet alert: still routed, with a note; a recent fire and other checks get none', () => {
  const { quietAlertHours, QUIET_ALERT_NOTE_H } = require('./recheck-route.js');
  const cmd = 'node scripts/check-alert-condition-absent.js --key-b64 abc';
  const row = (id, h, verifyCmd = cmd) => ({ cardId: id, name: id, status: 'fail', verifyCmd,
    detail: `[check-alert-condition-absent] FAIL: "k" still firing — open, last fired 2026-11-03T21:17:14.529Z (${h}h ago, within 168h)\n` });
  assert.equal(QUIET_ALERT_NOTE_H, 48);
  assert.equal(quietAlertHours(row('A', 107.9)), 107.9);
  assert.equal(quietAlertHours(row('B', 47.2)), null);
  assert.equal(quietAlertHours(row('C', 100, 'node --test x.test.mjs')), null, 'only the alert-absent check');
  assert.equal(quietAlertHours({ cardId: 'D', verifyCmd: cmd, detail: 'CANNOT TELL: x' }), null);
  const b = buildRouteBatch({ rows: [row('BRO-1', 107.9), row('BRO-2', 0.1), row('BRO-3', 47.2)], now: NOW, tsxTests: new Set() });
  assert.deepEqual(b.cards.map((c) => c.cardId), ['BRO-1', 'BRO-2', 'BRO-3'], 'nothing is dropped');
  assert.equal((b.body.match(/note: the alert last fired 108h ago/g) || []).length, 1);
});

// The note reads the check's own failure prose; this pins that coupling, so a
// rewording in check-alert-condition-absent.js fails here instead of silently
// dropping the note (ship-check review, 2026-11-08).
test('quiet-alert note recognises the message the real check writes', () => {
  const { quietAlertHours: quietAlertHold } = require('./recheck-route.js');
  const { decide } = require('../check-alert-condition-absent.js');
  const now = Date.parse('2026-11-08T09:13:45Z');
  const iso = (h) => new Date(now - h * 36e5).toISOString();
  const key = `opening-night-revival-unverified-${'x'.repeat(100)}`; // long key: the hours still survive
  const ledgers = [{ path: 'fx', conditions: { [key]: { status: 'open', lastSeen: iso(107.9) }, 'heartbeat:x': { status: 'open', lastSeen: iso(1) } } }];
  const quiet = decide(ledgers, key, now);
  assert.equal(quiet.code, 1);
  const row = { cardId: 'BRO-1', status: 'fail', verifyCmd: 'node scripts/check-alert-condition-absent.js --key-b64 abc', detail: `[check-alert-condition-absent] ${quiet.message}\n` };
  assert.equal(quietAlertHold(row), 107.9);
  const recent = decide([{ ...ledgers[0], conditions: { ...ledgers[0].conditions, [key]: { status: 'open', lastSeen: iso(5) } } }], key, now);
  assert.equal(quietAlertHold({ ...row, detail: `[check-alert-condition-absent] ${recent.message}` }), null);
});

// BRO-7557: failures from the report-only weeks never became work, and a card that kept failing was
// skipped forever. Rewatch re-runs still-failing, uncovered Done cards; one predicate covers both
// the batch builder and the selector.
const R = require('./recheck-route.js');
const fail = (id, ts, extra = {}) => ({ event: 'recheck', cardId: id, name: `n ${id}`, ts, status: 'fail', verifyCmd: 'node --test a.test.mjs', detail: 'AssertionError: x', ...extra });
const live = (ts, ids, identifier = 'BRO-9000') => ({ event: 'recheck-route', ts, mode: 'live', filed: true, identifier, cardIds: ids });
const NOW2 = Date.parse('2026-11-16T08:00:00Z');
const TS0 = new Set(['x']);

test('buildCoverIndex: word-boundary mention in an open card, never self, null when the fetch failed', () => {
  const idx = R.buildCoverIndex([
    { identifier: 'BRO-1', title: 'Fix BRO-12', description: 'also BRO-5\\n' },
    { identifier: 'BRO-2', title: 'x', description: 'see BRO-123 and (BRO-5), BRO-2' },
  ]);
  assert.deepEqual([...idx.get('BRO-12')], ['BRO-1'], 'BRO-12 is not BRO-123');
  assert.deepEqual([...idx.get('BRO-123')], ['BRO-2']);
  assert.deepEqual([...idx.get('BRO-5')].sort(), ['BRO-1', 'BRO-2']);
  assert.ok(!idx.has('BRO-2'), 'a card never covers itself');
  assert.equal(R.buildCoverIndex(undefined), null);
});

test('selectRewatchTargets: shadow-era fail is picked; covered, recently routed, passing, env and fresh rows are not', () => {
  const rows = [
    fail('BRO-10', '2026-11-03T07:00:00Z'),                       // shadow era, never routed
    fail('BRO-11', '2026-11-04T07:00:00Z'),                       // an open card names it
    fail('BRO-12', '2026-11-05T07:00:00Z'), live('2026-11-15T07:00:00Z', ['BRO-12']),   // routed 25h ago
    fail('BRO-13', '2026-11-06T07:00:00Z'), live('2026-11-10T07:00:00Z', ['BRO-13']),   // routed 6 nights ago, still failing
    fail('BRO-14', '2026-11-07T07:00:00Z'), { ...fail('BRO-14', '2026-11-08T07:00:00Z'), status: 'pass', detail: null }, // passes now
    fail('BRO-15', '2026-11-16T01:00:00Z'),                       // rechecked 7h ago
    { ...fail('BRO-16', '2026-11-08T07:00:00Z'), status: 'unverifiable' },
  ];
  const cover = R.buildCoverIndex([{ identifier: 'BRO-99', title: 't', description: 'handles BRO-11' }]);
  const { targets } = R.selectRewatchTargets({ ledgerEntries: rows, now: NOW2, coverIndex: cover, tsxTests: TS0 });
  assert.deepEqual(targets.map((t) => t.cardId), ['BRO-10', 'BRO-13'], 'oldest check first');
  assert.ok(targets.every((t) => t.rewatch === true));
  assert.equal(targets[1].priorRoutes.length, 1);
});

test('selectRewatchTargets: stops after MAX_REROUTES, honours limit, since and exclude', () => {
  const routes = [1, 2, 3].map((i) => live(`2026-11-0${i}T07:00:00Z`, ['BRO-20'], `BRO-90${i}`));
  const rows = [fail('BRO-20', '2026-11-05T07:00:00Z'), ...routes, fail('BRO-21', '2026-09-01T07:00:00Z'), fail('BRO-22', '2026-11-05T08:00:00Z'), fail('BRO-23', '2026-11-05T09:00:00Z'), fail('BRO-24', '2026-11-05T10:00:00Z')];
  const r = R.selectRewatchTargets({ ledgerEntries: rows, now: NOW2, since: '2026-10-15', limit: 1, exclude: ['BRO-23'], coverIndex: new Map() });
  assert.deepEqual(r.exhausted, ['BRO-20']);
  assert.deepEqual(r.targets.map((t) => t.cardId), ['BRO-22'], 'BRO-21 is before since, BRO-23 excluded, limit 1');
});

test('alreadyRouted: the window shrinks to the retry window only when the open-card index is known', () => {
  const e = [live('2026-11-10T07:00:00Z', ['BRO-1'])]; // 6 nights ago
  assert.ok(R.alreadyRouted(e, { now: NOW2 }).has('BRO-1'), 'index unknown: long window, never route twice on a failed lookup');
  assert.ok(!R.alreadyRouted(e, { now: NOW2, coverKnown: true }).has('BRO-1'));
  assert.ok(R.alreadyRouted([live('2026-11-15T07:00:00Z', ['BRO-1'])], { now: NOW2, coverKnown: true }).has('BRO-1'));
});

test('buildRouteBatch: an open card that names a failing card skips it; a re-route says it was routed before', () => {
  const rows = [
    { cardId: 'BRO-1', name: 'a', status: 'fail', detail: 'x', verifyCmd: 'node --test a.test.mjs' },
    { cardId: 'BRO-2', name: 'b', status: 'fail', detail: 'y', verifyCmd: 'node --test b.test.mjs' },
  ];
  const cover = R.buildCoverIndex([{ identifier: 'BRO-50', title: 'owner', description: 'BRO-1' }]);
  const b = buildRouteBatch({ rows, ledgerEntries: [live('2026-11-05T07:00:00Z', ['BRO-2'], 'BRO-7512')], now: NOW2, tsxTests: new Set(), coverIndex: cover });
  assert.deepEqual(b.cards.map((c) => c.cardId), ['BRO-2']);
  assert.equal(b.skipped.coveredOpen, 1);
  assert.match(b.body, /routed before \(BRO-7512\) and still failing 11 nights later/);
  const again = buildRouteBatch({ rows, handedOff: ['BRO-2'], now: NOW2, tsxTests: new Set(), coverIndex: new Map() });
  assert.deepEqual(again.cards.map((c) => c.cardId), ['BRO-1'], 'a filed batch joins handedOff so the next batch is the rest');
});

test('refreshRewatchTargets: uses the card\'s current VERIFY; unreadable, open and retracted cards are dropped', async () => {
  const card = (stateType, extra = {}) => ({ id: 'x', name: 'fresh name', stateType, status: stateType === 'completed' ? 'Done' : 'In Progress', ...extra });
  const issues = { 'BRO-1': card('completed'), 'BRO-2': card('started'), 'BRO-3': card('completed'), 'BRO-4': null };
  const gates = { 'BRO-1': { cmd: 'node --test new.test.mjs' }, 'BRO-3': { kind: 'retracted', cmd: null } };
  let cur = null;
  const out = await R.refreshRewatchTargets(['BRO-1', 'BRO-2', 'BRO-3', 'BRO-4', 'BRO-5'].map((cardId) => ({ cardId, name: 'old', verifyCmd: 'node --test old.test.mjs', rewatch: true })), {
    getIssue: async (id) => { if (id === 'BRO-5') throw new Error('boom'); cur = id; return issues[id]; },
    toCard: (i) => i,
    gateFor: () => gates[cur],
  });
  assert.deepEqual(out.targets.map((t) => [t.cardId, t.verifyCmd, t.cmdChanged]), [['BRO-1', 'node --test new.test.mjs', true]]);
  assert.deepEqual(out.dropped.map((d) => d.cardId), ['BRO-2', 'BRO-3', 'BRO-4', 'BRO-5']);
});

test('real ledger replay: the shadow-era fails come back as rewatch targets', () => {
  // Frozen snapshot (latest failing row per card, 2026-11-15): the live CI ledger moves every night.
  const entries = fs.readFileSync(path.join(here, '..', '..', 'tests', 'fixtures', 'recheck-ledger-latest-fails-2026-11-15.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const { targets } = R.selectRewatchTargets({ ledgerEntries: entries, now: Date.parse('2026-11-16T08:00:00Z'), since: '2026-10-15', limit: 500, coverIndex: new Map() });
  assert.ok(targets.length >= 20, `expected the shadow-era backlog, got ${targets.length}`);
  assert.ok(targets.every((t) => t.verifyCmd && t.rewatch));
});

test('selectRewatchTargets: a newer pass outside the look-back hides an older fail, and bad timestamps never qualify', () => {
  const NOW = Date.parse('2026-11-15T12:00:00Z');
  const fail = (ts, cardId = 'BRO-1') => ({ event: 'recheck', cardId, ts, verifyCmd: 'node x.js', exit: 1, ok: false, status: 'fail' });
  const pass = (ts) => ({ event: 'recheck', cardId: 'BRO-1', ts, verifyCmd: 'node x.js', exit: 0, ok: true, status: 'pass' });
  const rows = [fail('2026-10-01T00:00:00Z'), pass('2026-10-10T00:00:00Z')];
  assert.equal(R.selectRewatchTargets({ ledgerEntries: rows, now: NOW, since: '2026-10-15' }).targets.length, 0);
  const bad = [fail('not-a-date', 'BRO-2')];
  assert.equal(R.selectRewatchTargets({ ledgerEntries: bad, now: NOW }).targets.length, 0);
});

test('buildRouteBatch: a card already routed MAX_REROUTES times is not routed again, and the covering card is named', () => {
  const NOW = Date.parse('2026-11-15T12:00:00Z');
  const row = (id) => ({ event: 'recheck', cardId: id, name: 'n', ts: '2026-11-14T00:00:00Z', verifyCmd: 'node x.js', exit: 1, ok: false, status: 'fail', detail: 'boom' });
  const route = (id, d) => ({ event: 'recheck-route', mode: 'live', filed: true, cardIds: [id], ts: `2026-10-${d}T00:00:00Z`, identifier: `BRO-9${d}` });
  const led = [route('BRO-1', '01'), route('BRO-1', '05'), route('BRO-1', '09')];
  const cover = new Map([['BRO-2', new Set(['BRO-777'])]]);
  const out = R.buildRouteBatch({ rows: [row('BRO-1'), row('BRO-2'), row('BRO-3')], ledgerEntries: led, now: NOW, coverIndex: cover });
  assert.deepEqual(out.cards.map((c) => c.cardId), ['BRO-3']);
  assert.equal(out.skipped.exhausted, 1);
  assert.deepEqual(out.skipped.coveredBy, { 'BRO-2': 'BRO-777' });
});

test('selectRewatchTargets: a later env-cause row does not hide an earlier real fail', () => {
  const NOW = Date.parse('2026-11-15T12:00:00Z');
  const base = { event: 'recheck', cardId: 'BRO-1', verifyCmd: 'node x.js' };
  const rows = [
    { ...base, ts: '2026-11-10T00:00:00Z', exit: 1, ok: false, status: 'fail' },
    { ...base, ts: '2026-11-13T00:00:00Z', exit: 1, ok: false, status: 'unverifiable', envCause: 'missing-secret' },
  ];
  assert.deepEqual(R.selectRewatchTargets({ ledgerEntries: rows, now: NOW }).targets.map((t) => t.cardId), ['BRO-1']);
});

// BRO-8403: BRO-8138 was Paused on an owner DECISION NEEDED with a RECHECK-AFTER stamp. Its check
// failed as expected, decideHandoff refused it ("waiting on the owner"), and the router filed it
// anyway as "1 done claim no longer holds", dispatching a worker that could only re-report the wait.
test('heldForOwner + buildRouteBatch: an owner-held Paused card is not routed; a Done card always is', () => {
  const decisionNotes = 'DECISION NEEDED: build an unattended regional venue-page synopsis/ticket filler, or demote regional rows below high severity.\nWhy this is your call: new pipeline spend.\nRECHECK-AFTER: 2026-11-27. Recheck: node scripts/check-health-row-absent.js --row-b64 RGF0YQ';
  const cardsById = new Map([
    ['BRO-8138', { stateType: 'backlog', status: 'Paused', notes: decisionNotes }],
    ['BRO-2', { stateType: 'backlog', status: 'Paused', notes: 'RECHECK-AFTER: 2026-11-27. fix landed, waiting a day' }],
    ['BRO-3', { stateType: 'completed', status: 'Done', notes: decisionNotes }],
  ]);
  const rows = [
    { cardId: 'BRO-8138', name: 'freshness', status: 'fail', detail: 'still listed', verifyCmd: 'node scripts/check-health-row-absent.js --row-b64 RGF0YQ' },
    { cardId: 'BRO-2', name: 'b', status: 'fail', detail: 'x', verifyCmd: 'node --test b.test.mjs' },
    { cardId: 'BRO-3', name: 'c', status: 'fail', detail: 'y', verifyCmd: 'node --test c.test.mjs' },
    { cardId: 'BRO-404', name: 'unknown card', status: 'fail', detail: 'z', verifyCmd: 'node --test d.test.mjs' },
  ];
  const held = heldForOwner(rows, cardsById);
  assert.deepEqual(held, ['BRO-8138'], 'only the open, owner-held card is held; Done and unknown cards are not');
  const b = buildRouteBatch({ rows, held, ledgerEntries: [], now: NOW, tsxTests: new Set() });
  assert.deepEqual(b.cards.map((c) => c.cardId), ['BRO-2', 'BRO-3', 'BRO-404']);
  assert.equal(b.skipped.held, 1);
  assert.doesNotMatch(b.body, /BRO-8138/);
  const only = buildRouteBatch({ rows: rows.slice(0, 1), held, ledgerEntries: [], now: NOW, tsxTests: new Set() });
  assert.equal(only.title, null, 'a night whose only failure is owner-held files no card');
  assert.deepEqual(heldForOwner(rows, null), [], 'no card map never holds anything back');
});
