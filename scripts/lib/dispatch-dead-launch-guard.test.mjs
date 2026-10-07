import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { guardTaskCompletion, reconcileDeadCompletions, shouldCorrectNotionStatus, isManuallyResolved, attachCompletedAtEstimates } = require('./dispatch-dead-launch-guard.js');
const { isLatestDispatchDead, resolveDeadAttempt, latestAttemptForTask, failedLaunchEntries } = require('./dispatch-ledger.js');

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
  assert.equal(flagged[0].notionId, null);
  // Card #1795: deadAttemptTs is the dead entry's own ts — reconcile-dead-
  // completions.js's reopenTask() keys its idempotency marker off this.
  assert.equal(flagged[0].deadAttemptTs, '2026-08-09T12:18:12.910Z');
});

// Card #1795: resolveDeadAttempt is the entry-returning half of
// isLatestDispatchDead — must return the SAME entry that governs the
// boolean, across all three of this file's real-incident ledger shapes.
test('resolveDeadAttempt: returns the dead+unverified-launch entry for the #1140 shape', () => {
  const entry = resolveDeadAttempt('1140', DEAD_LAUNCH_1140);
  assert.equal(entry.ts, '2026-08-09T12:18:12.910Z');
  assert.equal(entry.event, 'launch');
  assert.equal(entry.unverified, true);
});

test('resolveDeadAttempt: null for a healthy latest attempt', () => {
  const entries = [{ ts: '2026-08-09T19:15:41.266Z', event: 'launch', taskId: '1140', workspaceRef: 'workspace:252' }];
  assert.equal(resolveDeadAttempt('1140', entries), null);
});

// Card #1157: reopening the local task-store copy doesn't correct the
// mirrored Notion card notion-tasks-sync.js's push already flipped to
// "Done". notionId is how the caller (reconcile-dead-completions.js) finds
// which card to correct.
test('reconcileDeadCompletions: extracts notionId from a notion-tasks-sync mirrored description', () => {
  const tasks = [{
    id: '1140', status: 'completed',
    subject: 'P1: main red — The Car Man',
    description: '[notion:3b4637c5-416f-81c9-94ba-c956de23e648] P1 Next · In progress · Data\nhttps://notion.so/x\nsome notes',
  }];
  const flagged = reconcileDeadCompletions(tasks, DEAD_LAUNCH_1140);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].notionId, '3b4637c5-416f-81c9-94ba-c956de23e648');
});

test('reconcileDeadCompletions: notionId is null for a native (non-mirrored) task', () => {
  const tasks = [{ id: '1140', status: 'completed', subject: 'x', description: 'no marker here' }];
  const flagged = reconcileDeadCompletions(tasks, DEAD_LAUNCH_1140);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].notionId, null);
});

