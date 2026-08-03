import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reconcileTaskSessions, redispatchArgv, USAGE } = require('./bsc-reconcile.js');

test('redispatchArgv: the real redispatch command MUST carry --force', () => {
  // Self-review catch (2026-08-03): bsc-next's duplicate-dispatch guard
  // (findLiveWorkspaceForTask) matches on listing+title, never liveness — the
  // dead-but-still-open tab this reconciler confirmed dead via two
  // independent checkLiveness calls is exactly what that guard would
  // otherwise match and refuse as "a live workspace already matches," even
  // though it is not live. Without --force NOTHING this reconciler finds
  // dead would ever actually get re-dispatched.
  const argv = redispatchArgv('853');
  assert.ok(argv.includes('--id'));
  assert.ok(argv.includes('853'));
  assert.ok(argv.includes('--force'), 'missing --force means every redispatch is silently refused by the duplicate-dispatch guard');
});

test('USAGE documents --dry-run and the new task-session re-dispatch behavior', () => {
  assert.match(USAGE, /--dry-run/);
  assert.match(USAGE, /re-dispatches/);
});

// ── reconcileTaskSessions (task #883) ───────────────────────────────────────
const SUBJECT = 'Session-system overhaul S0: hook foundations for the reconciler';
const inProgressTask = (id, subject = SUBJECT) => ({ id: String(id), subject, status: 'in_progress' });
const launch = (taskId, ref, subject = SUBJECT) => ({ event: 'launch', taskId: String(taskId), subject, workspaceRef: ref, ts: '2026-08-02T10:00:00.000Z' });
const ws = (n, title = SUBJECT) => ({ ref: `workspace:${n}`, title });

function harness({ tasks = [], entries = [], workspaces = [], aliveRefs = new Set(), dispatchStatus = 0 } = {}) {
  const reported = [];
  const dispatched = [];
  const woke = { count: 0 };
  const deps = {
    loadTasksFn: () => tasks,
    tasksDir: '/fake/dir',
    listWorkspacesFn: () => workspaces,
    isDoneTitleFn: (title) => String(title).trim().slice(0, 4).includes('✅'),
    claudeAliveInFn: (ref) => aliveRefs.has(ref),
    surfaceAliveInFn: (ref) => aliveRefs.has(ref),
    readLedgerEntriesFn: () => entries,
    wakeFn: () => { woke.count++; },
    clearWakeFn: () => {},
    sleepFn: () => {},
    dispatchFn: (taskId) => { dispatched.push(String(taskId)); return { status: dispatchStatus, stdout: '', stderr: dispatchStatus === 0 ? '' : 'refused' }; },
    reportFn: (line) => reported.push(line),
  };
  return { deps, reported, dispatched, woke };
}

test('reconcileTaskSessions: no in_progress tasks — no-op', () => {
  const { deps, reported, dispatched } = harness({ tasks: [{ id: '1', status: 'pending', subject: SUBJECT }] });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r, { checked: 0, dead: [], redispatched: [] });
  assert.deepEqual(reported, []);
  assert.deepEqual(dispatched, []);
});

test('reconcileTaskSessions: in_progress task with no ledger launch is untracked — never dispatched', () => {
  const { deps, dispatched } = harness({ tasks: [inProgressTask('1')], entries: [] });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, []);
  assert.deepEqual(dispatched, [], 'a task nobody auto-dispatched must never get an auto re-dispatch');
});

test('reconcileTaskSessions: live workspace (alive by both signals) — nothing dead, no wake, no dispatch', () => {
  const { deps, dispatched, woke } = harness({
    tasks: [inProgressTask('1')],
    entries: [launch('1', 'workspace:1')],
    workspaces: [ws(1)],
    aliveRefs: new Set(['workspace:1']),
  });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, []);
  assert.deepEqual(dispatched, []);
  assert.equal(woke.count, 0, 'a healthy sweep never needs to wake cmux');
});

test('reconcileTaskSessions: dead workspace (missing claude process) is re-dispatched via bsc-next --id', () => {
  const { deps, reported, dispatched, woke } = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [ws(12)],
    aliveRefs: new Set(), // neither signal reports alive
  });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, ['853']);
  assert.deepEqual(r.redispatched, ['853']);
  assert.deepEqual(dispatched, ['853']);
  assert.equal(woke.count, 1, 'must wake cmux once before trusting a dead verdict (#849)');
  assert.ok(reported.some(l => l.kind === 'task-session-dead'));
  assert.ok(reported.some(l => l.kind === 'task-redispatched'));
});

