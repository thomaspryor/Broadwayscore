import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');
const { ensureAutoTitle } = require('../lib/workspace-naming.js');

const NOW = Date.parse('2026-08-06T15:00:00Z');
const T = m => new Date(NOW - m * 60000).toISOString();

function task(id, status, priLine) {
  return [String(id), {
    id: String(id), subject: `Fix thing ${id}`, status,
    description: priLine ? `[notion:abc-${id}] ${priLine} · Not started · no-category\nbody` : 'native task',
  }];
}
// BRO-3878: the Linear-board counterpart of task() — the retired Notion
// mirror is no longer a p01Queue source, so any test exercising FRESH
// backlog admission (priority ordering, category exclusion, archive
// exclusion, claim-suppression budgets) must fixture a live-board id.
function lin(identifier, status, priLine) {
  const id = `linear:${identifier}`;
  return [id, {
    id, subject: `Fix thing ${id}`, status,
    description: priLine ? `[linear:${identifier}] ${priLine} · Backlog · no-category\nbody` : 'native task',
  }];
}
const titles = pairs => new Map(pairs);
const LIVE = titles([['workspace:1', '🤖⚡ Data·something'], ['workspace:99', '🤖 Site·other']]);

test('ledger-confirmed dead launch with open task is retryable', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: 'linear:BRO-10', subject: 'Fix thing 10', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: 'linear:BRO-10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([lin('BRO-10', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.toDispatch[0].taskId, 'linear:BRO-10');
});

// BRO-3878: a Notion-mirror task with the SAME dead-launch shape must never
// enter retryable — the retry path is a fresh-claim source too (Codex
// ship-check catch: the p01Queue exclusion alone left this loop still
// generating watchdog-redispatch claims against the frozen mirror).
test('BRO-3878: a dead launch against a Notion-mirror task is never retried', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 'Fix thing 10', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([task(10, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0);
  assert.equal(plan.toDispatch.length, 0);
});

test('#1154: an owner-judgment card that died is NEVER retried (retry bypasses actionable())', () => {
  // The Sarah check-in shape: launched once, session died, then re-dispatched
  // by dead-session recovery — which goes through `bsc-next --id` and so skips
  // the pick filter entirely. The P0/P1 backlog sweep alone does not cover it.
  const marked = ['linear:BRO-12', {
    id: 'linear:BRO-12',
    subject: 'Sarah check-in: growth plan progress and metrics report',
    status: 'in_progress',
    description: '[linear:BRO-12] P2 Later · Not started · Admin\nDue 2026-05-23. Ask Sarah for status.\n\nVERIFY: owner-judgment (owner must read the report)',
  }];
  const entries = [
    { ts: T(60), event: 'launch', taskId: 'linear:BRO-12', subject: 'Sarah check-in', workspaceRef: 'workspace:7' },
    { ts: T(30), event: 'dead', taskId: 'linear:BRO-12', workspaceRef: 'workspace:7' },
  ];
  const plan = core.planSweep(entries, new Map([marked]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0, 'owner-judgment card must not be retryable');
  assert.equal(plan.toDispatch.filter(d => d.taskId === 'linear:BRO-12').length, 0, 'and must never be dispatched');

  // Control: identical ledger, identical Admin category, marker removed -> retried.
  const control = ['linear:BRO-12', { ...marked[1], description: marked[1].description.replace(/VERIFY:\s*owner-judgment/i, 'VERIFY: nothing') }];
  const plan2 = core.planSweep(entries, new Map([control]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan2.retryable.length, 1, 'without the marker the same card IS retryable');
});

test('vanished (owner-closed) is never retried — terminal reason matters', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '11', subject: 's', workspaceRef: 'workspace:6' },
    { ts: T(30), event: 'vanished', taskId: '11', workspaceRef: 'workspace:6' },
    { ts: T(29), event: 'dead', taskId: '11', workspaceRef: 'workspace:6' }, // older dead exists too
  ];
  // most recent terminal is 'dead' here — reorder so vanished is last
  entries[1].ts = T(20);
  const plan = core.planSweep(entries, new Map([task(11, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0);
  assert.equal(plan.toPark.length, 0);
});

test('completed task is landed — not in flight, not retried', () => {
  const entries = [{ ts: T(60), event: 'launch', taskId: '12', subject: 's', workspaceRef: 'workspace:7' }];
  const plan = core.planSweep(entries, new Map([task(12, 'completed')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.inFlight.length, 0);
  assert.equal(plan.toDispatch.length, 0);
});

test('open launch with open task is in flight; not re-dispatched', () => {
  const entries = [{ ts: T(10), event: 'launch', taskId: '13', subject: 's', workspaceRef: 'workspace:1' }];
  const plan = core.planSweep(entries, new Map([task(13, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.inFlight.length, 1);
  assert.equal(plan.inFlight[0].listed, true);
  assert.equal(plan.toDispatch.length, 0);
});

// Card #1233: 2 infra-only deaths (paired unverified launch — cmux's terminal
// surface never rendered) must NOT park a task; the substantive cap only
// counts substantive deaths. But a task that fails to even boot
// INFRA_DEAD_ATTEMPT_LIMIT times in a row (cmux itself looks wedged) still
// must park eventually — and the parked item must carry reason:'infra' with
// deaths reflecting the INFRA count, not 0, or the owner-facing message in
// dispatch-watchdog.js reads "parked after 0 dead dispatch attempts" (ship-
// check catch on the first cut of this fix).
test('2 infra-only deaths do not park; INFRA_DEAD_ATTEMPT_LIMIT infra deaths in a row park with reason:infra and a non-zero death count', () => {
  // Shape-1 classification (dispatch-attempts.js foldAttempts) only checks
  // that the paired launch is unverified AND within PAIR_WINDOW_MS of the
  // dead row — not which one was written first. Real bsc-next writes 'dead'
  // then the paired 'launch' ~1-2ms later; this fixture writes launch then
  // dead ~50ms later, which is equally a valid shape-1 pair for
  // classification purposes AND satisfies lastTerminalEventForTask's
  // separate, pre-existing requirement that a task's terminal event land
  // at-or-after its last launch (unrelated to card #1233 — every OTHER
  // passing test in this file already relies on launch-before-dead
  // ordering for exactly this reason).
  const infraPair = (ref, launchM, deadM) => ([
    { ts: T(launchM), event: 'launch', taskId: 'linear:BRO-15', subject: 's', workspaceRef: ref, unverified: true },
    { ts: T(deadM), event: 'dead', taskId: 'linear:BRO-15', workspaceRef: ref, failureReason: 'command injection never ran' },
  ]);
  const twoInfra = [...infraPair('workspace:20', 90, 89.9999), ...infraPair('workspace:21', 80, 79.9999)];
  const planTwo = core.planSweep(twoInfra, new Map([lin('BRO-15', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(planTwo.toPark.length, 0, '2 infra deaths must not park');

  const tenInfra = [];
  for (let i = 0; i < 10; i++) tenInfra.push(...infraPair(`workspace:${30 + i}`, 90 - i, 90 - i - 0.0001));
  const planTen = core.planSweep(tenInfra, new Map([lin('BRO-15', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(planTen.toPark.length, 1, '10 infra deaths in a row must still park (wedged-host ceiling)');
  assert.equal(planTen.toPark[0].reason, 'infra');
  assert.equal(planTen.toPark[0].deaths, 10, 'deaths must reflect the infra count, never 0, for the owner-facing message');
});

test('DEAD_ATTEMPT_LIMIT deaths -> park once; parked card never re-parks or re-dispatches across 100 sweeps (pre-mortem P0)', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: 'linear:BRO-14', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(80), event: 'dead', taskId: 'linear:BRO-14', workspaceRef: 'workspace:8' },
    { ts: T(70), event: 'launch', taskId: 'linear:BRO-14', subject: 's', workspaceRef: 'workspace:9' },
    { ts: T(60), event: 'dead', taskId: 'linear:BRO-14', workspaceRef: 'workspace:9' },
  ];
  const tasks = new Map([lin('BRO-14', 'in_progress')]);
  const first = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(first.toPark.length, 1, 'first sweep parks');
  assert.equal(first.toDispatch.length, 0);
  // CLI appends the park event; every later sweep must be silent about #14
  entries.push({ ts: T(59), event: core.WATCHDOG_EVENTS.PARK, taskId: 'linear:BRO-14' });
  for (let i = 0; i < 100; i++) {
    const p = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
    assert.equal(p.toPark.length, 0, `sweep ${i} re-parked`);
    assert.equal(p.toDispatch.length, 0);
  }
});

test('a fresh launch clears a watchdog park (self-healing, same rule as vanished-park)', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: '15', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(80), event: core.WATCHDOG_EVENTS.PARK, taskId: '15' },
    { ts: T(70), event: 'launch', taskId: '15', subject: 's', workspaceRef: 'workspace:9' },
  ];
  assert.equal(core.watchdogParkedIds(entries).has('15'), false);
});

test('undispatched P0/P1 pending cards queue, P0 first; marketing/human cards excluded', () => {
  const tasks = new Map([
    lin('BRO-20', 'pending', 'P1 Now'),
    lin('BRO-19', 'pending', 'P0 Now'),
    ['linear:BRO-21', { id: 'linear:BRO-21', subject: 'Email volunteers', status: 'pending', description: '[linear:BRO-21] P1 Now · Not started · Marketing\n' }],
    lin('BRO-22', 'pending', 'P2 Later'),
    // BRO-3878: a Notion-mirror P0 that would otherwise sort FIRST (the
    // mirror froze 2026-08-20) must never enter the fresh backlog queue.
    task(1, 'pending', 'P0 Now'),
  ]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), ['linear:BRO-19', 'linear:BRO-20']);
  assert.deepEqual(plan.toDispatch.map(q => q.taskId), ['linear:BRO-19', 'linear:BRO-20']);
});

// BRO-4076: live incident — BRO-4066 was landed-acked at 07:38:55Z (a
// Linear COMMENT, not a state change — ack-landed.js never moves the issue),
// then the p01-backlog sweep at 08:54:07Z re-selected and re-dispatched it
// anyway because the task mirror still read 'pending'. The newest ledger row
// must now suppress it even though `task.status` never changed.
test('BRO-4076: a pending P0/P1 card whose newest ledger row is landed-acked is excluded from p01Queue', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: 'linear:BRO-19', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'job-stopped-short', taskId: 'linear:BRO-19' },
    { ts: T(10), event: 'landed-acked', taskId: 'linear:BRO-19', jobId: 'j1', sha: 'abc123' },
  ];
  const tasks = new Map([lin('BRO-19', 'pending', 'P0 Now')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), [],
    'a landed-acked card must not re-enter the fresh-backlog queue');
});

test('BRO-4076: a pending P0/P1 card whose newest ledger row is landed-before-dispatch is excluded from p01Queue', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: 'linear:BRO-19', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'job-stopped-short', taskId: 'linear:BRO-19' },
    { ts: T(10), event: 'landed-before-dispatch', taskId: 'linear:BRO-19', jobId: 'j1', sha: 'abc123' },
  ];
  const tasks = new Map([lin('BRO-19', 'pending', 'P0 Now')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), []);
});

// No-over-exclusion control: a NON-landed terminal outcome (job-failed) must
// not trip the new check — the card is still genuinely undispatched work.
// Headless-lane rows only (job-spawned/job-failed, no separate cmux 'launch')
// so the task is excluded from `open` via TERMINAL_JOB_EVENTS, not still
// treated as an in-flight cmux launch.
test('BRO-4076: a pending P0/P1 card whose newest ledger row is job-failed (not landed) still queues', () => {
  const entries = [
    { ts: T(90), event: 'job-spawned', taskId: 'linear:BRO-19', jobId: 'j1', workspaceRef: 'headless:linear:BRO-19' },
    { ts: T(10), event: 'job-failed', taskId: 'linear:BRO-19', jobId: 'j1' },
  ];
  const tasks = new Map([lin('BRO-19', 'pending', 'P0 Now')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), ['linear:BRO-19'],
    'a non-landed terminal outcome must not suppress genuinely undispatched work');
});

// Direct unit coverage of the pure predicate (CLAUDE.md rule 15: require()
// the real function). job-spawned is the ticket's own acceptance-criteria
// example of "still eligible" — tested directly here because a card whose
// newest row is job-spawned is ALSO always in planSweep's `open` set (a
// non-terminal folded job), so a full-planSweep test of that exact shape
// would only exercise the pre-existing `open.has(id)` exclusion, never this
// predicate.
// Codex adversarial review (BRO-4076 ship-check): bare job-done is
// deliberately NOT terminal here — see NO_FURTHER_DISPATCH_EVENTS's own
// comment. Only the explicitly-verified landed-acked/landed-before-dispatch
// events suppress; a bare job-done card is left to BRO-3424's unlandedDone
// mechanism instead, so it can still be caught (and re-armed) if the "done"
// self-report was wrong.
test('BRO-4076: hasNoFurtherDispatchWork — landed-acked/landed-before-dispatch are terminal, job-done/job-spawned/job-failed/no-rows are not', () => {
  const landedAcked = [{ ts: T(1), event: 'landed-acked', taskId: 'linear:BRO-1' }];
  const landedBefore = [{ ts: T(1), event: 'landed-before-dispatch', taskId: 'linear:BRO-1' }];
  const jobDone = [{ ts: T(1), event: 'job-done', taskId: 'linear:BRO-1' }];
  const jobSpawned = [{ ts: T(1), event: 'job-spawned', taskId: 'linear:BRO-1' }];
  const jobFailed = [{ ts: T(1), event: 'job-failed', taskId: 'linear:BRO-1' }];
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', landedAcked), true);
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', landedBefore), true);
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', jobDone), false);
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', jobSpawned), false);
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', jobFailed), false);
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', []), false);
});

// Codex adversarial review: a raw "newest row of any type" read would be
// un-suppressed by a LATER, unrelated 'prune-closed' row (bsc-prune.js's own
// async cleanup of an old dead workspace, independent of the ack). Only a
// fresh launch/job-spawned may clear a landed verdict.
test('BRO-4076: a prune-closed row written AFTER landed-acked (delayed cleanup sweep) does not un-suppress the card', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: 'linear:BRO-1', workspaceRef: 'workspace:1' },
    { ts: T(60), event: 'landed-acked', taskId: 'linear:BRO-1', jobId: 'j1' },
    // bsc-prune's sweep catches up on the now-idle old workspace afterwards.
    { ts: T(1), event: 'prune-closed', taskId: 'linear:BRO-1', workspaceRef: 'workspace:1' },
  ];
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', entries), true);
});

