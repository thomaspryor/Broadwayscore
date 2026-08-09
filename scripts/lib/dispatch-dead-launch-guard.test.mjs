import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { guardTaskCompletion, reconcileDeadCompletions } = require('./dispatch-dead-launch-guard.js');
const { isLatestDispatchDead, latestAttemptForTask, failedLaunchEntries } = require('./dispatch-ledger.js');

// Ship-check adversarial finding (card #1144): isLatestDispatchDead's
// unverified-launch check only works because it matches failedLaunchEntries()'s
// exact output shape. Feeding the REAL function's output through — instead of
// only a hand-copied literal — means a future change to that shape fails THIS
// test, not just silently stops being caught by the guard.
test('isLatestDispatchDead recognizes the REAL failedLaunchEntries() output as dead', () => {
  const entries = failedLaunchEntries({ taskId: '500', subject: 'x', workspaceRef: 'workspace:99' });
  assert.equal(entries.length, 2);
  assert.equal(isLatestDispatchDead('500', entries), true);
});

// Real ledger shape from task #1140's incident (card #1144): failedLaunchEntries()
// writes 'dead' first, then an unverified:true 'launch' for the SAME attempt.
const DEAD_LAUNCH_1140 = [
  { ts: '2026-08-09T12:18:12.909Z', event: 'dead', taskId: '1140', workspaceRef: 'workspace:250', failureReason: 'command injection never ran' },
  { ts: '2026-08-09T12:18:12.910Z', event: 'launch', taskId: '1140', workspaceRef: 'workspace:250', model: 'sonnet', unverified: true },
];

test('isLatestDispatchDead: true for the exact #1140 dead+unverified-launch shape', () => {
  assert.equal(isLatestDispatchDead('1140', DEAD_LAUNCH_1140), true);
});

test('guardTaskCompletion: blocks marking #1140 completed while its latest dispatch is dead', () => {
  const result = guardTaskCompletion({ taskId: '1140', status: 'completed', entries: DEAD_LAUNCH_1140 });
  assert.equal(result.block, true);
  assert.match(result.reason, /#1140/);
  assert.match(result.reason, /never actually launched/);
});

test('guardTaskCompletion: never blocks a non-completed status transition', () => {
  assert.deepEqual(guardTaskCompletion({ taskId: '1140', status: 'in_progress', entries: DEAD_LAUNCH_1140 }), { block: false });
  assert.deepEqual(guardTaskCompletion({ taskId: '1140', status: 'pending', entries: DEAD_LAUNCH_1140 }), { block: false });
});

test('a later VERIFIED launch supersedes the earlier death — never permanently blocked', () => {
  const entries = [
    ...DEAD_LAUNCH_1140,
    { ts: '2026-08-09T19:15:41.266Z', event: 'launch', taskId: '1140', workspaceRef: 'workspace:252', model: 'sonnet' },
  ];
  assert.equal(isLatestDispatchDead('1140', entries), false);
  assert.equal(guardTaskCompletion({ taskId: '1140', status: 'completed', entries }).block, false);
});

test('a trailing prune-closed (successful finish) after the real launch changes nothing — still allowed', () => {
  const entries = [
    ...DEAD_LAUNCH_1140,
    { ts: '2026-08-09T19:15:41.266Z', event: 'launch', taskId: '1140', workspaceRef: 'workspace:252', model: 'sonnet' },
    { ts: '2026-08-09T19:29:54.818Z', event: 'prune-closed', taskId: '1140', workspaceRef: 'workspace:252' },
  ];
  assert.equal(isLatestDispatchDead('1140', entries), false);
});

test('a task with zero ledger entries is never blocked (manual/owner-worked tasks)', () => {
  assert.equal(isLatestDispatchDead('9999', []), false);
  assert.equal(guardTaskCompletion({ taskId: '9999', status: 'completed', entries: [] }).block, false);
});

test('a task with entries but none for this taskId is never blocked', () => {
  assert.equal(isLatestDispatchDead('9999', DEAD_LAUNCH_1140), false);
});

test('headless job-failed as the latest attempt counts as dead too', () => {
  const entries = [
    { ts: '2026-08-09T10:00:00.000Z', event: 'launch', taskId: '42', workspaceRef: 'headless:42', model: 'sonnet' },
    { ts: '2026-08-09T10:00:01.000Z', event: 'job-spawned', taskId: '42', jobId: 'job-1' },
    { ts: '2026-08-09T10:05:00.000Z', event: 'job-failed', taskId: '42', jobId: 'job-1', stage: 'worktree-error' },
  ];
  assert.equal(isLatestDispatchDead('42', entries), true);
  assert.equal(guardTaskCompletion({ taskId: '42', status: 'completed', entries }).block, true);
});

test('headless job-done as the latest attempt is NOT dead', () => {
  const entries = [
    { ts: '2026-08-09T10:00:00.000Z', event: 'launch', taskId: '42', workspaceRef: 'headless:42', model: 'sonnet' },
    { ts: '2026-08-09T10:00:01.000Z', event: 'job-spawned', taskId: '42', jobId: 'job-1' },
    { ts: '2026-08-09T10:05:00.000Z', event: 'job-done', taskId: '42', jobId: 'job-1', costUSD: 0.12 },
  ];
  assert.equal(isLatestDispatchDead('42', entries), false);
});

test('latestAttemptForTask ignores non-attempt bookkeeping events (prune, vanish-epoch)', () => {
  const entries = [
    { ts: '2026-08-09T10:00:00.000Z', event: 'launch', taskId: '7', workspaceRef: 'workspace:1' },
    { ts: '2026-08-09T10:05:00.000Z', event: 'prune', taskId: 'sweep', closed: 3, skipped: 1 },
    { ts: '2026-08-09T10:06:00.000Z', event: 'vanish-epoch', taskId: 'epoch' },
  ];
  const latest = latestAttemptForTask('7', entries);
  assert.equal(latest.event, 'launch');
  assert.equal(latest.workspaceRef, 'workspace:1');
});

test('reconcileDeadCompletions: flags a completed task whose latest dispatch is dead', () => {
  const tasks = [
    { id: '1140', status: 'completed', subject: 'P1: main red — The Car Man' },
    { id: '42', status: 'completed', subject: 'headless task' },
  ];
  const entries = [
    ...DEAD_LAUNCH_1140,
    { ts: '2026-08-09T10:00:00.000Z', event: 'launch', taskId: '42', workspaceRef: 'headless:42' },
    { ts: '2026-08-09T10:05:00.000Z', event: 'job-done', taskId: '42', jobId: 'job-1' },
  ];
  const flagged = reconcileDeadCompletions(tasks, entries);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, '1140');
});

test('reconcileDeadCompletions: never flags a pending/in_progress task, even if its dispatch is dead', () => {
  const tasks = [{ id: '1140', status: 'pending', subject: 'P1: main red — The Car Man' }];
  assert.deepEqual(reconcileDeadCompletions(tasks, DEAD_LAUNCH_1140), []);
});

test('reconcileDeadCompletions: never flags a completed task with a healthy dispatch', () => {
  const tasks = [{ id: '1140', status: 'completed', subject: 'x' }];
  const entries = [{ ts: '2026-08-09T19:15:41.266Z', event: 'launch', taskId: '1140', workspaceRef: 'workspace:252' }];
  assert.deepEqual(reconcileDeadCompletions(tasks, entries), []);
});
