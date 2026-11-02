import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./autonomous-recheck-core.js');
const { decideHandoff, buildHandoffComment, handoffCard } = require('./recheck-handoff.js');

const NOW = new Date('2026-11-02T10:00:00Z');
const STRONG = 'node --test scripts/lib/foo.test.mjs';
const stamp = 'RECHECK-AFTER: 2026-10-20';
const card = (comments = [stamp], over = {}) => ({ id: 'BRO-1', status: 'Paused', stateType: 'backlog', notes: '', comments, ...over });
const target = (over = {}) => ({ cardId: 'BRO-1', verifyCmd: STRONG, skip: null, reason: null, ...over });
const pass = { status: 'pass', detail: null };

test('autoclose: script-written comments after the stamp do not block a close', () => {
  for (const c of [
    core.RECHECK_HANDOFF_MARKER + '\nhanded off',
    '**Re-arm (auto) acceptance**',
    '[auto-fix-attempted:fail] x',
    '<!-- digest-autofix-refresh -->\n## Problem',
  ]) {
    const v = core.decideAutoClose({ card: card([stamp, c]), target: target(), result: pass, now: NOW });
    assert.equal(v.close, true, c);
  }
});

test('autoclose: a person, a dispatch receipt or a claim after the stamp still blocks the close', () => {
  for (const c of ['[follow-up] still broken', '[red-first follow-up] x', 'looks wrong to me', 'Dispatched abc123 to worker-1', 'Claimed by https://claude.ai/code/session_x']) {
    const v = core.decideAutoClose({ card: card([stamp, c]), target: target(), result: pass, now: NOW });
    assert.equal(v.close, false, c);
    assert.match(v.reason, /comments were added after/);
  }
});

test('handoff: fail, no test, weak test and human-comment-after-stamp go to a worker', () => {
  const weak = core.decideAutoClose({ card: card(), target: target({ verifyCmd: 'test -f x' }), result: pass, now: NOW });
  const human = core.decideAutoClose({ card: card([stamp, 'hmm']), target: target(), result: pass, now: NOW });
  assert.equal(decideHandoff({ card: card(), target: target(), result: { status: 'fail' } }).reason, 'test-failed');
  assert.equal(decideHandoff({ card: card(), target: target({ verifyCmd: null, reason: 'none' }), result: null }).reason, 'no-runnable-test');
  assert.equal(decideHandoff({ card: card(), target: target({ verifyCmd: 'test -f x' }), result: pass, closeVerdict: weak }).reason, 'weak-test');
  assert.equal(decideHandoff({ card: card([stamp, 'hmm']), target: target(), result: pass, closeVerdict: human }).reason, 'human-comment-after-stamp');
});

test('handoff: leaves alone a closable pass, a claimed card, a Todo card and one already handed off', () => {
  const ok = core.decideAutoClose({ card: card(), target: target(), result: pass, now: NOW });
  assert.equal(ok.close, true);
  assert.equal(decideHandoff({ card: card(), target: target(), result: pass, closeVerdict: ok }).handoff, false);
  assert.equal(decideHandoff({ card: card(), target: target({ skip: 'busy' }), result: { status: 'fail' } }).handoff, false);
  assert.equal(decideHandoff({ card: card([stamp], { status: 'Todo' }), target: target(), result: { status: 'fail' } }).handoff, false);
  const again = decideHandoff({ card: card([stamp, buildHandoffComment({ why: 'x', now: NOW })]), target: target(), result: { status: 'fail' } });
  assert.deepEqual(again, { handoff: false, reason: 'already handed off' });
});

test('handoffCard: one linear-brain update to Todo with the marker comment; exit codes become a result', async () => {
  const calls = [];
  const okMain = async (argv) => { calls.push(argv); };
  const r = await handoffCard({ identifier: 'BRO-1', why: 'why', linearBrainMain: okMain, now: NOW, getIssue: async () => ({ state: { name: 'Paused' } }) });
  assert.equal(r.handedOff, true);
  assert.deepEqual(calls[0].slice(0, 4), ['update', 'BRO-1', '--state', 'Todo']);
  assert.ok(calls[0][5].startsWith(core.RECHECK_HANDOFF_MARKER));
  const realExit = process.exit;
  const bad = await handoffCard({ identifier: 'BRO-1', why: 'w', linearBrainMain: async () => { process.exit(5); }, getIssue: async () => ({ state: { name: 'Paused' } }) });
  const moved = await handoffCard({ identifier: 'BRO-1', why: 'w', linearBrainMain: okMain, getIssue: async () => ({ state: { name: 'In Progress' } }) });
  assert.equal(moved.handedOff, false);
  assert.match(moved.error, /In Progress/);
  assert.equal(bad.handedOff, false);
  assert.equal(process.exit, realExit, 'process.exit is restored');
});

test('handoff: a refused auto-close goes to a worker; a parked or owner-held card does not', () => {
  const ok = core.decideAutoClose({ card: card(), target: target(), result: pass, now: NOW });
  assert.equal(decideHandoff({ card: card(), target: target(), result: pass, closeVerdict: ok, closeRefused: 'exit 5' }).reason, 'close-refused');
  assert.equal(decideHandoff({ card: card([stamp], { notes: 'PARKED: needs an API key' }), target: target(), result: { status: 'fail' } }).handoff, false);
  assert.equal(decideHandoff({ card: card([stamp], { notes: 'DECISION NEEDED: x' }), target: target(), result: { status: 'fail' } }).handoff, false);
});
