import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('./recheck-reopen.js');
const { ExitTrap } = require('./recheck-autoclose.js');

const NOW = Date.parse('2026-11-18T03:00:00Z');
const failRow = (over = {}) => ({ cardId: 'BRO-1', status: 'fail', verifyCmd: 'node --test scripts/lib/foo.test.mjs', detail: 'AssertionError: expected 1 to be 2', sha: 'abc123def4567', ...over });
const live = (action, cardId, ts, over = {}) => ({ event: 'recheck-reopen', action, mode: 'live', ok: true, cardId, ts, ...over });

test('mode: kill switch beats enforcement, shadow until the bar clears', () => {
  assert.equal(R.reopenMode({ env: { RECHECK_REOPEN: 'off' }, enforcement: { enforcing: true } }).mode, 'off');
  assert.equal(R.reopenMode({ env: {}, enforcement: { enforcing: false, reason: 'not requested' } }).mode, 'shadow');
  assert.equal(R.reopenMode({ env: {}, enforcement: null }).mode, 'shadow');
  assert.equal(R.reopenMode({ env: { GITHUB_ACTIONS: 'true' }, enforcement: { enforcing: true, reason: 'bar cleared' } }).mode, 'live');
});

test('decide: a real fail reopens; everything that is not a real fail does not', () => {
  assert.equal(R.decideReopen({ row: failRow() }).action, 'reopen');
  assert.equal(R.decideReopen({ row: failRow({ status: 'pass' }) }).action, 'none');
  assert.equal(R.decideReopen({ row: failRow({ status: 'unverifiable' }) }).action, 'none');
  assert.equal(R.decideReopen({ row: failRow({ envCause: 'credential-withheld' }) }).action, 'none', 'could-not-run is environment, not a regression');
  assert.equal(R.decideReopen({ row: failRow({ skip: 'someone is working it' }) }).action, 'none');
  assert.equal(R.decideReopen({ row: failRow({ verifyCmd: null }) }).action, 'none');
  assert.equal(R.decideReopen({ row: failRow(), covered: 'BRO-7512' }).action, 'none', 'an open batch card owns it');
  assert.equal(R.decideReopen({ row: failRow(), parked: true }).action, 'none');
});

test('decide: reopened twice, third failure parks', () => {
  assert.equal(R.decideReopen({ row: failRow(), reopenCount: 1 }).action, 'reopen');
  assert.equal(R.decideReopen({ row: failRow(), reopenCount: 2 }).action, 'park');
  assert.equal(R.decideReopen({ row: failRow(), reopenCount: 5 }).action, 'park');
});

test('counters: only LIVE successful reopens count (queued, shadow and refused rows do not)', () => {
  const entries = [
    live('reopened', 'BRO-1', '2026-11-18T01:00:00Z'),
    live('reopened', 'BRO-1', '2026-11-10T01:00:00Z'),
    live('reopened', 'BRO-2', '2026-11-18T02:00:00Z', { ok: false }),
    live('queued', 'BRO-3', '2026-11-18T02:00:00Z', { ok: false }),
    { event: 'recheck-reopen', action: 'would-reopen', mode: 'shadow', ok: false, cardId: 'BRO-4', ts: '2026-11-18T02:00:00Z' },
    live('parked', 'BRO-5', '2026-11-18T02:00:00Z'),
  ];
  const c = R.reopenCounts(entries);
  assert.equal(c.get('BRO-1'), 2);
  assert.equal(c.has('BRO-2') || c.has('BRO-3') || c.has('BRO-4'), false);
  assert.deepEqual([...R.parkedIds(entries)], ['BRO-5']);
  // cap window: a reopen 2h ago is spent tonight, one 8 days ago is not
  assert.equal(R.reopenedWithin(entries, { now: NOW }), 1);
});