test('shouldCorrectNotionStatus: true only for "Done"', () => {
  assert.equal(shouldCorrectNotionStatus('Done'), true);
  assert.equal(shouldCorrectNotionStatus('Not started'), false);
  assert.equal(shouldCorrectNotionStatus('In progress'), false);
  assert.equal(shouldCorrectNotionStatus('Paused'), false);
  assert.equal(shouldCorrectNotionStatus(undefined), false);
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

// Real ledger shape from task #1627's incident (card #1697 follow-up): two
// dead+unverified launch attempts, exactly the dead-dispatch pattern this
// guard exists to catch — except #1627 was deliberately marked completed
// out-of-band (its own Notion page 404s permanently; the underlying work
// was independently verified done under a different card) via hand-written
// manuallyResolvedReason/manuallyResolvedAt fields, not through a real
// dispatch. Without the override below, this exact ledger shape reopened a
// legitimately-resolved task (the live 2026-08-17 incident this test guards
// against).
const DEAD_LAUNCH_1627 = [
  { ts: '2026-08-15T11:11:03.908Z', event: 'dead', taskId: '1627', workspaceRef: 'workspace:605', failureReason: 'command injection never ran (no wrapper process appeared) in workspace:605' },
  { ts: '2026-08-15T11:11:03.909Z', event: 'launch', taskId: '1627', workspaceRef: 'workspace:605', model: 'sonnet', unverified: true },
  { ts: '2026-08-15T11:15:43.912Z', event: 'dead', taskId: '1627', workspaceRef: 'workspace:606', failureReason: 'command injection never ran (no wrapper process appeared) in workspace:606' },
  { ts: '2026-08-15T11:15:43.912Z', event: 'launch', taskId: '1627', workspaceRef: 'workspace:606', model: 'sonnet', unverified: true },
];

test('isManuallyResolved: true only when BOTH manuallyResolvedReason and manuallyResolvedAt are non-empty', () => {
  assert.equal(isManuallyResolved({ manuallyResolvedReason: 'x', manuallyResolvedAt: '2026-08-16' }), true);
  assert.equal(isManuallyResolved({ manuallyResolvedReason: 'x' }), false);
  assert.equal(isManuallyResolved({ manuallyResolvedAt: '2026-08-16' }), false);
  assert.equal(isManuallyResolved({ manuallyResolvedReason: '  ', manuallyResolvedAt: '2026-08-16' }), false);
  assert.equal(isManuallyResolved({}), false);
  assert.equal(isManuallyResolved(undefined), false);
});

test('#1697: reconcileDeadCompletions never flags a manually-resolved task, even with a genuinely dead ledger (the #1627 incident)', () => {
  const tasks = [{
    id: '1627', status: 'completed', subject: 'Sweep byline-explosion clusters at threshold=3',
    manuallyResolvedAt: '2026-08-16',
    manuallyResolvedReason: "task #1697: this task's Notion page 404s permanently; underlying work independently completed under a different card",
  }];
  // Sanity: this ledger shape IS dead on its own — proves the override, not
  // an unrelated ledger quirk, is what suppresses the flag.
  assert.equal(isLatestDispatchDead('1627', DEAD_LAUNCH_1627), true);
  assert.deepEqual(reconcileDeadCompletions(tasks, DEAD_LAUNCH_1627), []);
});

test('#1697: reconcileDeadCompletions still flags a dead-dispatch completion with only ONE of the two manual-resolution fields', () => {
  const withReasonOnly = [{ id: '1627', status: 'completed', subject: 'x', manuallyResolvedReason: 'x' }];
  const withAtOnly = [{ id: '1627', status: 'completed', subject: 'x', manuallyResolvedAt: '2026-08-16' }];
  assert.equal(reconcileDeadCompletions(withReasonOnly, DEAD_LAUNCH_1627).length, 1);
  assert.equal(reconcileDeadCompletions(withAtOnly, DEAD_LAUNCH_1627).length, 1);
});

// Card #1770/task #1701: the real incident. Task #1701 completed via a
// healthy attempt on 2026-08-16, then got mistakenly re-dispatched — that
// redispatch died on 2026-08-17. reconcileDeadCompletions reopened it
// anyway because isLatestDispatchDead only ever asked "is the latest
// attempt EVER dead", with no notion of when the task actually completed.
const HEALTHY_THEN_STALE_DEAD_REDISPATCH = [
  { ts: '2026-08-16T10:00:00.000Z', event: 'launch', taskId: '1701', workspaceRef: 'workspace:300', model: 'sonnet' },
  { ts: '2026-08-17T09:00:00.000Z', event: 'dead', taskId: '1701', workspaceRef: 'workspace:301', failureReason: 'command injection never ran' },
  { ts: '2026-08-17T09:00:00.001Z', event: 'launch', taskId: '1701', workspaceRef: 'workspace:301', model: 'sonnet', unverified: true },
];

test('latestAttemptForTask: opts.beforeTs excludes an attempt after the cutoff, returning the last one at/before it', () => {
  const latest = latestAttemptForTask('1701', HEALTHY_THEN_STALE_DEAD_REDISPATCH, { beforeTs: '2026-08-16T12:00:00.000Z' });
  assert.equal(latest.workspaceRef, 'workspace:300');
  assert.equal(latest.event, 'launch');
});

test('latestAttemptForTask: without beforeTs, the stale dead redispatch is still "latest" (pre-fix behavior preserved)', () => {
  const latest = latestAttemptForTask('1701', HEALTHY_THEN_STALE_DEAD_REDISPATCH);
  assert.equal(latest.workspaceRef, 'workspace:301');
});

test('isLatestDispatchDead: a dead redispatch AFTER the beforeTs cutoff does not count — the earlier healthy attempt governs', () => {
  assert.equal(isLatestDispatchDead('1701', HEALTHY_THEN_STALE_DEAD_REDISPATCH, { beforeTs: '2026-08-16T12:00:00.000Z' }), false);
  // Sanity: same ledger with no cutoff IS dead — proves the cutoff, not an
  // unrelated ledger quirk, is what changes the verdict.
  assert.equal(isLatestDispatchDead('1701', HEALTHY_THEN_STALE_DEAD_REDISPATCH), true);
});

test('resolveDeadAttempt: no cutoff returns the stale dead redispatch entry itself (the ts reopenTask keys off)', () => {
  const entry = resolveDeadAttempt('1701', HEALTHY_THEN_STALE_DEAD_REDISPATCH);
  assert.equal(entry.ts, '2026-08-17T09:00:00.001Z');
  assert.equal(entry.workspaceRef, 'workspace:301');
});

test('resolveDeadAttempt: with the beforeTs cutoff before the redispatch, null (governing attempt is healthy)', () => {
  assert.equal(resolveDeadAttempt('1701', HEALTHY_THEN_STALE_DEAD_REDISPATCH, { beforeTs: '2026-08-16T12:00:00.000Z' }), null);
});

test('#1770/#1701: reconcileDeadCompletions never reopens a task whose completion predates a later dead redispatch', () => {
  const tasks = attachCompletedAtEstimates([
    { id: '1701', status: 'completed', subject: 'real shipped work', mtimeMs: Date.parse('2026-08-16T10:05:00.000Z') },
  ]);
  assert.deepEqual(reconcileDeadCompletions(tasks, HEALTHY_THEN_STALE_DEAD_REDISPATCH), []);
});

test('#1770/#1701: reconcileDeadCompletions still flags a task with NO completedAtEstimate (legacy/no-mtime fallback, card #1144 shape preserved)', () => {
  // No mtimeMs → attachCompletedAtEstimates leaves the task untouched →
  // reconcileDeadCompletions falls back to today's exact latest-ever check.
  const tasks = [{ id: '1701', status: 'completed', subject: 'real shipped work' }];
  const flagged = reconcileDeadCompletions(tasks, HEALTHY_THEN_STALE_DEAD_REDISPATCH);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, '1701');
});

// Real production shape (tasks #1115/#1709, caught live against
// data/audit/dispatch-ledger.jsonl while building this fix — an earlier
// version applied opts.beforeTs directly inside latestAttemptForTask and
// false-flagged both). A remap mid-attempt (cmux reassigning workspaceRef,
// see remapEntries()) rewrites the SAME still-running attempt's 'launch' ts
// to a moment after the task's completedAt mtime — a millisecond-scale race
// between "TaskUpdate wrote completed" and "bsc-prune wrote the remap
// breadcrumb for the session that was still finishing up". The overall
// latest-ever attempt (the remapped launch, or the job-done after it) is
// perfectly healthy; a naive ts>beforeTs filter discards it and wrongly
// falls back to an earlier DEAD attempt from before the remap churn even
// started, manufacturing a false dead-completion.
const REMAP_CHURN_THEN_HEALTHY_FINISH = [
  { ts: '2026-08-18T01:30:26.880Z', event: 'dead', taskId: '1115', workspaceRef: 'workspace:742' },
  { ts: '2026-08-18T01:30:26.880Z', event: 'launch', taskId: '1115', workspaceRef: 'workspace:742', unverified: true },
  { ts: '2026-08-18T01:50:42.646Z', event: 'launch', taskId: '1115', workspaceRef: 'workspace:748', unverified: true },
  { ts: '2026-08-18T04:26:13.602Z', event: 'dead', taskId: '1115', workspaceRef: 'workspace:748' },
  // completedAt mtime lands HERE, 04:28:27 — one second before this remap:
  { ts: '2026-08-18T04:28:40.211Z', event: 'remapped', taskId: '1115', workspaceRef: 'workspace:753', newRef: 'workspace:742' },
  { ts: '2026-08-18T04:28:40.211Z', event: 'launch', taskId: '1115', workspaceRef: 'workspace:742' },
  { ts: '2026-08-18T04:32:41.258Z', event: 'remapped', taskId: '1115', workspaceRef: 'workspace:742', newRef: 'workspace:748' },
  { ts: '2026-08-18T04:32:41.258Z', event: 'launch', taskId: '1115', workspaceRef: 'workspace:748' },
  { ts: '2026-08-18T04:34:14.980Z', event: 'prune-closed', taskId: '1115', workspaceRef: 'workspace:748' },
];

test('isLatestDispatchDead: a remap-rewritten healthy attempt AFTER beforeTs is trusted, not discarded for an earlier dead one inside the cutoff', () => {
  const beforeTs = '2026-08-18T04:28:27.043Z'; // between the 04:26 dead entry and the 04:28:40 remap
  assert.equal(isLatestDispatchDead('1115', REMAP_CHURN_THEN_HEALTHY_FINISH, { beforeTs }), false);
});

test('resolveDeadAttempt: null for the remap-then-healthy-finish shape — never manufactures a deadAttemptTs for real work', () => {
  const beforeTs = '2026-08-18T04:28:27.043Z';
  assert.equal(resolveDeadAttempt('1115', REMAP_CHURN_THEN_HEALTHY_FINISH, { beforeTs }), null);
});

test('#1115/#1709: reconcileDeadCompletions never reopens a task whose real latest-ever attempt is healthy, even if a remap pushed its ts past completedAt', () => {
  const tasks = attachCompletedAtEstimates([
    { id: '1115', status: 'completed', subject: 'Ensemble Phase B', mtimeMs: Date.parse('2026-08-18T04:28:27.043Z') },
  ]);
  assert.deepEqual(reconcileDeadCompletions(tasks, REMAP_CHURN_THEN_HEALTHY_FINISH), []);
});

test('attachCompletedAtEstimates: only stamps completed tasks with a finite mtimeMs; leaves everything else untouched', () => {
  const tasks = [
    { id: '1', status: 'completed', mtimeMs: 1755331200000 },
    { id: '2', status: 'pending', mtimeMs: 1755331200000 },
    { id: '3', status: 'completed' }, // no mtimeMs
  ];
  const out = attachCompletedAtEstimates(tasks);
  assert.equal(out[0].completedAtEstimate, new Date(1755331200000).toISOString());
  assert.equal(out[1].completedAtEstimate, undefined);
  assert.equal(out[2].completedAtEstimate, undefined);
});