test('reconcileTaskSessions: workspace ref missing entirely (vanished OR renumbered) is deferred to bsc-prune, never re-dispatched directly', () => {
  // ship-check P1 fix (2026-08-03): an earlier version tried to disambiguate
  // "vanished" refs itself (title-rematch, else redispatch). That raced
  // bsc-prune's OWN vanished/park sweep — if reconcile fired first, it could
  // re-dispatch a task the owner just closed, before bsc-prune's 'vanished'
  // write ever lands to make bsc-next's parkedGuard refuse it. A missing ref
  // is ambiguous by construction (restart-renumber vs. real close) and that
  // disambiguation belongs to bsc-prune alone — this reconciler only acts
  // when the workspace IS still listed but its claude process died (the
  // literal #853 "found dead manually" shape).
  const { deps, dispatched } = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [], // ref not in the listing at all
  });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, []);
  assert.deepEqual(dispatched, []);

  // Same outcome even when a renumbered twin IS visible under a new ref —
  // reconcile still defers; it's bsc-prune's remap to make, not a reason
  // for reconcile to treat the OLD ref as "confirmed dead" either.
  const { deps: deps2, dispatched: dispatched2 } = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [{ ref: 'workspace:41', title: `🤖⚡ Data·${SUBJECT}` }],
  });
  const r2 = reconcileTaskSessions({ deps: deps2 });
  assert.deepEqual(r2.dead, []);
  assert.deepEqual(dispatched2, []);
});

test('reconcileTaskSessions: a task that already died DEAD_ATTEMPT_LIMIT times is reported, not re-shelled', () => {
  const { deps, reported, dispatched } = harness({
    tasks: [inProgressTask('297')],
    entries: [
      launch('297', 'workspace:12'),
      { event: 'dead', taskId: '297', workspaceRef: 'workspace:9' },
      { event: 'dead', taskId: '297', workspaceRef: 'workspace:10' },
    ],
    workspaces: [ws(12)],
  });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, ['297']);
  assert.deepEqual(r.redispatched, []);
  assert.deepEqual(dispatched, [], 'must never re-shell a task bsc-next has already given up on');
  assert.ok(reported.some(l => l.kind === 'task-redispatch-blocked'));
});

test('reconcileTaskSessions: per-tick redispatch budget throttles a burst, deferring the rest to the next tick', () => {
  const tasks = [inProgressTask('1'), inProgressTask('2'), inProgressTask('3')];
  const entries = [launch('1', 'workspace:1'), launch('2', 'workspace:2'), launch('3', 'workspace:3')];
  const workspaces = [ws(1), ws(2), ws(3)];
  const { deps, reported, dispatched } = harness({ tasks, entries, workspaces }); // all dead (default aliveRefs empty)
  const r = reconcileTaskSessions({ deps });
  assert.equal(r.dead.length, 3);
  assert.equal(dispatched.length, 2, 'only MAX_REDISPATCH_PER_TICK fire this tick');
  assert.ok(reported.some(l => l.kind === 'task-redispatch-throttled'));
});

test('reconcileTaskSessions: a wake that revives the tab cancels the re-dispatch (false alarm)', () => {
  let calls = 0;
  const deps = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [ws(12)],
  }).deps;
  // Alive only AFTER the wake (simulates a dormant, backgrounded-app tab).
  deps.claudeAliveInFn = () => { calls++; return calls > 1; };
  deps.surfaceAliveInFn = () => calls > 1;
  const dispatched = [];
  deps.dispatchFn = (id) => { dispatched.push(id); return { status: 0 }; };
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, [], 'the post-wake re-check must clear the false-dead reading');
  assert.deepEqual(dispatched, []);
});

test('reconcileTaskSessions: ✅-marked (finished) workspace is left for bsc-prune, never re-dispatched', () => {
  const { deps, dispatched } = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [ws(12, `✅ ${SUBJECT}`)],
  });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.dead, []);
  assert.deepEqual(dispatched, []);
});

test('reconcileTaskSessions: bsc-next refusal (e.g. duplicate/park guard) is reported, not treated as success', () => {
  const { deps, reported } = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [ws(12)],
    dispatchStatus: 1,
  });
  const r = reconcileTaskSessions({ deps });
  assert.deepEqual(r.redispatched, []);
  assert.ok(reported.some(l => l.kind === 'task-redispatch-refused'));
});