test('cap: RECHECK_REOPEN_CAP overrides, junk falls back to 5', () => {
  assert.equal(R.reopenCap({}), 5);
  assert.equal(R.reopenCap({ RECHECK_REOPEN_CAP: '2' }), 2);
  assert.equal(R.reopenCap({ RECHECK_REOPEN_CAP: '0' }), 0);
  assert.equal(R.reopenCap({ RECHECK_REOPEN_CAP: 'lots' }), 5);
  assert.equal(R.reopenCap({ RECHECK_REOPEN_CAP: '9999' }), 5);
});

test('comments carry command, commit, output tail and run URL; park note is plain English', () => {
  const c = R.buildReopenComment({ row: failRow(), sha: 'abc123def4567', runUrl: 'https://github.com/x/y/actions/runs/1', reopenCount: 0, now: new Date(NOW) });
  assert.ok(c.startsWith(R.RECHECK_REOPEN_MARKER));
  for (const needle of ['node --test scripts/lib/foo.test.mjs', 'abc123def456', 'AssertionError', 'actions/runs/1', 'reopen 1 of 2']) assert.ok(c.includes(needle), needle);
  const p = R.buildParkComment({ row: failRow(), sha: 'abc123def4567', runUrl: null, now: new Date(NOW) });
  assert.ok(p.startsWith(R.RECHECK_PARK_MARKER));
  assert.match(p, /owner needs to decide/);
  assert.doesNotMatch(p, /—/);
});

function fakeIssue(stateName) { return { id: 'uuid-1', identifier: 'BRO-1', state: { name: stateName }, description: 'plain' }; }

test('reopenCard: moves a Done card to Todo with the comment; refuses a card already reopened', async () => {
  const calls = [];
  const ok = await R.reopenCard({ identifier: 'BRO-1', comment: 'evidence', getIssue: async () => fakeIssue('Done'), linearBrainMain: async (a) => { calls.push(a); } });
  assert.equal(ok.moved, true);
  assert.deepEqual(calls[0], ['update', 'BRO-1', '--state', 'Todo', '--comment', 'evidence']);
  calls.length = 0;
  const stale = await R.reopenCard({ identifier: 'BRO-1', comment: 'x', getIssue: async () => fakeIssue('In Progress'), linearBrainMain: async (a) => { calls.push(a); } });
  assert.equal(stale.moved, false);
  assert.match(stale.error, /not Done/);
  assert.equal(calls.length, 0, 'no write when the state guard fails');
});

test('parkCard targets Paused; a refusing linear-brain (exit 5) is reported, never thrown', async () => {
  const calls = [];
  const p = await R.parkCard({ identifier: 'BRO-1', comment: 'c', getIssue: async () => fakeIssue('Done'), linearBrainMain: async (a) => { calls.push(a); } });
  assert.equal(p.moved, true);
  assert.equal(calls[0][3], 'Paused');
  const realExit = process.exit;
  const refused = await R.reopenCard({ identifier: 'BRO-1', comment: 'c', getIssue: async () => fakeIssue('Done'), linearBrainMain: async () => { process.exit(5); } });
  assert.equal(process.exit, realExit, 'process.exit restored');
  assert.equal(refused.moved, false);
  assert.match(refused.error, /exited 5/);
});

