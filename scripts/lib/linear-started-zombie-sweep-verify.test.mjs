/**
 * BRO-4510: verify-driven decisions for the Linear started-zombie sweep.
 * Pure lib, real functions (CLAUDE.md §15); runVerifyFn/commitOnMainFn stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideZombieAction, classifyZombieComment, commitGrepPattern, countPriorTodoResets,
  countVerifyFails, buildZombieActionComment, applyZombieAction, HUMAN_FRESH_MS,
} = require('./linear-started-zombie-sweep-verify.js');
const { ZOMBIE_RESET_MARKER } = require('./linear-started-zombie-sweep.js');

const SPAWNED = '2026-09-01T00:00:00.000Z';
const NOW = Date.parse('2026-09-10T00:00:00.000Z');
const CMD = 'node --test scripts/lib/foo.test.mjs';
const withVerify = `Fix foo\n\n## Acceptance criteria\n\nVERIFY: ${CMD}\n`;

const issue = (comments = [], description = withVerify) => ({
  identifier: 'BRO-1', description, state: { type: 'started' }, comments: { nodes: comments },
});
const GONE = { exists: false };
const run = (status, detail) => () => ({ status, detail });
const base = (over = {}) => ({
  issue: issue(), spawnedTs: SPAWNED, worktree: GONE, live: false, nowMs: NOW,
  runVerifyFn: run('pass'), commitOnMainFn: () => true, ...over,
});

test('pass + commit names card -> done, even though the worktree is gone', () => {
  const out = decideZombieAction(base());
  assert.equal(out.action, 'done');
  assert.equal(out.cmd, CMD);
});

test('pass but no commit names the card -> leave (could be a vacuous pre-existing pass)', () => {
  assert.equal(decideZombieAction(base({ commitOnMainFn: () => false })).reason, 'verify-pass-no-commit-names-card');
});

test('fail on the second consecutive tick -> todo', () => {
  const out = decideZombieAction(base({ runVerifyFn: run('fail', 'assertion failed'), priorVerifyFails: 1 }));
  assert.equal(out.action, 'todo');
});

test('first fail -> leave (verify-failed-first-strike), never todo', () => {
  const out = decideZombieAction(base({ runVerifyFn: run('fail', 'assertion failed'), priorVerifyFails: 0 }));
  assert.deepEqual([out.action, out.reason], ['leave', 'verify-failed-first-strike']);
});

test('fail that looks like a missing file/module is an environment failure -> leave', () => {
  const out = decideZombieAction(base({ runVerifyFn: run('fail', "Error: Cannot find module './x'"), priorVerifyFails: 5 }));
  assert.equal(out.reason, 'verify-env-failure');
});

test('no safe-form VERIFY -> leave, and the command is never run', () => {
  let ran = false;
  const out = decideZombieAction(base({ issue: issue([], 'no criteria here'), runVerifyFn: () => { ran = true; return { status: 'pass' }; } }));
  assert.deepEqual([out.action, out.reason], ['leave', 'no-safe-verify']);
  assert.equal(ran, false);
});

test('unverifiable result -> leave', () => {
  assert.equal(decideZombieAction(base({ runVerifyFn: run('unverifiable', 'no node_modules') })).reason, 'verify-unverifiable');
});

test('worktree-gone is allowed; an existing dirty/ahead/live worktree is refused', () => {
  assert.equal(decideZombieAction(base({ worktree: GONE })).action, 'done');
  const clean = { exists: true, dirty: false, aheadCount: 0 };
  assert.equal(decideZombieAction(base({ worktree: clean })).action, 'done');
  assert.equal(decideZombieAction(base({ worktree: { ...clean, dirty: true } })).reason, 'worktree-unsafe');
  assert.equal(decideZombieAction(base({ worktree: { ...clean, aheadCount: 2 } })).reason, 'worktree-unsafe');
  assert.equal(decideZombieAction(base({ worktree: { ...clean, error: true } })).reason, 'worktree-unsafe');
  assert.equal(decideZombieAction(base({ worktree: clean, live: true })).reason, 'live-process');
});

test('machine comment shapes after spawn do not count as human', () => {
  const comments = [
    { createdAt: '2026-09-09T23:00:00.000Z', body: 'Dispatched 4dd85cb9 to linear:BRO-1-abc at 2026-09-09T22:00:00.000Z (headless)' },
    { createdAt: '2026-09-09T23:01:00.000Z', body: '**Re-arm (auto, BRO-3395):** the existing acceptance-criteria command was vacuous' },
    { createdAt: '2026-09-09T23:02:00.000Z', body: 'DONE-GATE-BYPASS: mechanism=force target=Done reason=x' },
  ];
  assert.equal(decideZombieAction(base({ issue: issue(comments) })).action, 'done');
});

test('a fresh human-looking comment blocks both done and todo', () => {
  const fresh = [{ createdAt: new Date(NOW - 3600 * 1000).toISOString(), body: 'hold on, I am looking at this' }];
  assert.equal(decideZombieAction(base({ issue: issue(fresh) })).reason, 'human-comment-recent');
});

test('an OLD unclassified comment (the worker\'s own write-up) does not block', () => {
  const old = [{ createdAt: new Date(NOW - HUMAN_FRESH_MS - 3600 * 1000).toISOString(), body: 'Already fixed on main, no change needed.' }];
  assert.equal(decideZombieAction(base({ issue: issue(old) })).action, 'done');
});

test('ordering bug: an unrecognised comment BEFORE a later session report still skips as already-reported', () => {
  const comments = [
    { createdAt: '2026-09-02T00:00:00.000Z', body: 'free-form note' },
    { createdAt: '2026-09-03T00:00:00.000Z', body: '**Session report (done)**\n\nshipped' },
  ];
  assert.deepEqual(
    [decideZombieAction(base({ issue: issue(comments) })).action, decideZombieAction(base({ issue: issue(comments) })).reason],
    ['skip', 'already-reported'],
  );
});

test('our own marker on a still-started issue refuses distinctly', () => {
  const comments = [{ createdAt: '2026-09-02T00:00:00.000Z', body: `${ZOMBIE_RESET_MARKER}: BRO-1 ...` }];
  assert.equal(decideZombieAction(base({ issue: issue(comments) })).reason, 'own-reset-attempt-unconfirmed');
});

test('todo loop guard: two prior Todo resets -> refuse reset-loop', () => {
  const out = decideZombieAction(base({ runVerifyFn: run('fail', 'x'), priorVerifyFails: 1, priorTodoResets: 2 }));
  assert.equal(out.reason, 'reset-loop');
});

test('truncated thread refuses both Done and Todo (newest comments are the hidden ones)', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ createdAt: `2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z`, body: 'old' }));
  assert.equal(decideZombieAction(base({ issue: issue(many) })).reason, 'comment-history-truncated');
  assert.equal(decideZombieAction(base({ issue: issue(many), runVerifyFn: run('fail', 'x'), priorVerifyFails: 1 })).reason, 'comment-history-truncated');
});

test('not started -> skip; missing spawnedTs -> refuse', () => {
  assert.equal(decideZombieAction(base({ issue: { ...issue(), state: { type: 'completed' } } })).action, 'skip');
  assert.equal(decideZombieAction(base({ spawnedTs: null })).reason, 'no-spawned-ts');
});

test('classifyZombieComment recognises each machine shape', () => {
  assert.equal(classifyZombieComment('**Session report (paused)**\n\nx'), 'report');
  assert.equal(classifyZombieComment('just a note'), 'unclassified');
  assert.equal(classifyZombieComment(`${ZOMBIE_RESET_MARKER}: x`), 'own-reset');
});

test('commitGrepPattern is bounded so BRO-44 never matches BRO-447', () => {
  const re = new RegExp(commitGrepPattern('BRO-44'));
  assert.ok(re.test('fix thing (BRO-44)'));
  assert.ok(!re.test('fix thing (BRO-447)'));
  assert.ok(!re.test('XBRO-44'));
});

test('ledger counters: Todo resets by card across jobs; verify-fails per dispatch', () => {
  const rows = [
    { event: 'card-pass', action: 'todo', cardId: 'BRO-1', jobId: 'a' },
    { event: 'card-pass', action: 'todo', cardId: 'BRO-1', jobId: 'b' },
    { event: 'card-pass', action: 'done', cardId: 'BRO-1' },
    { event: 'verify-fail', cardId: 'BRO-1', jobId: 'b' },
    { event: 'verify-fail', cardId: 'BRO-1', jobId: 'c' },
  ];
  assert.equal(countPriorTodoResets(rows, 'BRO-1'), 2);
  assert.equal(countVerifyFails(rows, 'BRO-1', 'b'), 1);
});

test('verify-fail strikes must be consecutive and at least an hour apart', () => {
  const H = 3600 * 1000;
  const now = Date.parse('2026-09-10T12:00:00.000Z');
  const row = (event, agoMs) => ({ event, cardId: 'BRO-1', jobId: 'j', ts: new Date(now - agoMs).toISOString() });
  assert.equal(countVerifyFails([row('verify-fail', 5 * 60 * 1000)], 'BRO-1', 'j', now), 0, 'a fail from the last carry tick is not a prior strike');
  assert.equal(countVerifyFails([row('verify-fail', 7 * H)], 'BRO-1', 'j', now), 1);
  assert.equal(countVerifyFails([row('verify-fail', 14 * H), row('card-leave', 7 * H)], 'BRO-1', 'j', now), 0, 'an intervening non-fail row resets the streak');
});

test('write-back comments carry the marker; applyZombieAction shells the CLI, never --force, and reports exit 5', () => {
  for (const action of ['done', 'todo']) {
    assert.ok(buildZombieActionComment({ action, identifier: 'BRO-1', jobId: 'j', cmd: CMD }).includes(ZOMBIE_RESET_MARKER));
  }
  let seen;
  const r = applyZombieAction({ action: 'done', identifier: 'BRO-1', comment: 'c' }, {
    spawnSyncFn: (bin, args) => { seen = args; return { status: 5, stderr: 'REFUSED (no-evidence)' }; },
  });
  assert.deepEqual(seen.slice(0, 5), ['scripts/linear-brain.js', 'update', 'BRO-1', '--state', 'Done']);
  assert.ok(!seen.includes('--force'));
  assert.equal(r.ok, false);
  assert.match(r.stderr, /REFUSED/);
});
