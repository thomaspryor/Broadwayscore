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