// Class guard: the reopen path exists only if the nightly script actually calls it. With the wiring
// removed (the state before BRO-7697: failures only reported) this fails.
test('class guard: the nightly recheck wires reopen, gates it on enforcementState, and keeps reopened cards out of the batch route', () => {
  const src = fs.readFileSync(new URL('../autonomous-acceptance-recheck.js', import.meta.url), 'utf8');
  assert.match(src, /reopenLib\.reopenCard/);
  assert.match(src, /reopenLib\.parkCard/);
  assert.match(src, /reopenMode\(\{ enforcement: enforcementState\(cfg/);
  assert.match(src, /handedOff: \[\.\.\.handedOff, \.\.\.reopened, \.\.\.parked, \.\.\.queued\]/);
});

test('ExitTrap is the shared one from recheck-autoclose', () => {
  assert.equal(typeof ExitTrap, 'function');
});

// BRO-7697 item 4: the owner's one number counts the FIRST verdict, so fix-and-reclose cannot launder it.
test('heldShare which:first keeps the first verdict; readDoneHeldLine prints it in plain English', async () => {
  const core = require('./autonomous-recheck-core.js');
  const bc = require('./board-categories.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const row = (cardId, status, ts) => ({ event: 'recheck', cardId, status, ts, sha: 'a', verifyCmd: 'node --test x.test.mjs' });
  const entries = [
    row('BRO-1', 'fail', '2026-11-10T00:00:00Z'), row('BRO-1', 'pass', '2026-11-16T00:00:00Z'), // failed, reopened, fixed
    row('BRO-2', 'pass', '2026-11-12T00:00:00Z'),
    row('BRO-3', 'pass', '2026-11-12T00:00:00Z'),
    row('BRO-4', 'pass', '2026-11-12T00:00:00Z'),
  ];
  const now = Date.parse('2026-11-18T00:00:00Z');
  assert.equal(core.heldShare(entries, { now, days: 30 }).share, 1, 'latest verdict: all pass');
  const first = core.heldShare(entries, { now, days: 30, which: 'first' });
  assert.equal(first.fail, 1);
  assert.equal(first.share, 0.75);
  const f = path.join(os.tmpdir(), `held-${process.pid}.jsonl`);
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n'));
  try {
    const line = bc.readDoneHeldLine(f, { now });
    assert.match(line, /first check\): 75% \(3 of 4\)\. 1 card did not hold/);
    assert.equal(bc.readDoneHeldLine('/nonexistent/ledger.jsonl'), null);
  } finally { fs.rmSync(f, { force: true }); }
});

test('reopen comment carries the quiet-alert note only for an alert-absent check that fired long ago', () => {
  const quiet = failRow({ verifyCmd: 'node scripts/check-alert-condition-absent.js --key-b64 abc', detail: '[check] FAIL: "k" still firing — open, last fired 2026-11-10T00:00:00Z (100.0h ago, within 168h)' });
  assert.match(R.buildReopenComment({ row: quiet, now: new Date(NOW) }), /quiet window/);
  const fresh = failRow({ verifyCmd: 'node scripts/check-alert-condition-absent.js --key-b64 abc', detail: '[check] FAIL: "k" still firing — open, last fired x (2.3h ago, within 168h)' });
  assert.doesNotMatch(R.buildReopenComment({ row: fresh, now: new Date(NOW) }), /quiet window/);
  assert.doesNotMatch(R.buildReopenComment({ row: failRow(), now: new Date(NOW) }), /quiet window/);
});

test('missing core data file is not a regression; local runs stay shadow; first-check skips non-verdict rows', () => {
  const miss = failRow({ detail: "Error: Cannot find module '/tmp/x/data/shows.json'" });
  assert.equal(R.decideReopen({ row: miss }).action, 'none');
  assert.equal(R.reopenMode({ env: {}, enforcement: { enforcing: true, reason: 'r' } }).mode, 'shadow', 'not in CI');
  assert.equal(R.reopenMode({ env: { GITHUB_ACTIONS: 'true' }, enforcement: { enforcing: true, reason: 'r' } }).mode, 'live');
  const core = require('./autonomous-recheck-core.js');
  const mk = (status, ts, extra = {}) => ({ event: 'recheck', cardId: 'BRO-9', status, ts, sha: 'a', verifyCmd: 'node --test x.test.mjs', ...extra });
  const h = core.heldShare([mk('unverifiable', '2026-11-10T00:00:00Z'), mk('fail', '2026-11-12T00:00:00Z')], { now: Date.parse('2026-11-18T00:00:00Z'), which: 'first' });
  assert.equal(h.fail, 1);
});

test('a timeout after the write landed is confirmed on re-read and counted as moved', async () => {
  let reads = 0;
  const r = await R.reopenCard({ identifier: 'BRO-1', comment: 'c', getIssue: async () => ({ id: 'u', state: { name: ++reads === 1 ? 'Done' : 'Todo' }, description: 'p' }), linearBrainMain: async () => { throw new Error('reopen timed out after 30s'); } });
  assert.equal(r.moved, true);
});