test('reconcileTaskSessions: --dry-run reports dead sessions but dispatches nothing', () => {
  const { deps, reported, dispatched } = harness({
    tasks: [inProgressTask('853')],
    entries: [launch('853', 'workspace:12')],
    workspaces: [ws(12)],
  });
  const r = reconcileTaskSessions({ dryRun: true, deps });
  assert.deepEqual(r.dead, ['853']);
  assert.deepEqual(dispatched, []);
  assert.ok(reported.some(l => l.kind === 'task-session-dead'));
});

test('reconcileTaskSessions: a failed cmux listing is reported and returns cleanly (no crash)', () => {
  const { deps } = harness({ tasks: [inProgressTask('853')] });
  deps.listWorkspacesFn = () => { throw new Error('cmux socket busy'); };
  const r = reconcileTaskSessions({ deps });
  assert.equal(r.checked, 1);
  assert.deepEqual(r.dead, []);
  assert.ok(r.error);
});

// ── reconcileStalledTasks (owner mandate 2026-08-03: close the loop) ────────
const { reconcileStalledTasks, stallRedispatchArgv, STALL_EVENT, STALL_COOLDOWN_MS } = require('./bsc-reconcile.js');

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const jobSpawned = (taskId, jobId, ts) => ({ event: 'job-spawned', taskId: String(taskId), jobId, ts });
const jobEnd = (taskId, jobId, event, ts) => ({ event, taskId: String(taskId), jobId, ts });

function stallHarness({ tasks = [], entries = [], dispatchStatus = 0 } = {}) {
  const reported = [];
  const dispatched = [];
  const appended = [];
  const deps = {
    loadTasksFn: () => tasks,
    tasksDir: '/fake/dir',
    readLedgerEntriesFn: () => entries,
    appendLedgerFn: (e) => appended.push({ ts: new Date(NOW).toISOString(), ...e }),
    dispatchFn: (taskId) => { dispatched.push(String(taskId)); return { status: dispatchStatus, stderr: 'guard: refused' }; },
    reportFn: (l) => reported.push(l),
    nowFn: () => NOW,
  };
  return { deps, reported, dispatched, appended };
}

test('stallRedispatchArgv deliberately carries NO --force — every bsc-next guard stays armed', () => {
  const argv = stallRedispatchArgv('733');
  assert.ok(argv.includes('--id') && argv.includes('733'));
  assert.ok(!argv.includes('--force'), 'stalled redispatch must go through the fully-guarded path');
});

test('the 2026-08-03 shape: terminal job-failed + in_progress task → reported stalled and redispatched', () => {
  const h = stallHarness({
    tasks: [inProgressTask(733, 'Fix: Test Suite repeat-failure')],
    entries: [jobSpawned(733, 'j1', hoursAgo(6)), jobEnd(733, 'j1', 'job-failed', hoursAgo(5))],
  });
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.deepEqual(r.stalled, ['733']);
  assert.deepEqual(h.dispatched, ['733']);
  assert.ok(h.reported.some(l => l.kind === 'task-stalled' && /job-failed/.test(l.detail)));
  assert.ok(h.appended.some(e => e.event === STALL_EVENT && e.taskId === '733'), 'marker stamped');
});

test('job-done but task still in_progress → stalled, with the never-completed wording', () => {
  const h = stallHarness({
    tasks: [inProgressTask(808, 'BSC Daily: Audience coverage')],
    entries: [jobSpawned(808, 'j2', hoursAgo(6)), jobEnd(808, 'j2', 'job-done', hoursAgo(5))],
  });
  reconcileStalledTasks({ deps: h.deps });
  assert.ok(h.reported.some(l => l.kind === 'task-stalled' && /never completed/.test(l.detail)));
});

test('open headless job → NOT stalled (orphan sweep owns it)', () => {
  const h = stallHarness({
    tasks: [inProgressTask(900)],
    entries: [jobSpawned(900, 'j3', hoursAgo(6))],
  });
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.deepEqual(r.stalled, []);
  assert.deepEqual(h.dispatched, []);
});

