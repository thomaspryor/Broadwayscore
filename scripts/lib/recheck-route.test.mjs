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
const { routeMode, buildRouteBatch, fileRouteBatch, MAX_ROUTED, DEFAULT_ROUTE_FROM } = require('./recheck-route.js');

const realRows = fs.readFileSync(path.join(here, 'fixtures', 'recheck-real-fails-2026-11.jsonl'), 'utf8')
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

test('real ledger fails: 62 of the 67 real ones are routable (5 quiet-alert holds), capped at one batch', () => {
  const b = buildRouteBatch({ rows: realRows, now: NOW, tsxTests: TSX, sha: 'abc1234def5678' });
  assert.equal(b.skipped.env, 18);
  assert.equal(b.cards.length, MAX_ROUTED);
  assert.equal(b.overflow, 62 - MAX_ROUTED);
  assert.equal(b.skipped.quietAlert, 5);
  assert.match(b.title, /^Recheck 2026-11-16: 62 done claims no longer hold on main$/);
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
// the alert stopped (8 cards, 61-138h quiet, none fired again). Held, not routed.
test('quiet-alert hold: an alert quiet > 48h is held; a recent fire and other checks still route', () => {
  const { quietAlertHold, QUIET_ALERT_HOLD_H } = require('./recheck-route.js');
  const cmd = 'node scripts/check-alert-condition-absent.js --key-b64 abc';
  const row = (id, h, verifyCmd = cmd) => ({ cardId: id, name: id, status: 'fail', verifyCmd,
    detail: `[check-alert-condition-absent] FAIL: "k" still firing — open, last fired 2026-11-03T21:17:14.529Z (${h}h ago, within 168h)\n` });
  assert.equal(QUIET_ALERT_HOLD_H, 48);
  assert.equal(quietAlertHold(row('A', 107.9)), 107.9);
  assert.equal(quietAlertHold(row('B', 47.2)), null, 'a daily detector fire just under the line still routes');
  assert.equal(quietAlertHold(row('C', 100, 'node --test x.test.mjs')), null, 'only the alert-absent check is held');
  assert.equal(quietAlertHold({ cardId: 'D', verifyCmd: cmd, detail: 'CANNOT TELL: x' }), null);
  const b = buildRouteBatch({ rows: [row('BRO-1', 107.9), row('BRO-2', 0.1), row('BRO-3', 47.2)], now: NOW, tsxTests: new Set() });
  assert.deepEqual(b.cards.map((c) => c.cardId), ['BRO-2', 'BRO-3']);
  assert.equal(b.skipped.quietAlert, 1);
});

// The hold reads the check's own failure prose; this pins that coupling, so a
// rewording in check-alert-condition-absent.js fails here instead of silently
// routing quiet alerts again (ship-check review, 2026-11-08).
test('quiet-alert hold recognises the message the real check writes', () => {
  const { quietAlertHold } = require('./recheck-route.js');
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