// A genuinely fresh redispatch (new launch/job-spawned AFTER the ack) DOES
// clear the suppression — landed-acked must never permanently block real new
// work on a card that was legitimately redispatched later.
test('BRO-4076: a fresh launch after landed-acked clears the suppression', () => {
  const entries = [
    { ts: T(90), event: 'landed-acked', taskId: 'linear:BRO-1', jobId: 'j1' },
    { ts: T(10), event: 'launch', taskId: 'linear:BRO-1', workspaceRef: 'workspace:9' },
  ];
  assert.equal(core.hasNoFurtherDispatchWork('linear:BRO-1', entries), false);
});

// The retry loop (dead-launch retries, a separate ~50-line block above
// p01Queue) had the identical bypass: launch -> dead -> landed-acked left
// `lastTerminalEventForTask` reading 'dead' as the latest LAUNCH-terminal
// event (landed-acked isn't a launch-terminal event), so the card still
// re-entered `retryable` and got redispatched (Codex adversarial catch).
test('BRO-4076: launch->dead->landed-acked is excluded from the retry loop too, not just p01Queue', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: 'linear:BRO-14', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(60), event: 'dead', taskId: 'linear:BRO-14', workspaceRef: 'workspace:8' },
    { ts: T(30), event: 'landed-acked', taskId: 'linear:BRO-14', jobId: 'j1' },
  ];
  const tasks = new Map([lin('BRO-14', 'in_progress')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0, 'a landed-acked card must not be retried as a dead launch');
  assert.equal(plan.toDispatch.length, 0);
});

// BRO-3633: loadTasksUnioned() (audit-dispatch-outcomes.js) unions live/ +
// archive/ and tags each task fromArchive so planSweep can tell "still live"
// apart from "deliberately shelved". task-store-archive.js's pending-task
// archival moves a stale-but-still-'pending' card to archive/ byte-for-byte
// after 30+ days untouched — not a completion signal — and without this
// guard p01Queue treated the resurrected card as fresh P0/P1 backlog,
// claimed it, it never produced a launch, and got parked with a
// retired-board (bare-numeric) id, which is exactly what tripped
// board-targeting-audit.js's "Dispatch: board targeting" health-check row.
test('BRO-3633: an archived-but-pending P0/P1 card is excluded from p01Queue', () => {
  const [liveId, liveTask] = lin('BRO-19', 'pending', 'P0 Now');
  const [archivedId, archivedTask] = lin('BRO-23', 'pending', 'P0 Now');
  const tasks = new Map([
    [liveId, liveTask],
    [archivedId, { ...archivedTask, fromArchive: true }],
  ]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), ['linear:BRO-19'],
    'the archived card must never re-enter the fresh-backlog queue');
});

test('BRO-3633: a dead dispatch against an archived task is not auto-retried', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '24', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '24', workspaceRef: 'workspace:5' },
  ];
  const [id, archivedTask] = task(24, 'in_progress');
  const tasks = new Map([[id, { ...archivedTask, fromArchive: true }]]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0, 'an archived task must not be auto-retried');
  assert.equal(plan.toPark.length, 0, 'nor auto-parked — it was never queued for retry in the first place');
});

// ship-check/Codex catch: p01Queue no longer CREATES new claims for archived
// tasks, but a claim can already sit in the ledger from just before this
// fix landed. Without the same guard on awaitingClaim, that pre-existing
// claim would still age past CLAIM_LABEL_GRACE_MS and get promoted to
// noLaunchPark — reproducing the exact retired-board park this card exists
// to stop, just via a different entry point.
test('BRO-3633: a pre-existing claim on an archived task is not promoted to awaitingClaim/noLaunchPark', () => {
  const entries = [{ ts: new Date(NOW - core.CLAIM_LABEL_GRACE_MS - 60000).toISOString(), event: 'watchdog-redispatch', taskId: '27', kind: 'p01-backlog' }];
  const [id, liveTask] = task(27, 'pending', 'P1 Now');
  const tasks = new Map([[id, { ...liveTask, fromArchive: true }]]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.awaitingClaim.length, 0, 'the stale claim must not surface as a labelled failure');
  assert.equal(plan.noLaunchPark.length, 0, 'and must never be promoted to an actual park');
});