test('open workspace launch → NOT stalled (tab sweep owns it)', () => {
  const h = stallHarness({
    tasks: [inProgressTask(901)],
    entries: [launch(901, 'workspace:9')],
  });
  assert.deepEqual(reconcileStalledTasks({ deps: h.deps }).stalled, []);
});

test('no ledger history at all → skipped (hand-claimed sessions are invisible on purpose)', () => {
  const h = stallHarness({ tasks: [inProgressTask(902)], entries: [] });
  assert.deepEqual(reconcileStalledTasks({ deps: h.deps }).stalled, []);
});

test('cooldown: terminal event younger than STALL_COOLDOWN_MS → not yet stalled', () => {
  const freshTs = new Date(NOW - STALL_COOLDOWN_MS / 2).toISOString();
  const h = stallHarness({
    tasks: [inProgressTask(903)],
    entries: [jobSpawned(903, 'j4', hoursAgo(1)), jobEnd(903, 'j4', 'job-failed', freshTs)],
  });
  assert.deepEqual(reconcileStalledTasks({ deps: h.deps }).stalled, []);
});

test('marker newer than last activity → stall already handled, no re-attempt every tick', () => {
  const h = stallHarness({
    tasks: [inProgressTask(904)],
    entries: [
      jobSpawned(904, 'j5', hoursAgo(8)), jobEnd(904, 'j5', 'job-failed', hoursAgo(7)),
      { event: STALL_EVENT, taskId: '904', ts: hoursAgo(6) },
    ],
  });
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.deepEqual(r.stalled, []);
  assert.deepEqual(h.dispatched, []);
});

test('new activity after the marker re-arms the stall', () => {
  const h = stallHarness({
    tasks: [inProgressTask(905)],
    entries: [
      jobSpawned(905, 'j6', hoursAgo(9)), jobEnd(905, 'j6', 'job-failed', hoursAgo(8)),
      { event: STALL_EVENT, taskId: '905', ts: hoursAgo(7) },
      jobSpawned(905, 'j7', hoursAgo(3)), jobEnd(905, 'j7', 'job-failed', hoursAgo(2)),
    ],
  });
  assert.deepEqual(reconcileStalledTasks({ deps: h.deps }).stalled, ['905']);
});

test('refused dispatch still stamps the marker and reports task-stall-refused (no every-tick spam)', () => {
  const h = stallHarness({
    tasks: [inProgressTask(906)],
    entries: [jobSpawned(906, 'j8', hoursAgo(6)), jobEnd(906, 'j8', 'job-failed', hoursAgo(5))],
    dispatchStatus: 1,
  });
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.deepEqual(r.redispatched, []);
  assert.ok(h.reported.some(l => l.kind === 'task-stall-refused'));
  assert.ok(h.appended.some(e => e.event === STALL_EVENT && e.taskId === '906'));
});

test('per-tick budget throttles the third stalled task WITHOUT a marker (retries next tick)', () => {
  const mk = (id, job) => [jobSpawned(id, job, hoursAgo(6)), jobEnd(id, job, 'job-failed', hoursAgo(5))];
  const h = stallHarness({
    tasks: [inProgressTask(910), inProgressTask(911), inProgressTask(912)],
    entries: [...mk(910, 'a'), ...mk(911, 'b'), ...mk(912, 'c')],
  });
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.equal(r.stalled.length, 3);
  assert.equal(h.dispatched.length, 2);
  assert.ok(h.reported.some(l => l.kind === 'task-stall-throttled' && l.taskId === '912'));
  assert.ok(!h.appended.some(e => e.event === STALL_EVENT && e.taskId === '912'), 'throttled task must NOT be marker-stamped');
});

test('dryRun reports but never stamps or dispatches', () => {
  const h = stallHarness({
    tasks: [inProgressTask(913)],
    entries: [jobSpawned(913, 'j9', hoursAgo(6)), jobEnd(913, 'j9', 'job-failed', hoursAgo(5))],
  });
  const r = reconcileStalledTasks({ dryRun: true, deps: h.deps });
  assert.deepEqual(r.stalled, ['913']);
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.appended, []);
});

