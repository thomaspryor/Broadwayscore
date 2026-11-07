// BRO-3087: "won't send" for shows with no Resend draft. require()s the real
// guard, planner and the classifiers every reader uses (CLAUDE.md §15), and
// drives the real CLI on a temp tracker (no Resend key, nothing sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { dismissBlockReason, planNoDraftDismissal, wontSendCommand, draftShowIds } = require('./broadcast-dismiss.js');
const { classifyShowBroadcastState } = require('./missed-broadcasts.js');
const { shouldRequeueShow } = require('./broadcast-state.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const today = '2026-10-13';
const openingDates = new Map([
  ['never-a', '2026-10-01'], ['stuck-b', '2026-10-01'], ['sent-c', '2026-10-01'], ['gone-d', '2026-10-01'],
  ['combo-e', '2026-10-01'], ['combo-f', '2026-10-01'], ['future-g', '2026-11-01'],
]);
const tracker = {
  'stuck-b': { completed: true, draftId: 'd1', draftStatus: 'draft' },
  'sent-c': { completed: true, draftId: 'd2', draftStatus: 'sent' },
  'gone-d': { completed: false, draftId: 'd3', draftStatus: 'deleted' },
  'overdue-alert:never-a': { ts: 1 },
  'combo-e': { completed: false, draftId: 'd4', draftStatus: 'deleted', broadcastKey: 'broadway:combo-e+combo-f' },
  'broadway:combo-e+combo-f': { completed: true, draftId: 'd4', draftStatus: 'draft' },
};
const opts = { openingDates, today };

test('guard: opened shows with no draft pass', () => {
  assert.equal(dismissBlockReason(tracker, ['never-a', 'gone-d'], opts), null);
});

test('guard refuses: waiting draft, sent, unknown, not yet opened', () => {
  assert.match(dismissBlockReason(tracker, ['stuck-b'], opts), /draft waiting/);
  assert.match(dismissBlockReason(tracker, ['sent-c'], opts), /already sent/);
  assert.match(dismissBlockReason(tracker, ['nope'], opts), /not a show/);
  assert.match(dismissBlockReason(tracker, ['future-g'], opts), /has not opened yet/);
});

test('guard checks combo records, not only the per-show mirror (BRO-4474 disagreement)', () => {
  // Mirror says deleted, combo record still says draft: refused until both shows are named...
  assert.match(dismissBlockReason(tracker, ['combo-e'], opts), /also covers combo-f/);
  // ...and even then while the combo draft is still live.
  assert.match(dismissBlockReason(tracker, ['combo-e', 'combo-f'], opts), /draft waiting \(d4\)/);
  // A live GET that found it gone (404) lets it through.
  assert.equal(dismissBlockReason(tracker, ['combo-e', 'combo-f'], { ...opts, goneDraftIds: new Set(['d4']) }), null);
  assert.equal(dismissBlockReason(tracker, ['stuck-b'], { ...opts, goneDraftIds: new Set(['d1']) }), null);
});

test('planned records read as discarded and never re-queue', () => {
  const writes = planNoDraftDismissal(tracker, ['never-a', 'gone-d'], { nowIso: '2026-10-13T00:00:00Z', reason: 'owner: skip' });
  assert.deepEqual(Object.keys(writes).sort(), ['gone-d', 'never-a']); // overdue-alert: side key untouched
  const after = { ...tracker, ...writes };
  for (const id of ['never-a', 'gone-d']) {
    assert.equal(classifyShowBroadcastState(after, id), 'discarded');
    assert.equal(shouldRequeueShow(after[id]), false);
    assert.equal(after[id].draftStatus, 'deleted'); // markDraftDiscarded shape, not a bare stamp
  }
  assert.equal(after['never-a'].discardReason, 'owner: skip');
});

test('the alert names the right command per state, every show of a combo', () => {
  assert.deepEqual(draftShowIds(tracker, 'combo-e').sort(), ['combo-e', 'combo-f']);
  assert.match(wontSendCommand(tracker, 'never-a', 'never-drafted'), /shows=never-a -f no_draft=true/);
  assert.match(wontSendCommand(tracker, 'gone-d', 'draft-unknown'), /-f no_draft=true/);
  assert.match(wontSendCommand(tracker, 'combo-e', 'draft-stuck'), /shows=combo-e,combo-f -f dry_run=false$/);
});

test('CLI --no-draft: dry run writes nothing, --execute records, no Resend key needed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismiss-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const showsJson = { shows: [...openingDates].map(([id, openingDate]) => ({ id, openingDate })) };
  fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify(showsJson));
  const sentPath = path.join(dir, 'data', 'opening-night-sent.json');
  fs.writeFileSync(sentPath, JSON.stringify({ shows: tracker }));
  const cli = path.join(here, '..', 'discard-stuck-broadcast-drafts.js');
  const env = { ...process.env, RESEND_API_KEY: '', GITHUB_ACTIONS: 'true' };
  execFileSync(process.execPath, [cli, '--show=never-a', '--no-draft'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(JSON.parse(fs.readFileSync(sentPath, 'utf8')).shows['never-a'], undefined);
  execFileSync(process.execPath, [cli, '--show=never-a', '--no-draft', '--execute'], { cwd: dir, env, encoding: 'utf8' });
  assert.ok(JSON.parse(fs.readFileSync(sentPath, 'utf8')).shows['never-a'].discardedAt);
  assert.throws(() => execFileSync(process.execPath, [cli, '--show=stuck-b', '--no-draft', '--execute'], { cwd: dir, env, stdio: 'pipe' }));
});

// BRO-3087 retro-review (BRO-5261)
test('a leftover cancelled combo does not block a show whose partner was sent later', () => {
  const t = {
    'broadway:a+b': { completed: false, draftId: 'c1', draftStatus: 'cancelled' },
    a: { completed: false, draftId: 'c1', draftStatus: 'cancelled', broadcastKey: 'broadway:a+b' },
    b: { completed: true, draftId: 'c2', draftStatus: 'sent' },
  };
  const dates = new Map([['a', '2026-10-01'], ['b', '2026-10-01']]);
  const cmd = wontSendCommand(t, 'a', 'never-drafted');
  assert.match(cmd, /shows=a -f no_draft=true/);
  assert.equal(dismissBlockReason(t, ['a'], { openingDates: dates, today }), null);
  const writes = planNoDraftDismissal(t, ['a'], { nowIso: 'n', reason: 'r' });
  assert.equal(classifyShowBroadcastState({ ...t, ...writes }, 'b'), 'sent');
  assert.equal(classifyShowBroadcastState({ ...t, ...writes }, 'a'), 'discarded');
});

test('dismissing a draft Resend lost marks the send unverified', () => {
  const writes = planNoDraftDismissal(tracker, ['gone-d'], { nowIso: 'n', reason: 'r' });
  assert.equal(writes['gone-d'].sendUnverified, true);
  const never = planNoDraftDismissal(tracker, ['never-a'], { nowIso: 'n', reason: 'r' });
  assert.equal(never['never-a'].sendUnverified, undefined);
});

test('CLI: --no-draft on an already-dismissed show changes nothing and says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismiss2-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'shows.json'), JSON.stringify({ shows: [{ id: 'never-a', openingDate: '2026-10-01' }] }));
  const sentPath = path.join(dir, 'data', 'opening-night-sent.json');
  const body = JSON.stringify({ shows: { 'never-a': { discardedAt: 'x', draftStatus: 'deleted', completed: false } } });
  fs.writeFileSync(sentPath, body);
  const cli = path.join(here, '..', 'discard-stuck-broadcast-drafts.js');
  const env = { ...process.env, RESEND_API_KEY: '', GITHUB_ACTIONS: 'true' };
  const out = execFileSync(process.execPath, [cli, '--show=never-a', '--no-draft', '--execute'], { cwd: dir, env, encoding: 'utf8' });
  assert.match(out, /Nothing to change/);
  assert.equal(fs.readFileSync(sentPath, 'utf8'), body);
});