// ship-check/Codex catch: the two tests above manufacture `fromArchive: true`
// by hand — they'd pass even if loadTasksUnioned() stopped setting the tag
// entirely. This one exercises the real loader (audit-dispatch-outcomes.js)
// against real files, in an isolated $HOME so it never touches this
// machine's actual ~/.claude/tasks/.
test('BRO-3633: loadTasksUnioned() actually tags fromArchive from real files, live wins except completed', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3633-home-'));
  const listId = 'test-list';
  const liveDir = path.join(tmpHome, '.claude', 'tasks', listId);
  const archiveDir = path.join(liveDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const write = (dir, id, status) => fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id: String(id), subject: `task ${id}`, status }),
  );
  write(liveDir, 1, 'pending');                 // live only
  write(archiveDir, 2, 'pending');               // archive only — the resurrection case
  write(liveDir, 3, 'in_progress');              // present in both — live must win
  write(archiveDir, 3, 'completed');
  const prevHome = process.env.HOME;
  const prevListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  process.env.HOME = tmpHome;
  process.env.CLAUDE_CODE_TASK_LIST_ID = listId;
  try {
    delete require.cache[require.resolve('../audit-dispatch-outcomes.js')];
    const { loadTasksUnioned } = require('../audit-dispatch-outcomes.js');
    const tasks = loadTasksUnioned();
    assert.equal(tasks.get('1').fromArchive, false, 'a live-only task is not archived');
    assert.equal(tasks.get('2').fromArchive, true, 'an archive-only task IS archived — the exact tag planSweep now guards on');
    assert.deepEqual(
      { status: tasks.get('3').status, fromArchive: tasks.get('3').fromArchive },
      { status: 'completed', fromArchive: true },
      'archive wins on completed (pre-existing behavior) and carries the correct tag for the record that actually won',
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID; else process.env.CLAUDE_CODE_TASK_LIST_ID = prevListId;
    delete require.cache[require.resolve('../audit-dispatch-outcomes.js')];
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('caps: day budget and concurrency hold dispatches and are reported', () => {
  const entries = [];
  for (let i = 0; i < core.CAPS.perDay; i++) {
    entries.push({ ts: new Date(NOW - i * 1000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: String(100 + i) });
  }
  const plan = core.planSweep(entries, new Map([task(30, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0);
  assert.ok(plan.budgets.holds.some(h => h.includes('day budget')));
});

test('cmux unobservable (null or empty listing) = report-only, zero dispatches', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  for (const lt of [null, new Map()]) {
    const plan = core.planSweep(entries, new Map([task(10, 'pending')]), { now: NOW, liveTitles: lt });
    assert.equal(plan.cmuxObserved, false);
    assert.equal(plan.toDispatch.length, 0);
    assert.ok(plan.budgets.holds.some(h => h.includes('cmux unobservable')));
  }
});

test('dispatch kill-switch = visibility only', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: 'linear:BRO-10', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: 'linear:BRO-10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([lin('BRO-10', 'pending')]), { now: NOW, liveTitles: LIVE, dispatchEnabled: false });
  assert.equal(plan.toDispatch.length, 0);
  assert.equal(plan.retryable.length, 1, 'still classified — only the action is held');
});

test('tab title carries counts and the upd HH:MM freshness cue', () => {
  const plan = core.planSweep([], new Map(), { now: NOW, liveTitles: LIVE });
  const title = core.tabTitle(plan);
  assert.match(title, /^👑 OWNER watchdog — 0 in flight · 0 need you · upd \d{2}:\d{2}$/);
});

test('recheck failures count toward needsYou and render in the narrative', () => {
  const plan = core.planSweep([], new Map(), {
    now: NOW, liveTitles: LIVE,
    recheckFailures: [{ notionId: 'n1', taskSubject: 'Broken card', ts: T(60) }],
  });
  assert.equal(plan.needsYou, 1);
  assert.match(core.renderNarrative(plan), /acceptance recheck FAILED/);
});

// ── BRO-2318: leaky launcher, independent of detectLauncherOutage ──────────
test('a leaky launcher (~1-in-3 injection deaths, always followed by a success) holds and counts toward needsYou even though outage.recovered is true', () => {
  const pattern = ['dead', 'ok', 'ok', 'dead', 'ok', 'ok', 'dead', 'ok', 'ok'];
  const entries = [];
  pattern.forEach((kind, i) => {
    const w = `workspace:${900 + i}`;
    const ts = T(24 - i * 3); // spread across the last 24min, oldest first
    if (kind === 'dead') {
      entries.push({ ts, event: 'dead', taskId: String(900 + i), workspaceRef: w, failureReason: 'command injection never ran (no wrapper process appeared)' });
      entries.push({ ts, event: 'launch', taskId: String(900 + i), workspaceRef: w, unverified: true });
    } else {
      entries.push({ ts, event: 'launch', taskId: String(900 + i), workspaceRef: w });
    }
  });
  const plan = core.planSweep(entries, new Map(), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.outage.outage, false, 'sanity: not enough deaths inside the 30min outage lookback to alarm on its own terms');
  assert.equal(plan.outage.recovered, true, 'sanity: this is exactly the "recovered" shape the outage detector is blind to');
  assert.equal(plan.failureRate.leaking, true);
  assert.ok(plan.budgets.holds.some(h => /leaking/.test(h)));
  assert.equal(plan.needsYou >= 1, true);
});

test('taskPriority parses bridge line and subject fallback', () => {
  assert.equal(core.taskPriority({ description: '[notion:x] P0 Now · In progress · Admin' }), 'P0');
  assert.equal(core.taskPriority({ description: 'native', subject: 'P1: fix it' }), 'P1');
  assert.equal(core.taskPriority({ description: 'native', subject: 'fix it' }), null);
});

// ── Card #1564: the redispatch loop ────────────────────────────────────────
// executeSweep journals its REDISPATCH claim BEFORE spawning the child
// bsc-next, but a child REFUSED by a guard (closed card, PARKED, REOPEN-
// SUSPECT) journals nothing at all. planSweep never read its own claims back,
// so it re-picked the same task on every ~90s sweep. Live: 2026-08-19
// 14:02-14:09Z, twelve consecutive claims across only #1759 and #586 spent the
// entire perDay budget in eight minutes for zero launches.
test('#1564: a claim that never launched is not re-claimed every sweep, and does not starve the budget', () => {
  const entries = [];
  const tasks = new Map([
    lin('BRO-20', 'pending', 'P1 Now'),   // the card whose child will always refuse
    lin('BRO-21', 'pending', 'P1 Now'),   // a healthy card queued behind it
  ]);
  let now = NOW;
  const claims = {};
  for (let sweep = 0; sweep < 20; sweep++) {
    const plan = core.planSweep(entries, tasks, { now, liveTitles: LIVE });
    for (const d of plan.toDispatch) {
      claims[d.taskId] = (claims[d.taskId] || 0) + 1;
      // A refused child writes ONLY the claim — no 'launch', no 'dead'.
      entries.push({ ts: new Date(now).toISOString(), event: 'watchdog-redispatch', taskId: d.taskId, kind: 'p01-backlog' });
    }
    now += 92 * 1000;               // the real sweep period
  }
  assert.equal(claims['linear:BRO-20'], 1, 'the refused card must be claimed exactly once, not once per sweep');
  assert.equal(claims['linear:BRO-21'], 1, 'and the healthy card behind it must still get its dispatch');
});

test('#1564: a landed launch re-arms the task — a later dead launch is still retryable', () => {
  const entries = [
    { ts: T(120), event: 'watchdog-redispatch', taskId: 'linear:BRO-22', kind: 'p01-backlog' },
    { ts: T(118), event: 'launch', taskId: 'linear:BRO-22', subject: 'Fix thing 22', workspaceRef: 'workspace:8' },
    { ts: T(30), event: 'dead', taskId: 'linear:BRO-22', workspaceRef: 'workspace:8' },
  ];
  const plan = core.planSweep(entries, new Map([lin('BRO-22', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 1, 'the claim landed, so the dead session is retryable as before');
  assert.equal(plan.toDispatch[0].taskId, 'linear:BRO-22');
});

test('#1564: an unlanded claim re-arms by itself after REDISPATCH_REARM_MS', () => {
  const tasks = new Map([lin('BRO-23', 'pending', 'P1 Now')]);
  const stale = [{ ts: new Date(NOW - core.REDISPATCH_REARM_MS - 60000).toISOString(), event: 'watchdog-redispatch', taskId: 'linear:BRO-23', kind: 'p01-backlog' }];
  assert.equal(core.planSweep(stale, tasks, { now: NOW, liveTitles: LIVE }).toDispatch.length, 1,
    'a day-old unlanded claim must not suppress forever — a transient failure has to retry');

  const fresh = [{ ts: T(60), event: 'watchdog-redispatch', taskId: 'linear:BRO-23', kind: 'p01-backlog' }];
  assert.equal(core.planSweep(fresh, tasks, { now: NOW, liveTitles: LIVE }).toDispatch.length, 0,
    'but an hour-old one still suppresses');
});

test('#1564: the retry path is suppressed too, not just the P0/P1 backlog', () => {
  // BRO-3437: fixtured on Linear, not Notion — a bare-numeric id is excluded
  // from awaitingClaim/noLaunchPark unconditionally now, so a Notion fixture
  // would read 0 for the wrong reason instead of exercising the boot-grace/
  // escalation mechanics this test is actually about.
  const entries = [
    { ts: T(300), event: 'launch', taskId: 'linear:BRO-24', subject: 'Fix thing 24', workspaceRef: 'workspace:9' },
    { ts: T(280), event: 'dead', taskId: 'linear:BRO-24', workspaceRef: 'workspace:9' },
    { ts: T(60), event: 'watchdog-redispatch', taskId: 'linear:BRO-24', kind: 'retry' },
  ];
  const plan = core.planSweep(entries, new Map([lin('BRO-24', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0, 'a retry claim that never landed must not re-fire every sweep');
  assert.equal(plan.awaitingClaim.length, 1, 'and it must be surfaced to the owner, not silently dropped');
  // BRO-3429: past grace, with no fleet-wide outage in play, this is no
  // longer a passive label — it is actively parked and paged.
  assert.equal(plan.noLaunchPark.length, 1, 'and it must be escalated to an actual park, not just a label');
  assert.equal(plan.noLaunchPark[0].taskId, 'linear:BRO-24');
  assert.match(core.renderNarrative(plan), /#linear:BRO-24 .*parked \(won't retry\)/);
  // Suppressed cards leave p01Queue/retryable, so if they did not also land in
  // needsYou the tab title would read "0 need you" over a shrinking backlog.
  assert.ok(plan.needsYou >= 1, 'a suppressed card must count toward needsYou');
});

test('#1564: a claim younger than the boot grace suppresses but is NOT labelled a failure', () => {
  // A launch takes minutes and sweeps run every 92s, so labelling immediately
  // announced every healthy dispatch as "could not start" first (ship-check P1).
  // BRO-3437: fixtured on Linear — a bare id is excluded from awaitingClaim
  // unconditionally now, which would make the "past grace" assertion below
  // read 0 for the wrong reason.
  const entries = [{ ts: T(2), event: 'watchdog-redispatch', taskId: 'linear:BRO-27', kind: 'p01-backlog' }];
  const tasks = new Map([lin('BRO-27', 'pending', 'P1 Now')]);
  const booting = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(booting.toDispatch.length, 0, 'still suppressed — that is the duplicate guard');
  assert.equal(booting.awaitingClaim.length, 0, 'but not yet called a failure');
  assert.equal(booting.needsYou, 0);

  const older = [{ ts: new Date(NOW - core.CLAIM_LABEL_GRACE_MS - 60000).toISOString(), event: 'watchdog-redispatch', taskId: 'linear:BRO-27', kind: 'p01-backlog' }];
  assert.equal(core.planSweep(older, tasks, { now: NOW, liveTitles: LIVE }).awaitingClaim.length, 1,
    'past the grace window it IS a failure the owner must see');
});

test('#1564: a wedged launcher (claims, and nothing launching fleet-wide) holds dispatch instead of stalling silently', () => {
  // cmux-launch returns ok:false with NO workspaceRef when the CLI is missing,
  // the auth preflight fails, or new-workspace exits non-zero — and
  // failedLaunchEntries() returns [] for a ref-less failure, so NOTHING is
  // journaled. Every claim then looks like a guard refusal and
  // detectLauncherOutage (which keys on 'dead' rows) is blind. (ship-check P0)
  // BRO-3437: fixtured on Linear — bare ids are excluded from awaitingClaim
  // unconditionally now, which would collapse every count below to 0.
  const old = m => new Date(NOW - m * 60000).toISOString();
  const tasks = new Map([
    lin('BRO-40', 'pending', 'P1 Now'), lin('BRO-41', 'pending', 'P1 Now'),
    lin('BRO-42', 'pending', 'P1 Now'), lin('BRO-43', 'pending', 'P1 Now'),
  ]);
  const wedged = [
    { ts: old(90), event: 'watchdog-redispatch', taskId: 'linear:BRO-40', kind: 'p01-backlog' },
    { ts: old(80), event: 'watchdog-redispatch', taskId: 'linear:BRO-41', kind: 'p01-backlog' },
    { ts: old(70), event: 'watchdog-redispatch', taskId: 'linear:BRO-42', kind: 'p01-backlog' },
  ];
  const plan = core.planSweep(wedged, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.awaitingClaim.length, 3);
  assert.ok(plan.budgets.holds.some(h => /launcher itself looks wedged/.test(h)),
    'three claims and zero launches anywhere = the launcher, not the cards');
  assert.equal(plan.toDispatch.length, 0, 'and dispatching holds rather than burning more claims');
  // BRO-3429: a proven fleet-wide outage must NOT park these three individual
  // cards — that would misattribute the launcher's own failure to them and
  // page the owner three times about the wrong thing. The label still shows
  // (awaitingClaim above), just not the park action.
  assert.equal(plan.noLaunchPark.length, 0,
    'a wedged launcher must suppress per-card parking, not blame the cards');

  // Control: the SAME three stuck claims, but other work is still launching —
  // that is three genuinely refused cards, not an outage. Must not hold.
  const refusedRun = [
    ...wedged,
    { ts: old(5), event: 'launch', taskId: 'linear:BRO-43', subject: 'Fix thing 43', workspaceRef: 'workspace:1' },
  ];
  const plan2 = core.planSweep(refusedRun, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan2.awaitingClaim.length, 3);
  assert.ok(!plan2.budgets.holds.some(h => /launcher itself looks wedged/.test(h)),
    'a fresh launch elsewhere proves the launcher works');
  assert.equal(plan2.noLaunchPark.length, 3,
    'once it is clear the launcher works, genuinely refused cards DO get parked');
});

// ── BRO-3429: claimed-but-never-launched must actually escalate ────────────
//
// Before this, awaitingClaim was DISPLAY ONLY: it labelled a stale claim on
// the dashboard, counted toward needsYou, and quietly re-armed itself after
// REDISPATCH_REARM_MS (24h) — no ledger event, no page, forever. Live ledger
// evidence: 84 watchdog-redispatch claims over 7 days, 0 launches, 0 parks.
test('BRO-3429: a stale unlaunched claim is parked, not just labelled', () => {
  // BRO-3437: fixtured on Linear — a bare id would never reach noLaunchPark.
  const entries = [{ ts: T(60), event: 'watchdog-redispatch', taskId: 'linear:BRO-50', kind: 'p01-backlog' }];
  const tasks = new Map([lin('BRO-50', 'pending', 'P1 Now')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.noLaunchPark.length, 1);
  assert.equal(plan.noLaunchPark[0].taskId, 'linear:BRO-50');
  assert.equal(plan.parkedTotal, 1, 'parkedTotal must count a card about to be parked this tick');
});

// BRO-3437: board-targeting-audit.js measured the `watchdog-park` ledger
// event at 100% retired-board ids over 7 days, most recently <1h old.
// BRO-3390/3878 already stopped p01Queue/retryable from creating FRESH
// claims against the retired Notion mirror, but a claim already sitting in
// the ledger from before those fixes still aged past CLAIM_LABEL_GRACE_MS
// and reached noLaunchPark — writing a watchdog-park row and paging the
// owner about a card Linear has never heard of. Same shape as the test
// above, bare-numeric id instead of `linear:`.
test('BRO-3437: a stale unlaunched claim against the retired Notion mirror is never promoted to awaitingClaim/noLaunchPark', () => {
  const entries = [{ ts: T(60), event: 'watchdog-redispatch', taskId: '60', kind: 'p01-backlog' }];
  const tasks = new Map([task(60, 'pending', 'P1 Now')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.awaitingClaim.length, 0, 'a retired-board claim must never be surfaced as a labelled failure');
  assert.equal(plan.noLaunchPark.length, 0, 'and must never be escalated to an actual park');
  assert.equal(plan.parkedTotal, 0);
});

test('BRO-3429: once actually parked, the card leaves awaitingClaim/noLaunchPark and does not double-count needsYou', () => {
  const parked = [
    { ts: T(60), event: 'watchdog-redispatch', taskId: 'linear:BRO-51', kind: 'p01-backlog' },
    // The CLI appends this PARK row right after the sweep above computed
    // noLaunchPark — simulating the NEXT sweep's view of the ledger.
    { ts: T(59), event: core.WATCHDOG_EVENTS.PARK, taskId: 'linear:BRO-51', reason: 'no launch' },
  ];
  const tasks = new Map([lin('BRO-51', 'pending', 'P1 Now')]);
  const plan = core.planSweep(parked, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.awaitingClaim.length, 0, 'a parked id must not also sit in the passive label list');
  assert.equal(plan.noLaunchPark.length, 0, 'and must not be re-parked every sweep');
  // needsYou must count it exactly once (via wdParked), not twice (via
  // wdParked AND awaitingClaim) — the bug ship-check caught pre-implementation.
  assert.equal(plan.needsYou, 1);
  assert.ok(!/could not start/.test(core.renderNarrative(plan)),
    'a parked card must not also show the "I will retry in 24h" framing');
});

test('BRO-3429: a fresh launch after a park re-arms the card for the NEXT stall', () => {
  const entries = [
    { ts: T(120), event: 'watchdog-redispatch', taskId: 'linear:BRO-52', kind: 'p01-backlog' },
    { ts: T(119), event: core.WATCHDOG_EVENTS.PARK, taskId: 'linear:BRO-52', reason: 'no launch' },
    { ts: T(60), event: 'launch', taskId: 'linear:BRO-52', subject: 'Fix thing 52', workspaceRef: 'workspace:1' },
    { ts: T(50), event: 'dead', taskId: 'linear:BRO-52', workspaceRef: 'workspace:1' },
    { ts: T(10), event: 'watchdog-redispatch', taskId: 'linear:BRO-52', kind: 'retry' },
  ];
  const tasks = new Map([lin('BRO-52', 'in_progress')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  // The retry claim at T(10) is only ~2.5 min old — still inside the boot
  // grace, so it must not be parked YET (that would defeat the boot-window
  // duplicate guard the SAME re-claim already relies on).
  assert.equal(plan.noLaunchPark.length, 0, 'a freshly re-armed claim gets its own grace window, not an instant re-park');
});

test('#1564: out-of-order ledger appends are judged by timestamp, not file position', () => {
  // Nothing serialises writes to the ledger across processes, so a row can
  // land after newer ones. Last-in-file-order would read the OLD launch as
  // "latest" and wrongly suppress a card whose newer launch already landed.
  const entries = [
    { ts: T(10), event: 'launch', taskId: '28', subject: 'Fix thing 28', workspaceRef: 'workspace:1' },
    { ts: T(60), event: 'watchdog-redispatch', taskId: '28', kind: 'retry' },
    { ts: T(300), event: 'launch', taskId: '28', subject: 'Fix thing 28', workspaceRef: 'workspace:2' }, // stale, appended late
  ];
  assert.equal(core.watchdogClaimPending(entries, NOW).has('28'), false,
    'the T(10) launch is newer than the T(60) claim — the claim landed');
});

test('#1564: a claim whose child is still booting is not re-picked (duplicate-workspace guard)', () => {
  // A launch legitimately takes minutes; the next sweep is 92s later. Before
  // this fix that window re-picked the task and produced the duplicate
  // workspace PAIRS the card reported (77+81, 78+82, 65+67).
  const entries = [{ ts: T(1), event: 'watchdog-redispatch', taskId: '25', kind: 'p01-backlog' }];
  const plan = core.planSweep(entries, new Map([task(25, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0, 'no second dispatch while the first child is still booting');
});

test('BRO-395: watchdogClaimPending never treats a future-dated claim as pending', () => {
  // A corrupt/clock-skewed claim row dated in the future would otherwise make
  // `now - claimMs` negative — always < REDISPATCH_REARM_MS — so it would
  // read as "just claimed" forever, permanently suppressing redispatch AND
  // permanently hiding from the awaitingClaim owner-alert path (both read
  // this same pending map).
  const futureTs = new Date(NOW + 45 * 24 * 60 * 60 * 1000).toISOString();
  const entries = [{ ts: futureTs, event: 'watchdog-redispatch', taskId: '77', kind: 'retry' }];
  const pending = core.watchdogClaimPending(entries, NOW);
  assert.equal(pending.has('77'), false, 'a future-dated claim must never count as pending');
});

test('#1564: watchdogClaimPending ignores rows with no taskId, the watchdog marker, and unparseable timestamps', () => {
  const entries = [
    { ts: T(5), event: 'watchdog-redispatch', taskId: null },
    { ts: T(5), event: 'watchdog-redispatch' },
    { ts: T(5), event: 'watchdog-resurrect', taskId: 'watchdog', workspaceRef: 'workspace:537' },
    { ts: 'not-a-timestamp', event: 'watchdog-redispatch', taskId: '99' },
    { event: 'watchdog-redispatch', taskId: '98' },            // no ts at all
    { ts: T(5), event: 'watchdog-redispatch', taskId: 26 },     // numeric id, as some rows carry
  ];
  const pending = core.watchdogClaimPending(entries, NOW);
  // Assert membership, not iteration order — Set/Map order is insertion order
  // and would make this pass or fail for the wrong reason.
  assert.equal(pending.size, 1);
  assert.ok(pending.has('26'), 'numeric task ids are normalised to strings');
  for (const bad of ['null', 'undefined', 'watchdog', '99', '98']) {
    assert.ok(!pending.has(bad), `${bad} must never become a task id`);
  }
});

test('ensureAutoTitle: bare titles get glyphs, glyphed titles pass through', () => {
  assert.equal(ensureAutoTitle('Fix the thing', 'sonnet'), '🤖⚡ Fix the thing');
  assert.equal(ensureAutoTitle('🤖🧠 Data·already fine', 'fable'), '🤖🧠 Data·already fine');
  assert.equal(ensureAutoTitle('👑 OWNER — mandate', 'opus'), '👑 OWNER — mandate');
  assert.equal(ensureAutoTitle('', 'haiku'), '🤖🪶 untitled dispatch');
});

// ── BRO-3390: hourly pacing + Linear-sourced tasks ────────────────────────

test('caps: hourly pacing holds dispatch even when the day budget has room', () => {
  // perHour claims inside the rolling window, but well under perDay. Without
  // pacing the dashboard drains the whole day budget in ~9 minutes and then
  // idles 23+ hours, which is a burst, not a continuous drain.
  const entries = [];
  for (let i = 0; i < core.CAPS.perHour; i++) {
    entries.push({ ts: new Date(NOW - i * 60000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: String(200 + i) });
  }
  assert.ok(core.CAPS.perHour < core.CAPS.perDay, 'pacing must be tighter than the day budget to mean anything');
  const plan = core.planSweep(entries, new Map([task(31, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0, 'hourly pacing must hold the dispatch');
  assert.ok(plan.budgets.holds.some(h => /hourly pacing/.test(h)), `expected an hourly-pacing hold, got ${JSON.stringify(plan.budgets.holds)}`);
  assert.equal(plan.budgets.usedThisHour, core.CAPS.perHour);
});

test('caps: claims OLDER than the rolling hour do not hold dispatch', () => {
  // The same number of claims, but 90 minutes ago — the window must have moved
  // on, or pacing would degrade into a second, permanent day budget.
  const entries = [];
  for (let i = 0; i < core.CAPS.perHour; i++) {
    entries.push({ ts: new Date(NOW - 90 * 60000 - i * 1000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: String(300 + i) });
  }
  const plan = core.planSweep(entries, new Map([task(32, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.usedThisHour, 0, 'the rolling window must exclude claims older than an hour');
  assert.ok(!plan.budgets.holds.some(h => /hourly pacing/.test(h)));
});

test('watchdogClaimsInWindow ignores unparseable and future-dated rows (BRO-395 shape)', () => {
  const entries = [
    { ts: 'not-a-date', event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: '1' },
    { ts: new Date(NOW + 6 * 3600e3).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: '2' },
    { ts: new Date(NOW - 5 * 60000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: '3' },
    { ts: new Date(NOW - 5 * 60000).toISOString(), event: 'launch', taskId: '4' },
    null,
  ];
  const rows = core.watchdogClaimsInWindow(entries, NOW);
  // The unparseable row is dropped; the real in-window claim counts. A
  // future-dated row is >= cutoff so it counts too — that is the SAME
  // conservative direction watchdogClaimsToday takes (over-count => spend
  // less), never the direction that would hand back extra allowance.
  assert.ok(rows.every(r => r.event === core.WATCHDOG_EVENTS.REDISPATCH));
  assert.ok(rows.some(r => r.taskId === '3'));
  assert.ok(!rows.some(r => r.ts === 'not-a-date'));
  // The pacing default keeps the future-dated row (documented above) — pin
  // it, so a later "fix" cannot silently hand allowance back.
  assert.ok(rows.some(r => r.taskId === '2'), 'pacing default must keep counting a future-dated claim');

  // 2026-09-21: the stall detector reads this same counter and needs the
  // OPPOSITE direction — a future-dated claim that counted as "recent"
  // forever would make dispatch-flow-health report "alive" on every tick
  // through a real stall. excludeFuture:true is that opt-in; nothing else
  // about the filter changes.
  const clamped = core.watchdogClaimsInWindow(entries, NOW, undefined, { excludeFuture: true });
  assert.ok(clamped.some(r => r.taskId === '3'), 'a genuine in-window claim still counts');
  assert.ok(!clamped.some(r => r.taskId === '2'), 'excludeFuture must drop the future-dated claim');
  assert.ok(!clamped.some(r => r.ts === 'not-a-date'));
  assert.equal(clamped.length, 1);
});

test('a Linear-sourced task is queued, ordered and dispatched like any other', () => {
  const linearTask = ['linear:BRO-77', {
    id: 'linear:BRO-77', subject: 'P1: fix the thing', status: 'pending',
    description: '[linear:BRO-77] P1 Next · Backlog · no-category\nbody',
  }];
  const plan = core.planSweep([], new Map([linearTask, task(9, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  const ids = plan.p01Queue.map(q => q.taskId);
  assert.ok(ids.includes('linear:BRO-77'), `Linear task missing from p01Queue: ${JSON.stringify(ids)}`);
  // BRO-3878: the retired Notion mirror (bare id '9') is no longer a P0/P1
  // backlog source at all — it must never enter p01Queue, full stop, not
  // even ranked behind Linear.
  assert.deepEqual(ids, ['linear:BRO-77']);
});

test('BRO-3878: compareTaskIds still ranks Linear ahead of the retired Notion mirror, then FIFO within each source', () => {
  // The p01Queue-level exclusion added by this ticket makes this ordering
  // moot for FRESH backlog (Notion never reaches p01Queue at all now), but
  // retryable/awaitingClaim/jobBlocked can still legitimately mix both id
  // namespaces for pre-existing ledger history, and toDispatch's own sort
  // still runs compareTaskIds over that mix — this is the one place left
  // that proves Linear-first ordering, now that the p01Queue test above no
  // longer exercises it.
  const ids = ['50', 'linear:BRO-30', '10', 'linear:BRO-5'];
  assert.deepEqual([...ids].sort(core.compareTaskIds), ['linear:BRO-5', 'linear:BRO-30', '10', '50']);
});

test('ship-check P0: a HEADLESS job counts as open (concurrency + no re-dispatch)', () => {
  // A headless dispatch journals by jobId and writes workspaceRef
  // "headless:linear:BRO-N", which dispatch-ledger's workspace-ref regex
  // rejects. Before the fix this task was invisible: liveNow stayed 0 (so the
  // concurrency cap was inert on the whole Linear lane) and the card re-entered
  // the P0/P1 queue while its ~22-minute job was still running.
  const entries = [
    { ts: T(30), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: 'linear:BRO-77' },
    { ts: T(29), event: 'launch', taskId: 'linear:BRO-77', subject: 's', workspaceRef: 'headless:linear:BRO-77' },
    { ts: T(28), event: 'job-spawned', taskId: 'linear:BRO-77', jobId: 'linear:BRO-77-abc', subject: 's' },
  ];
  assert.ok(core.openHeadlessJobTasks(entries).has('linear:BRO-77'));
  assert.ok(core.openTasksAnyLane(entries).has('linear:BRO-77'));
  assert.equal(core.watchdogLiveCount(entries), 1, 'a live headless job must occupy a concurrency slot');

  const linearTask = ['linear:BRO-77', {
    id: 'linear:BRO-77', subject: 'P1: fix the thing', status: 'pending',
    description: '[linear:BRO-77] P1 Next · Backlog · no-category\nbody',
  }];
  const plan = core.planSweep(entries, new Map([linearTask]), { now: NOW, liveTitles: LIVE });
  assert.ok(!plan.p01Queue.some(q => q.taskId === 'linear:BRO-77'),
    'a task with a live headless job must not be re-queued');
  assert.ok(plan.inFlight.some(f => f.taskId === 'linear:BRO-77'),
    'and it must show as in-flight rather than vanishing from the narrative');
});

test('ship-check P0: a FINISHED headless job frees its slot again', () => {
  const entries = [
    { ts: T(30), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: 'linear:BRO-78' },
    { ts: T(29), event: 'job-spawned', taskId: 'linear:BRO-78', jobId: 'linear:BRO-78-abc' },
    { ts: T(5), event: 'job-done', taskId: 'linear:BRO-78', jobId: 'linear:BRO-78-abc' },
  ];
  assert.equal(core.openHeadlessJobTasks(entries).size, 0, 'job-done is terminal - the slot must free');
  assert.equal(core.watchdogLiveCount(entries), 0);
});

test('the cmux lane still counts as open (no regression from the union)', () => {
  const entries = [
    { ts: T(30), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: '55' },
    { ts: T(29), event: 'launch', taskId: '55', subject: 's', workspaceRef: 'workspace:7' },
  ];
  assert.ok(core.openTasksAnyLane(entries).has('55'));
  assert.equal(core.watchdogLiveCount(entries), 1);
});

// ── BRO-3429 acceptance criterion (a): a Linear-identified task routes to
// linear-next, never bsc-next. dispatchArgvFor lives in dispatch-watchdog.js
// (the CLI shell, not this pure module) because it builds a real child-process
// argv — required against the REAL function per CLAUDE.md rule 15, not a copy
// of its regex. Already covered end-to-end in scripts/lib/
// linear-watchdog-source.test.mjs ('dispatchArgvFor routes each id namespace
// to its own dispatcher'); asserted again here because this is the file this
// issue's acceptance criteria names.
test('BRO-3429 (a): dispatchArgvFor routes linear: ids to linear-next.js, never bsc-next.js', () => {
  const wd = require('../dispatch-watchdog.js');
  const linear = wd.dispatchArgvFor('linear:BRO-3429');
  assert.ok(linear[0].endsWith('scripts/linear-next.js'));
  assert.ok(!linear[0].endsWith('scripts/bsc-next.js'));
  const notion = wd.dispatchArgvFor('1842');
  assert.ok(notion[0].endsWith('scripts/bsc-next.js'), 'the Notion lane is untouched by this change');
});

test('BRO-3429: reArmHintFor names the lane-correct re-arm command in a park page', () => {
  const wd = require('../dispatch-watchdog.js');
  assert.equal(wd.reArmHintFor('linear:BRO-77'), 'node scripts/linear-next.js --id BRO-77 --force');
  assert.equal(wd.reArmHintFor('1842'), 'node scripts/bsc-next.js --id 1842 --force');
});

// BRO-3424: unlandedJobDone is injected (same convention as liveTitles) —
// planSweep itself never touches git. Report-only: must surface in
// needsYou/renderNarrative but never appear in toDispatch (no cap exists yet
// on redispatching an unlanded-retry loop — see the comment at its call site
// in planSweep).
test('BRO-3424: an unlanded job-done surfaces in needsYou and the narrative, but is never auto-redispatched', () => {
  const entries = [];
  const unlandedJobDone = [{ taskId: '80', jobId: '80-abc', cwd: '/tmp/job-80', sha: 'deadbeef' }];
  const plan = core.planSweep(entries, new Map([task(80, 'in_progress')]), {
    now: NOW, liveTitles: LIVE, unlandedJobDone,
  });
  assert.equal(plan.unlandedDone.length, 1);
  assert.equal(plan.unlandedDone[0].taskId, '80');
  assert.ok(plan.needsYou >= 1);
  assert.ok(!plan.toDispatch.some((d) => d.taskId === '80'), 'must never be auto-redispatched');
  assert.match(core.renderNarrative(plan), /never reached origin\/main/);
});

test('BRO-3424: an unlanded job-done for an already-completed task is not surfaced', () => {
  const unlandedJobDone = [{ taskId: '81', jobId: '81-abc', cwd: '/tmp/job-81', sha: 'deadbeef' }];
  const plan = core.planSweep([], new Map([task(81, 'completed')]), { now: NOW, liveTitles: LIVE, unlandedJobDone });
  assert.equal(plan.unlandedDone.length, 0);
});

test('BRO-3424: an unlanded job-done is suppressed once a NEWER launch for the same task is already open', () => {
  const entries = [
    { ts: T(1), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: '82' },
    { ts: T(1), event: 'job-spawned', taskId: '82', jobId: '82-new' },
  ];
  const unlandedJobDone = [{ taskId: '82', jobId: '82-old', cwd: '/tmp/job-82', sha: 'deadbeef' }];
  const plan = core.planSweep(entries, new Map([task(82, 'in_progress')]), { now: NOW, liveTitles: LIVE, unlandedJobDone });
  assert.equal(plan.unlandedDone.length, 0, 'a live newer job for the task supersedes the stale unlanded flag');
});

test('BRO-3424: omitting unlandedJobDone entirely is backward compatible (defaults to none)', () => {
  const plan = core.planSweep([], new Map([task(83, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.unlandedDone, []);
});

// BRO-3442: a headless job that ended THIS SESSION: CLOSE ME — BLOCKED: is a
// PARK-with-reason signal, surfaced in a new `jobBlocked` plan field.
test('BRO-3442: a job-blocked task surfaces in jobBlocked and needsYou', () => {
  // BRO-3437: fixtured on Linear — a bare id is excluded from jobBlocked
  // unconditionally now.
  const entries = [{ ts: T(10), event: 'job-blocked', taskId: 'linear:BRO-90', jobId: '90-abc', reason: 'needs owner decision: rotate the key' }];
  const plan = core.planSweep(entries, new Map([lin('BRO-90', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.jobBlocked.length, 1);
  assert.equal(plan.jobBlocked[0].taskId, 'linear:BRO-90');
  assert.equal(plan.jobBlocked[0].reason, 'needs owner decision: rotate the key');
  assert.ok(plan.needsYou >= 1);
  assert.ok(plan.parkedTotal >= 1);
});

// BRO-3437: same signal, retired Notion mirror. A job dispatched (by any
// means) against a bare-numeric id has no live Linear card the owner can
// act on, so surfacing it in jobBlocked — and dispatch-watchdog.js writing
// a watchdog-park row for it — is exactly the writer board-targeting-
// audit.js caught at 100% retired-board ids.
test('BRO-3437: a job-blocked task against the retired Notion mirror never surfaces in jobBlocked', () => {
  const entries = [{ ts: T(10), event: 'job-blocked', taskId: '91', jobId: '91-abc', reason: 'needs owner decision: rotate the key' }];
  const plan = core.planSweep(entries, new Map([task(91, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.jobBlocked.length, 0);
});

test('BRO-3442 (adversarial review): a blocked P0/P1 task is NOT ALSO queued for dispatch in the same sweep', () => {
  // BRO-3878: fixtured on Linear, not Notion — the guard under test here is
  // blockedTaskIds, not the (now unconditional) Notion exclusion; a Notion
  // fixture would pass this assertion for the wrong reason.
  const entries = [{ ts: T(10), event: 'job-blocked', taskId: 'linear:BRO-91', jobId: '91-abc', reason: 'missing credential' }];
  const plan = core.planSweep(entries, new Map([lin('BRO-91', 'pending', 'P0 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.jobBlocked.length, 1);
  assert.ok(!plan.p01Queue.some((d) => d.taskId === 'linear:BRO-91'), 'a task about to be parked must never also be queued this sweep');
  assert.ok(!plan.toDispatch.some((d) => d.taskId === 'linear:BRO-91'), 'a task about to be parked must never also be dispatched this sweep');
});

test('BRO-3442 (adversarial review): a stale job-blocked superseded by a LATER successful job is not re-parked', () => {
  const entries = [
    { ts: T(30), event: 'job-blocked', taskId: 'linear:BRO-92', jobId: '92-old', reason: 'stale blocker, already resolved' },
    { ts: T(10), event: 'job-spawned', taskId: 'linear:BRO-92', jobId: '92-new' },
    { ts: T(5), event: 'job-done', taskId: 'linear:BRO-92', jobId: '92-new', sessionId: 'sess-92' },
  ];
  const plan = core.planSweep(entries, new Map([lin('BRO-92', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.jobBlocked.length, 0, 'the LATEST job for the task (job-done) must win over an older job-blocked jobId');
});

test('BRO-3442: a job-blocked task already watchdog-parked is not surfaced again', () => {
  const entries = [
    { ts: T(30), event: 'job-blocked', taskId: 'linear:BRO-93', jobId: '93-abc', reason: 'missing credential' },
    { ts: T(20), event: core.WATCHDOG_EVENTS.PARK, taskId: 'linear:BRO-93', subject: 'x' },
  ];
  const plan = core.planSweep(entries, new Map([lin('BRO-93', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.jobBlocked.length, 0);
});

// BRO-3437 (ship-check/Codex): 12 legacy watchdog-park rows already sit in the
// ledger with bare-numeric ids and NOTHING relaunches those ids, so they never
// clear. They must keep suppressing their id (watchdogParkedIds is untouched)
// but must not count as owner work — otherwise "N need you" stays inflated
// forever by cards no surface can show.
test('BRO-3437: legacy bare-id park rows stay suppressed but do not inflate needsYou/parkedTotal; live ones still count', () => {
  const legacy = [{ ts: T(60), event: core.WATCHDOG_EVENTS.PARK, taskId: '1864', reason: 'legacy' }];
  assert.ok(core.watchdogParkedIds(legacy).has('1864'), 'legacy park row still suppresses its id');
  const p1 = core.planSweep(legacy, new Map([task(1864, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(p1.needsYou, 0);
  assert.equal(p1.parkedTotal, 0);

  const live = [{ ts: T(60), event: core.WATCHDOG_EVENTS.PARK, taskId: 'linear:BRO-1864', reason: 'x' }];
  const p2 = core.planSweep(live, new Map([lin('BRO-1864', 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(p2.needsYou, 1);
  assert.equal(p2.parkedTotal, 1);
});

// ── BRO-3404: cmux-lane holds must not gate the headless lane ─────────────

function p01(id, pri = 'P1 Now') {
  const isLinear = String(id).startsWith('linear:');
  const tag = isLinear ? `[linear:${String(id).slice(7)}]` : `[notion:abc-${id}]`;
  return [String(id), {
    id: String(id), subject: `Fix thing ${id}`, status: 'pending',
    description: `${tag} ${pri} · Not started · no-category\nbody`,
  }];
}

test('BRO-3404: the auto-tab ceiling stops cmux work but NOT headless work', () => {
  // 15 auto-dispatched cmux tabs against a ceiling of 12 — the exact state
  // that halted the drain live on 2026-09-15, while every card it could not
  // dispatch was headless and creates no tab at all.
  const liveTitles = new Map();
  for (let i = 0; i < 15; i++) liveTitles.set(`workspace:${100 + i}`, `🤖 auto ${i}`);

  const tasks = new Map([p01('linear:BRO-500'), p01('1849')]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles });

  assert.ok(plan.budgets.holds.some((h) => /auto-tab ceiling/.test(h)),
    'the ceiling must still be REPORTED so the narrative is honest');
  assert.ok(plan.budgets.cmuxHolds.some((h) => /auto-tab ceiling/.test(h)),
    'and classified as a cmux-lane hold');
  assert.equal(plan.budgets.globalHolds.length, 0, 'it must not be a global hold');

  const ids = plan.toDispatch.map((t) => t.taskId);
  assert.ok(ids.includes('linear:BRO-500'), `headless work must still dispatch, got ${JSON.stringify(ids)}`);
  // BRO-3878: '1849' (bare Notion id) is excluded unconditionally now — this
  // no longer proves the cmux-lane split specifically, since it would be
  // absent from p01Queue with or without the ceiling hold.
  assert.ok(!ids.includes('1849'), 'cmux-lane work must be suppressed while the ceiling is hit');
});

test('BRO-3404: cmux being unobservable does not stop headless dispatch', () => {
  // liveTitles empty => cmuxObserved false. Headless needs no cmux at all.
  const tasks = new Map([p01('linear:BRO-501'), p01('1850')]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: new Map() });
  assert.ok(plan.budgets.cmuxHolds.some((h) => /cmux unobservable/.test(h)));
  assert.equal(plan.budgets.globalHolds.length, 0);
  const ids = plan.toDispatch.map((t) => t.taskId);
  assert.ok(ids.includes('linear:BRO-501'));
  // BRO-3878: '1850' is excluded unconditionally now regardless of cmux
  // observability — see the note on the ceiling test above.
  assert.ok(!ids.includes('1850'));
});

test('BRO-3404: a GLOBAL hold still stops both lanes', () => {
  // Day budget exhausted is a real money bound — it must gate everything.
  const entries = [];
  for (let i = 0; i < core.CAPS.perDay; i++) {
    entries.push({ ts: new Date(NOW - i * 1000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: String(900 + i) });
  }
  const tasks = new Map([p01('linear:BRO-502'), p01('1851')]);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.ok(plan.budgets.globalHolds.some((h) => /day budget/.test(h)));
  assert.equal(plan.toDispatch.length, 0, 'a global hold must stop the headless lane too');
});

test('BRO-3404: with no holds at all, the Linear lane dispatches and the retired Notion mirror never rides along', () => {
  const tasks = new Map([p01('linear:BRO-503'), p01('1852')]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.cmuxHolds.length, 0);
  assert.equal(plan.budgets.globalHolds.length, 0);
  const ids = plan.toDispatch.map((t) => t.taskId);
  assert.ok(ids.includes('linear:BRO-503'));
  // BRO-3878: '1852' is a bare Notion-mirror id — with budget/holds no
  // longer a factor, it used to "ride along" behind Linear; now it must
  // never enter p01Queue at all, holds or no holds.
  assert.ok(!ids.includes('1852'), 'the frozen Notion mirror must never ride along in the backlog queue');
});

// ── structuralGuardRefusal (BRO-3481) ───────────────────────────────────────
//
// A reopened Linear issue carrying an old "Dispatched ..." comment could
// never be re-dispatched by the watchdog's own argv (no --force): the
// idempotency guard refused it every retry, burning a REDISPATCH claim each
// time before eventually parking with a generic "produced no launch" message
// that named no reason. structuralGuardRefusal is the curated (not blanket)
// detector that lets dispatch-watchdog.js park immediately, naming the
// guard's own reason, for the refusal shapes that are genuinely permanent.

test('structuralGuardRefusal: recognizes the exact BRO-3431 idempotency refusal, extracting just its own line', () => {
  const out = [
    '[linear-next] REFUSING to dispatch BRO-3431: it already looks dispatched.',
    '  Linear comment: "Dispatched 2f595adb to linear:BRO-3431-mu34ri7q at 2026-09-15T21:07:44.458Z (headless)" (1.9h ago)',
    '  Re-run with --force if you know this is stale.',
  ].join('\n');
  const reason = core.structuralGuardRefusal(out);
  assert.equal(reason, '[linear-next] REFUSING to dispatch BRO-3431: it already looks dispatched.');
});

test('structuralGuardRefusal: recognizes the terminal-state guard refusal', () => {
  const out = '[linear-next] BRO-99 is already in a terminal state ("Done") — refusing to re-dispatch. Re-run with --force if this is a deliberate re-open.';
  assert.equal(core.structuralGuardRefusal(out), out);
});

test('structuralGuardRefusal: null for a transient lock/claim-race refusal (must keep retrying, not park forever)', () => {
  const out = '[bsc-next] REFUSING succession dispatch: another succession dispatch for task #12 is already in flight (lock held, not stale). Wait for it to finish or fail before retrying — dispatching concurrently would let two successors both pass the depth cap.';
  assert.equal(core.structuralGuardRefusal(out), null);
});

test('structuralGuardRefusal: null for a self-resolving "process is STILL ALIVE" refusal', () => {
  const out = "[linear-next] REFUSING to dispatch BRO-5: its ledger record was closed by a 'prune-closed' breadcrumb at 2026-09-15T10:00:00Z, but a claude process is STILL ALIVE in workspace:9.";
  assert.equal(core.structuralGuardRefusal(out), null);
});

test('structuralGuardRefusal: null for ordinary crash output, and tolerates empty/missing input', () => {
  assert.equal(core.structuralGuardRefusal('TypeError: cannot read property foo of undefined\n  at bar (/x.js:1:1)'), null);
  assert.equal(core.structuralGuardRefusal(''), null);
  assert.equal(core.structuralGuardRefusal(undefined), null);
});

// Codex adversarial review (BRO-3481): "it already looks dispatched" is
// printed for TWO different reasons (linear-next.js:842-858) — a stale
// historical comment (permanent) or hasLiveLedgerEntry finding a genuinely
// LIVE concurrent dispatch (NOT permanent — it resolves once that dispatch
// finishes). Parking the live case would suppress legitimate future work,
// since nothing but a new launch clears a watchdog-park row.
test('structuralGuardRefusal: null when "it already looks dispatched" came from a LIVE ledger entry, not a stale comment', () => {
  const out = [
    '[linear-next] REFUSING to dispatch BRO-42: it already looks dispatched.',
    "  Local dispatch ledger has a live (non-dead, non-finished) entry for linear:BRO-42 — latest attempt 'job-spawned' at 2026-09-15T20:00:00.000Z (5m ago).",
    '  Re-run with --force if you know this is stale.',
  ].join('\n');
  assert.equal(core.structuralGuardRefusal(out), null);
});

test('structuralGuardRefusal: still recognizes "it already looks dispatched" when it is the stale-comment case (no live-ledger detail line)', () => {
  const out = [
    '[linear-next] REFUSING to dispatch BRO-3431: it already looks dispatched.',
    '  Linear comment: "Dispatched 2f595adb to linear:BRO-3431-mu34ri7q at 2026-09-15T21:07:44.458Z (headless)" (1.9h ago)',
    '  Re-run with --force if you know this is stale.',
  ].join('\n');
  assert.equal(core.structuralGuardRefusal(out), '[linear-next] REFUSING to dispatch BRO-3431: it already looks dispatched.');
});

// ── BRO-3924 R3: consuming BRO-3551's open-backlog sweep report ────────────

test('BRO-3924 (R3): already-passing cards count toward needsYou and render in the narrative', () => {
  const plan = core.planSweep([], new Map(), {
    now: NOW, liveTitles: LIVE,
    alreadyPasses: [{ id: 'BRO-9001', name: 'Fix the thing', verifyCmd: 'node --test x.test.mjs' }],
  });
  assert.equal(plan.needsYou, 1);
  assert.match(core.renderNarrative(plan), /already passes its own acceptance command/);
});

test('BRO-3924 (R3): omitting alreadyPasses entirely is backward compatible (defaults to none)', () => {
  const plan = core.planSweep([], new Map(), { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.alreadyPasses, []);
  assert.equal(plan.needsYou, 0);
});

// ── BRO-3924 R5: spend circuit breaker ──────────────────────────────────────

function headlessOpen(id, jobId, claimTs, spawnTs) {
  return [
    { ts: claimTs, event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: id },
    { ts: spawnTs, event: 'launch', taskId: id, workspaceRef: `headless:${id}` },
    { ts: spawnTs, event: 'job-spawned', jobId, taskId: id, workspaceRef: `headless:${id}` },
  ];
}

test('BRO-3924 (R5): the threshold is derived from the shared default scaled by watchdogConcurrency, not the bare $12 backlog-drain default', () => {
  const backlogDrain = require('../lib/backlog-drain.js');
  const expected = Math.round(backlogDrain.DEFAULT_SPEND_THRESHOLD_USD * (core.CAPS.watchdogConcurrent / backlogDrain.DEFAULT_CONCURRENCY_CAP) * 100) / 100;
  assert.equal(core.WATCHDOG_SPEND_THRESHOLD_USD, expected);
  assert.ok(core.WATCHDOG_SPEND_THRESHOLD_USD > backlogDrain.DEFAULT_SPEND_THRESHOLD_USD, 'must be scaled UP, not reused bare, at 3x the concurrency');
});

test('BRO-3924 (R5): medianJobCostUSD falls back to the documented historical figure when there is no recent cost history', () => {
  assert.equal(core.medianJobCostUSD([], NOW), core.FALLBACK_JOB_COST_USD);
});

test('BRO-3924 (R5): medianJobCostUSD ignores job-done rows older than the 7-day window', () => {
  const entries = [
    { ts: T(8 * 24 * 60), event: 'job-spawned', jobId: 'old', taskId: 'linear:BRO-1' },
    { ts: T(8 * 24 * 60 - 1), event: 'job-done', jobId: 'old', taskId: 'linear:BRO-1', costUSD: 999 },
  ];
  assert.equal(core.medianJobCostUSD(entries, NOW), core.FALLBACK_JOB_COST_USD);
});

test('BRO-3924 (R5): in-flight claims with zero completions trip the spend breaker (in-flight reservation)', () => {
  const entries = [];
  for (let i = 0; i < core.CAPS.watchdogConcurrent; i++) {
    entries.push(...headlessOpen(`linear:BRO-90${i}`, `job-90${i}`, T(5), T(4)));
  }
  const breaker = core.watchdogSpendBreaker(entries, NOW);
  assert.equal(breaker.liveNow, core.CAPS.watchdogConcurrent);
  assert.ok(breaker.reservedUSD > 0);
  assert.equal(breaker.completions, 0);
  assert.equal(breaker.halt, true);
  assert.match(breaker.reason, /spend circuit breaker/);
});

test('BRO-3924 (R5): a single landed completion clears the halt even at high reserved spend', () => {
  const entries = [];
  for (let i = 0; i < core.CAPS.watchdogConcurrent; i++) {
    entries.push(...headlessOpen(`linear:BRO-91${i}`, `job-91${i}`, T(10), T(9)));
  }
  // Finish exactly one of them — its job is no longer open, so liveNow drops
  // by one, and its cost lands as a real 'card-pass' row.
  entries.push({ ts: T(1), event: 'job-done', jobId: 'job-910', taskId: 'linear:BRO-910', costUSD: 5 });
  const breaker = core.watchdogSpendBreaker(entries, NOW);
  assert.equal(breaker.liveNow, core.CAPS.watchdogConcurrent - 1);
  assert.equal(breaker.completions, 1);
  assert.equal(breaker.halt, false, 'zero-completions is the halt condition — one landed job must clear it regardless of spend');
});

test('BRO-3924 (R5): a job-done from a prior local calendar day does not count toward today\'s spend', () => {
  const id = 'linear:BRO-920';
  const entries = [
    { ts: T(24 * 60 + 10), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: id },
    { ts: T(24 * 60 + 9), event: 'launch', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(24 * 60 + 9), event: 'job-spawned', jobId: 'job-920', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(24 * 60 + 1), event: 'job-done', jobId: 'job-920', taskId: id, costUSD: 999 },
  ];
  const breaker = core.watchdogSpendBreaker(entries, NOW);
  assert.equal(breaker.liveNow, 0, 'the job already finished — nothing is in flight');
  assert.equal(breaker.spentUSD, 0, 'a completed job from a prior local day must not count toward today\'s spend');
});

test('BRO-3924 (R5): watchdogSpendRows attributes each claim to its OWN job, not a stale earlier one for the same task', () => {
  const id = 'linear:BRO-930';
  const entries = [
    ...headlessOpen(id, 'jobA', T(60), T(59)),
    { ts: T(50), event: 'job-failed', jobId: 'jobA', taskId: id, costUSD: 2 },
    ...headlessOpen(id, 'jobB', T(40), T(39)),
    { ts: T(30), event: 'job-done', jobId: 'jobB', taskId: id, costUSD: 8 },
  ];
  const rows = core.watchdogSpendRows(entries, NOW);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.usd).sort((a, b) => a - b), [2, 8]);
  assert.deepEqual(rows.map(r => r.event).sort(), ['card-fail', 'card-pass']);
});

test('BRO-3924 (R5): a card the watchdog never claimed contributes nothing to spend, even if its job completes today', () => {
  const id = 'linear:BRO-940';
  const entries = [
    // No WATCHDOG_EVENTS.REDISPATCH row for this task — a manual/owner dispatch.
    { ts: T(9), event: 'launch', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(9), event: 'job-spawned', jobId: 'job-940', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(1), event: 'job-done', jobId: 'job-940', taskId: id, costUSD: 500 },
  ];
  const breaker = core.watchdogSpendBreaker(entries, NOW);
  assert.equal(breaker.spentUSD, 0);
  assert.equal(breaker.liveNow, 0);
});

test('BRO-3924 (R5, Codex catch): medianJobCostUSD samples job-failed cost, not just job-done — a crash loop must not fall back to the cold-start figure', () => {
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push({ ts: T(60), event: 'job-spawned', jobId: `f${i}`, taskId: `linear:BRO-97${i}` });
    entries.push({ ts: T(1), event: 'job-failed', jobId: `f${i}`, taskId: `linear:BRO-97${i}`, costUSD: 20 });
  }
  assert.equal(core.medianJobCostUSD(entries, NOW), 20);
});

test('BRO-3924 (R5, subagent catch): a negative costUSD row cannot offset legitimate spend', () => {
  const id = 'linear:BRO-980';
  const entries = [
    ...headlessOpen(id, 'job-980', T(10), T(9)),
    { ts: T(1), event: 'job-done', jobId: 'job-980', taskId: id, costUSD: -50 },
  ];
  const rows = core.watchdogSpendRows(entries, NOW);
  assert.equal(rows[0].usd, 0, 'a negative cost must clamp to 0, never subtract');
});

test('BRO-3924 (R5, Codex catch): a retry-timeout still records the resumed job\'s real cost, not zero', () => {
  const id = 'linear:BRO-990';
  const entries = [
    { ts: T(120), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: id },
    { ts: T(119), event: 'launch', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(119), event: 'job-spawned', jobId: 'job-990', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(90), event: 'job-retried', jobId: 'job-990', taskId: id, costUSD: 4 },
    // No successor ever spawns — well past SPEND_ORPHAN_TIMEOUT_H (1h).
  ];
  const rows = core.watchdogSpendRows(entries, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 4);
  assert.equal(rows[0].event, 'card-fail');
});

test('BRO-3924 (R5, Codex catch): an ancient abandoned claim cannot acquire a much-later unrelated job\'s cost or success', () => {
  const id = 'linear:BRO-991';
  const entries = [
    // A claim from 10 days ago — no job ever spawned for IT.
    { ts: T(10 * 24 * 60), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: id },
    // A completely unrelated manual dispatch today, unconnected to the watchdog.
    { ts: T(9), event: 'launch', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(9), event: 'job-spawned', jobId: 'manual-job', taskId: id, workspaceRef: `headless:${id}` },
    { ts: T(1), event: 'job-done', jobId: 'manual-job', taskId: id, costUSD: 12 },
  ];
  const rows = core.watchdogSpendRows(entries, NOW);
  assert.deepEqual(rows, [], 'the ancient claim must be outside the lookback window and never offered to classifyDispatches');
});

test('BRO-3924 (R5, Codex catch): the spend breaker recomputes cleanly with only the current window\'s claims (no lookback regression for recent retries)', () => {
  const id = 'linear:BRO-992';
  const entries = [
    ...headlessOpen(id, 'job-992a', T(47 * 60), T(47 * 60 - 1)), // 47h ago — inside the 48h lookback
    { ts: T(46 * 60), event: 'job-done', jobId: 'job-992a', taskId: id, costUSD: 6 },
  ];
  const rows = core.watchdogSpendRows(entries, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 6);
});

test('BRO-3924 (R3, Codex catch): a stale sweep report (past the max-age window) is treated as empty, a fresh one is trusted', () => {
  const wd = require('../dispatch-watchdog.js');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-report-'));
  const reportPath = path.join(tmpDir, 'report.json');
  const now = Date.now();
  const write = (generatedAt) => fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt, checkoutSha: 'deadbeef',
    alreadyDone: [{ id: 'BRO-1', name: 'x', verifyCmd: 'test -f x' }],
  }));

  write(new Date(now - 72 * 3600 * 1000).toISOString()); // 72h old, past the 48h max age
  assert.deepEqual(wd.loadAlreadyPassesReport(now, reportPath).alreadyDone, []);

  write(new Date(now - 1 * 3600 * 1000).toISOString()); // 1h old — well within the window
  assert.equal(wd.loadAlreadyPassesReport(now, reportPath).alreadyDone.length, 1);

  write('not-a-date');
  assert.deepEqual(wd.loadAlreadyPassesReport(now, reportPath).alreadyDone, [], 'an unparseable generatedAt must not be trusted as fresh');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('BRO-3924 (R5): the spend hold surfaces in globalHolds/pausedByPolicy/toDispatch exactly like the other caps', () => {
  const entries = [];
  for (let i = 0; i < core.CAPS.watchdogConcurrent; i++) {
    entries.push(...headlessOpen(`linear:BRO-95${i}`, `job-95${i}`, T(5), T(4)));
  }
  const plan = core.planSweep(entries, new Map([lin('BRO-960', 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.pausedByPolicy, true);
  assert.equal(plan.toDispatch.length, 0);
  assert.ok(plan.budgets.holds.some(h => h.includes('spend circuit breaker')));
});

// ── stallDetectionDepth (2026-09-22 ship-check) ─────────────────────────────
// The depth the stall detector's claims path reads. These run through the REAL
// planSweep so a renamed/dropped budgets field fails here, not in production.
const H = 3600 * 1000;
const SIX_H = 6 * H;
const hAgo = h => new Date(NOW - h * H).toISOString();

test('stallDetectionDepth: normal sweep reads toDispatch', () => {
  const tasks = new Map([lin('BRO-100', 'pending', 'P1 Now'), lin('BRO-101', 'pending', 'P1 Now')]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }), plan.toDispatch.length);
  assert.ok(plan.toDispatch.length > 0);
});

test('stallDetectionDepth: claim outage after the wedge claimed the WHOLE queue still reads > 0 (reviewer repro)', () => {
  // 10 cards, all claimed 7h ago, nothing launched anywhere: p01Queue and
  // laneEligible are empty (claimPending), toDispatch is 0 — the pre-fix
  // depth silenced the claims path in exactly the case it exists for.
  const ids = Array.from({ length: 10 }, (_, i) => `BRO-${200 + i}`);
  const tasks = new Map(ids.map(id => lin(id, 'pending', 'P1 Now')));
  const entries = ids.map(id => ({ ts: hAgo(7), event: 'watchdog-redispatch', taskId: `linear:${id}`, kind: 'p01-backlog' }));
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.globalHoldFlags.claimOutage, true);
  assert.equal(plan.budgets.laneEligible, 0);
  assert.equal(plan.toDispatch.length, 0);
  assert.equal(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }), 10);
});

test('stallDetectionDepth: claim outage + kill switch is a policy pause -> 0', () => {
  const ids = Array.from({ length: 5 }, (_, i) => `BRO-${300 + i}`);
  const tasks = new Map(ids.map(id => lin(id, 'pending', 'P1 Now')));
  const entries = ids.map(id => ({ ts: hAgo(7), event: 'watchdog-redispatch', taskId: `linear:${id}`, kind: 'p01-backlog' }));
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE, dispatchEnabled: false });
  assert.equal(plan.budgets.globalHoldFlags.killSwitch, true);
  assert.equal(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }), 0);
});

function concurrencyFixture(launchAgeH, slots = 6) {
  // `slots` (default 6) watchdog-claimed tasks whose launches never closed -> concurrency at cap,
  // plus 3 fresh P1 cards waiting.
  const held = Array.from({ length: slots }, (_, i) => `BRO-${400 + i}`);
  const waiting = ['BRO-500', 'BRO-501', 'BRO-502'];
  const tasks = new Map([...held, ...waiting].map(id => lin(id, 'in_progress', 'P1 Now')));
  for (const id of waiting) tasks.set(`linear:${id}`, lin(id, 'pending', 'P1 Now')[1]);
  const entries = [];
  held.forEach((id, i) => {
    entries.push({ ts: hAgo(launchAgeH + 0.1), event: 'watchdog-redispatch', taskId: `linear:${id}`, kind: 'p01-backlog' });
    entries.push({ ts: hAgo(launchAgeH), event: 'launch', taskId: `linear:${id}`, subject: id, workspaceRef: `workspace:${600 + i}` });
  });
  return { entries, tasks };
}

test('stallDetectionDepth: concurrency cap held by FRESH slots is pacing -> 0', () => {
  const { entries, tasks } = concurrencyFixture(1);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.globalHoldFlags.concurrency, true);
  assert.equal(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }), 0);
});

test('stallDetectionDepth: concurrency cap held by slots older than the window is a failure -> waiting work counts (16-19 Sep zombies)', () => {
  const { entries, tasks } = concurrencyFixture(30);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.globalHoldFlags.concurrency, true);
  assert.equal(plan.budgets.oldestLiveSlotTs, Date.parse(hAgo(30)));
  assert.ok(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }) > 0);
});

test('stallDetectionDepth: stale concurrency + day budget spent is still a policy pause -> 0', () => {
  const { entries, tasks } = concurrencyFixture(30);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  const withBudget = { ...plan, budgets: { ...plan.budgets, globalHoldFlags: { ...plan.budgets.globalHoldFlags, dayBudget: true } } };
  assert.equal(core.stallDetectionDepth(withBudget, { now: NOW, staleSlotMs: SIX_H }), 0);
});

test('stallDetectionDepth: spend breaker tripped ONLY by the stale slots\' reservation is the wedge, not a spend decision', () => {
  // 6 zombie slots x median cost reserve >= the $36 bar with zero real spend:
  // main's breaker halts on that alone and never releases (slots never close).
  const { entries, tasks } = concurrencyFixture(30);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.globalHoldFlags.spendHalt, true);
  assert.equal(plan.budgets.spend.spentUSD, plan.budgets.spend.reservedUSD);
  assert.ok(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }) > 0);
  // Same slots FRESH -> concurrency is pacing and the reservation is real: 0.
  const fresh = concurrencyFixture(1);
  const freshPlan = core.planSweep(fresh.entries, fresh.tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(core.stallDetectionDepth(freshPlan, { now: NOW, staleSlotMs: SIX_H }), 0);
});

test('stallDetectionDepth: stale concurrency + spend breaker on REAL spend, or any unknown global hold, is a policy pause -> 0', () => {
  const { entries, tasks } = concurrencyFixture(30);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  const f = plan.budgets.globalHoldFlags;
  const realSpend = { ...plan.budgets.spend, halt: true, spentUSD: 80, reservedUSD: 36.96, thresholdUSD: 36 };
  const spend = { ...plan, budgets: { ...plan.budgets, spend: realSpend, globalHoldFlags: { ...f, spendHalt: true } } };
  assert.equal(core.stallDetectionDepth(spend, { now: NOW, staleSlotMs: SIX_H }), 0);
  const unknown = { ...plan, budgets: { ...plan.budgets, globalHolds: [...plan.budgets.globalHolds, 'some future hold'] } };
  assert.equal(core.stallDetectionDepth(unknown, { now: NOW, staleSlotMs: SIX_H }), 0);
});

test('stallDetectionDepth: claims stuck >6h while unrelated retries keep launching (no claimOutage) still count (Codex P1)', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `BRO-${700 + i}`);
  const tasks = new Map(ids.map(id => lin(id, 'pending', 'P1 Now')));
  const entries = ids.map(id => ({ ts: hAgo(7), event: 'watchdog-redispatch', taskId: `linear:${id}`, kind: 'p01-backlog' }));
  // an unrelated launch 10 min ago keeps fleet-wide launches flowing
  entries.push({ ts: T(10), event: 'launch', taskId: 'linear:BRO-999', subject: 'other', workspaceRef: 'workspace:77' });
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.globalHoldFlags.claimOutage, false);
  assert.equal(plan.toDispatch.length, 0);
  assert.equal(plan.budgets.awaitingClaimCount, 10);
  assert.equal(core.stallDetectionDepth(plan, { now: NOW, staleSlotMs: SIX_H }), 10);
});

test('stallDetectionDepth: 5 stale slots UNDER the cap tripping the spend breaker by reservation alone is the wedge (Codex P1)', () => {
  const { entries, tasks } = concurrencyFixture(30, 5);
  const plan = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(plan.budgets.globalHoldFlags.concurrency, false);
  assert.equal(plan.budgets.liveSlotTimes.length, 5);
  // $8 median x 5 stale slots = $40 reserved, zero real spend, $36 bar.
  const spend = { ...plan.budgets.spend, halt: true, spentUSD: 40, reservedUSD: 40, perJobUSD: 8, thresholdUSD: 36 };
  const tripped = { ...plan, toDispatch: [], budgets: { ...plan.budgets, spend,
    globalHoldFlags: { ...plan.budgets.globalHoldFlags, spendHalt: true }, globalHolds: ['spend circuit breaker'] } };
  assert.ok(core.stallDetectionDepth(tripped, { now: NOW, staleSlotMs: SIX_H }) > 0);
  // Same slots FRESH: the reservation is real committed spend -> policy pause.
  const fresh = concurrencyFixture(1, 5);
  const fp = core.planSweep(fresh.entries, fresh.tasks, { now: NOW, liveTitles: LIVE });
  const freshTripped = { ...fp, toDispatch: [], budgets: { ...fp.budgets, spend,
    globalHoldFlags: { ...fp.budgets.globalHoldFlags, spendHalt: true }, globalHolds: ['spend circuit breaker'] } };
  assert.equal(core.stallDetectionDepth(freshTripped, { now: NOW, staleSlotMs: SIX_H }), 0);
  // Real spend over the bar beyond the stale reservation: policy pause.
  const real = { ...tripped, budgets: { ...tripped.budgets, spend: { ...spend, spentUSD: 90 } } };
  assert.equal(core.stallDetectionDepth(real, { now: NOW, staleSlotMs: SIX_H }), 0);
});

test('watchdogLiveOldestTs: skips unparseable ts (one NaN must not read every slot as fresh), null when none', () => {
  assert.equal(core.watchdogLiveOldestTs([]), null);
  const entries = [
    { ts: hAgo(10), event: 'watchdog-redispatch', taskId: 'linear:BRO-1', kind: 'p01-backlog' },
    { ts: hAgo(9), event: 'launch', taskId: 'linear:BRO-1', workspaceRef: 'workspace:1' },
    { ts: hAgo(3), event: 'watchdog-redispatch', taskId: 'linear:BRO-2', kind: 'p01-backlog' },
    { ts: 'garbage', event: 'launch', taskId: 'linear:BRO-2', workspaceRef: 'workspace:2' },
  ];
  assert.equal(core.watchdogLiveOldestTs(entries), Date.parse(hAgo(9)));
});