test('Codex catch: the job-done 48-sessions/day loop is capped — after MAX_STALL_ATTEMPTS_PER_TASK markers, exhausted, no dispatch', () => {
  const { MAX_STALL_ATTEMPTS_PER_TASK } = require('./bsc-reconcile.js');
  // Two prior stall cycles, each: marker → redispatch → job-done without completion.
  const h = stallHarness({
    tasks: [inProgressTask(920)],
    entries: [
      jobSpawned(920, 'k1', hoursAgo(20)), jobEnd(920, 'k1', 'job-done', hoursAgo(19)),
      { event: STALL_EVENT, taskId: '920', ts: hoursAgo(18) },
      jobSpawned(920, 'k2', hoursAgo(17)), jobEnd(920, 'k2', 'job-done', hoursAgo(16)),
      { event: STALL_EVENT, taskId: '920', ts: hoursAgo(15) },
      jobSpawned(920, 'k3', hoursAgo(14)), jobEnd(920, 'k3', 'job-done', hoursAgo(13)),
    ],
  });
  assert.equal(MAX_STALL_ATTEMPTS_PER_TASK, 2);
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.deepEqual(r.stalled, ['920'], 'still reported stalled (honest surface)');
  assert.deepEqual(h.dispatched, [], 'but NO further session is spawned');
  assert.ok(h.reported.some(l => l.kind === 'task-stall-exhausted'));
  assert.ok(h.appended.some(e => e.event === STALL_EVENT), 'exhausted verdict stamps a marker so it reports once per re-arm, not every tick');
});

test('exhausted verdict is silenced by its own marker on the following tick', () => {
  const h = stallHarness({
    tasks: [inProgressTask(921)],
    entries: [
      jobSpawned(921, 'm1', hoursAgo(20)), jobEnd(921, 'm1', 'job-done', hoursAgo(19)),
      { event: STALL_EVENT, taskId: '921', ts: hoursAgo(18) },
      jobSpawned(921, 'm2', hoursAgo(17)), jobEnd(921, 'm2', 'job-done', hoursAgo(16)),
      { event: STALL_EVENT, taskId: '921', ts: hoursAgo(15) },
      jobSpawned(921, 'm3', hoursAgo(14)), jobEnd(921, 'm3', 'job-done', hoursAgo(13)),
      { event: STALL_EVENT, taskId: '921', ts: hoursAgo(12) }, // the exhausted stamp
    ],
  });
  const r = reconcileStalledTasks({ deps: h.deps });
  assert.deepEqual(r.stalled, [], 'marker newer than last activity — quiet until new activity');
  assert.deepEqual(h.dispatched, []);
});

// ── reconcileFlaglessSessions (task #985) ───────────────────────────────────
const { reconcileFlaglessSessions, MAX_REVIVE_PER_TICK } = require('./bsc-reconcile.js');

function flaglessHarness({ workspaces = [], entries = [], alive = () => true, midTurn = () => false, detections = {} } = {}) {
  const reported = [];
  const revived = [];
  const deps = {
    listWorkspacesFn: () => workspaces,
    claudeAliveInFn: (ref) => alive(ref),
    claudeMidTurnInFn: (ref) => midTurn(ref),
    readLedgerEntriesFn: () => entries,
    detectFn: (ref) => detections[ref] || { flagless: false, pid: null, command: null },
    reviveFn: (ref) => { revived.push(ref); return { revived: true, ref, pid: 1, command: `claude --resume x --dangerously-skip-permissions` }; },
    reportFn: (l) => reported.push(l),
  };
  return { deps, reported, revived };
}

test('reconcileFlaglessSessions: flags and revives a 🤖 workspace whose live claude is missing the flag', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:116', title: '🤖⚡ Data·gap-audit-checkpoint-lock-warning' }],
    detections: { 'workspace:116': { flagless: true, pid: 35401, command: 'claude --worktree x --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.flagless, ['workspace:116']);
  assert.deepEqual(r.revived, ['workspace:116']);
  assert.ok(h.reported.some(l => l.kind === 'flagless-session'));
  assert.ok(h.reported.some(l => l.kind === 'flagless-revived'));
});

test('reconcileFlaglessSessions: ignores non-🤖 workspaces even if flagless', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:5', title: 'Owner-opened session' }],
    detections: { 'workspace:5': { flagless: true, pid: 1, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.checked, 0);
  assert.deepEqual(r.flagless, []);
});

test('reconcileFlaglessSessions: 🤖 detected via ledger even without the title glyph (card #971 pattern)', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:200', title: 'Renamed mid-work status line' }],
    entries: [{ event: 'launch', taskId: '985', subject: 'Renamed mid-work status line', workspaceRef: 'workspace:200' }],
    detections: { 'workspace:200': { flagless: true, pid: 2, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.flagless, ['workspace:200']);
});

test('reconcileFlaglessSessions: skips a dead workspace (other sweeps own it)', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:1', title: '🤖 dead tab' }],
    alive: () => false,
    detections: { 'workspace:1': { flagless: true, pid: 1, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.flagless, [], 'a dead workspace must not be flagged by this sweep');
  assert.deepEqual(r.revived, []);
});

test('reconcileFlaglessSessions: already-flagged 🤖 workspace is left alone', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:2', title: '🤖 healthy tab' }],
    detections: { 'workspace:2': { flagless: false, pid: 1, command: 'claude --model sonnet --dangerously-skip-permissions x' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.flagless, []);
  assert.deepEqual(r.revived, []);
});

test('reconcileFlaglessSessions: dryRun reports but never revives', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:116', title: '🤖 gap-audit' }],
    detections: { 'workspace:116': { flagless: true, pid: 1, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ dryRun: true, deps: h.deps });
  assert.deepEqual(r.flagless, ['workspace:116']);
  assert.deepEqual(r.revived, []);
  assert.deepEqual(h.revived, []);
});

test('reconcileFlaglessSessions: per-tick revive budget throttles further flagless tabs', () => {
  const workspaces = Array.from({ length: MAX_REVIVE_PER_TICK + 2 }, (_, i) => ({ ref: `workspace:${i}`, title: '🤖 tab' }));
  const detections = Object.fromEntries(workspaces.map(w => [w.ref, { flagless: true, pid: 1, command: 'claude --resume abc' }]));
  const h = flaglessHarness({ workspaces, detections });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.equal(r.flagless.length, workspaces.length, 'every flagless tab is still reported');
  assert.equal(r.revived.length, MAX_REVIVE_PER_TICK, 'but only the per-tick budget is actually revived');
  assert.ok(h.reported.some(l => l.kind === 'flagless-revive-throttled'));
});

test('reconcileFlaglessSessions: cmux listing failure reports and returns empty, non-fatal', () => {
  const reported = [];
  const r = reconcileFlaglessSessions({
    deps: {
      listWorkspacesFn: () => { throw new Error('socket down'); },
      reportFn: (l) => reported.push(l),
    },
  });
  assert.deepEqual(r, { checked: 0, flagless: [], revived: [] });
  assert.ok(reported.some(l => l.kind === 'flagless-sweep-error'));
});

// Ship-check adversarial finding: a flagless session that hasn't hit its
// first permission-gated tool call yet is still ACTIVELY WORKING, not
// stalled — respawn-pane would kill it mid-task. Only revive when idle.
test('reconcileFlaglessSessions: defers a flagless-but-mid-turn (busy) workspace instead of killing it', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:116', title: '🤖 gap-audit' }],
    midTurn: () => true,
    detections: { 'workspace:116': { flagless: true, pid: 1, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.flagless, ['workspace:116'], 'still reported — the owner should know');
  assert.deepEqual(r.revived, [], 'but NOT revived — killing an active turn would lose in-progress work');
  assert.ok(h.reported.some(l => l.kind === 'flagless-revive-deferred-busy'));
  assert.deepEqual(h.revived, []);
});

test('reconcileFlaglessSessions: revives once the busy session goes idle (mid-turn check reflects current state, not cached)', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:116', title: '🤖 gap-audit' }],
    midTurn: () => false,
    detections: { 'workspace:116': { flagless: true, pid: 1, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.revived, ['workspace:116']);
});

// Same rule as pruneDone's close-path guard (card #971) — never act on a
// workspace the owner is currently looking at; they may already be about to
// hand-approve the stalled prompt.
test('reconcileFlaglessSessions: never revives (or even attempts) the currently-selected workspace', () => {
  const h = flaglessHarness({
    workspaces: [{ ref: 'workspace:116', title: '🤖 gap-audit', selected: true }],
    detections: { 'workspace:116': { flagless: true, pid: 1, command: 'claude --resume abc' } },
  });
  const r = reconcileFlaglessSessions({ deps: h.deps });
  assert.deepEqual(r.checked, 1, 'still counted as an auto-dispatched workspace checked');
  assert.deepEqual(r.flagless, [], 'selected tab is skipped before even running detection');
  assert.deepEqual(r.revived, []);
  assert.deepEqual(h.revived, []);
});
