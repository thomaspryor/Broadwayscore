#!/usr/bin/env node
/**
 * bsc-reconcile — the "expected running vs actually running" tick for headless
 * jobs (Autopilot v5 R3, task #459). Runs every 5 min from its OWN launchd job
 * (com.broadwayscore.bsc-reconcile) — deliberately NOT the action-dispatcher
 * tick, whose 35-min card lock would delay orphan detection exactly when jobs
 * are running (plan-review Codex + design findings).
 *
 * What it does, in order:
 *   1. Fold dispatch-ledger job events → open (non-terminal) jobs.
 *   2. For each open job: lease PID alive and still a claude process? If not,
 *      append job-orphaned (PID-liveness with argv match is the PRIMARY signal —
 *      never heartbeat staleness; a busy job is not a dead job).
 *   3. Optional resume-retry of orphans — OFF by default (BSC_RECONCILE_RETRY=1
 *      to enable) and hard-capped at 2/tick, 6/24h. Detection ships a week
 *      before automation: the pre-mortem's spawn-storm scenario dies here.
 *   4. Sweep lease dirs whose task has no open job (crash stragglers).
 *   5. Report: orphans/retries append one line each to the Mac-local morning
 *      digest queue (data/audit/reconcile-report.jsonl, gitignored) — NEVER the
 *      git-tracked alert-ledger (a Mac-local writer there hits last-writer-wins
 *      clobber against CI pushes).
 *
 * Detection quality note: "PID alive" alone is not enough — PIDs recycle — so
 * liveness = kill-style existence AND ps argv contains `claude`
 * (bsc-runner.pidLooksLikeClaude).
 *
 * Task #883 (owner pain 2026-08-03, "so painful when cmux hangs"): the above
 * only ever covered headless (lease-based) jobs. The overwhelming majority of
 * dispatches are cmux TABS, which had no equivalent self-heal — after a cmux
 * freeze/restart a tab's claude process can die silently and nothing
 * notices (task #853 was found dead only by a manual 35-workspace audit).
 * reconcileTaskSessions() below extends this SAME 5-min tick to sweep the
 * shared task list's in_progress tasks, checks each dispatcher-tracked
 * workspace with the session-shaped two-signal liveness check (#578) after
 * waking cmux once first (the #849 lazy-exec-tab fix — a backgrounded app
 * can leave an existing tab's surface dormant the same way it defers a
 * brand-new launch), and re-dispatches dead ones through bsc-next.js's
 * normal --id path — inheriting every existing guard (duplicate-dispatch,
 * dead-attempt limit, the #883 park-guard fix) instead of reimplementing any
 * of them. Deliberately reuses this file's own report()/REPORT_PATH
 * (append-only, gitignored, Mac-local) rather than a second events file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const USAGE = `Usage: node scripts/bsc-reconcile.js [--dry-run]
Marks headless jobs whose process died as orphaned, sweeps stale leases,
re-dispatches in_progress tasks whose cmux tab died, re-dispatches stalled
in_progress tasks whose last job/tab terminated without completing them,
queues digest lines. Retry of orphaned headless jobs requires BSC_RECONCILE_RETRY=1.`;

// --help before ANY side effect (house rule: --help fall-through incidents).
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const ledger = require('./lib/dispatch-ledger.js');
const cmuxws = require('./lib/cmux-workspaces.js');
const { hasAutoDispatchMarker } = require('./lib/prune-closeable.js');
const { setAppFocus, osActivateCmuxApp } = require('./lib/cmux-launch.js');
const reviveSessionLib = require('./lib/revive-session.js');
const bscNext = require('./bsc-next.js');
const { readLease, releaseLease, pidLooksLikeClaude, runJob, LEASE_ROOT, REPO } = require('./lib/bsc-runner.js');

const REPORT_PATH = path.join(REPO, 'data', 'audit', 'reconcile-report.jsonl');
const DRY = process.argv.includes('--dry-run');
const MAX_RETRIES_PER_TICK = 2;
const MAX_RETRIES_PER_DAY = 6;
const GRACE_MS = 2 * 60 * 1000; // startup window before pid:null counts as dead
// Same per-tick throttle shape as MAX_RETRIES_PER_TICK above (task #883,
// ship-check catch): a first-ever run against a backlog with several
// genuinely-dead sessions would otherwise re-dispatch all of them in one
// tick — the owner's own soft cap is "more than ~3 auto-dispatches in one
// session, pause and confirm." Spreading a burst over several 5-min ticks
// costs nothing (these are corpses, not urgent), and keeps the reconciler
// itself from being the thing that manufactures a dispatch storm.
const MAX_REDISPATCH_PER_TICK = 2;
// Bounds the child bsc-next --id call (task #883, ship-check catch): the
// cmux hang this whole feature exists to route around is exactly the
// condition that can also wedge the `cmux` CLI calls bsc-next itself makes
// on the launch path. Without a cap here, one hung dispatch attempt blocks
// this entire 5-min launchd tick indefinitely — including the headless-job
// orphan detection above it in main() — silently disabling the self-heal.
// 10 min gives clear headroom above bsc-next's own documented worst-case
// synchronous wait (verifyTimeoutSec 90s + slowBootCapSec 360s +
// lateAdoptSec 60s ≈ 8.5 min — see cmux-launch.js's launchCmux() call).
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
// Task #985: same per-tick throttle shape as MAX_REDISPATCH_PER_TICK — a
// revive respawns a live pane in place (not a fresh dispatch), but capping it
// keeps a first-ever run against several flagless tabs from hammering cmux
// (and the owner's screen, if any of them wake it) in one tick.
const MAX_REVIVE_PER_TICK = 3;

function report(line) {
  const entry = { ts: new Date().toISOString(), ...line };
  console.log(`[bsc-reconcile] ${entry.kind}: ${entry.detail}`);
  if (DRY) return;
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.appendFileSync(REPORT_PATH, JSON.stringify(entry) + '\n');
  } catch (e) { console.error(`[bsc-reconcile] report write failed: ${e.message}`); }
}

function retriesInLast24h(entries) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return entries.filter(e => e.event === ledger.JOB_EVENTS.RETRIED && Date.parse(e.ts) > cutoff).length;
}

function sleepMs(ms) { spawnSync('sleep', [String(ms / 1000)]); }

// Pure argv builder for the redispatch child process (extracted so the
// --force requirement — see the header comment on dispatchFn's default
// below — is directly testable without invoking a real spawnSync).
function redispatchArgv(taskId) {
  return [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId), '--force'];
}

// Stalled-task redispatch deliberately does NOT carry --force: unlike the
// dead-tab case above there is no live-looking workspace for the
// duplicate-dispatch guard to false-match on (the whole trigger is that the
// ledger shows nothing open), so every bsc-next guard — parked, dead-attempt,
// duplicate — should stay armed and be the honest reason a redispatch is
// refused.
function stallRedispatchArgv(taskId) {
  return [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId)];
}

// ── In-progress task session reconciler (task #883) ────────────────────────
// See the file header comment for the "why". Deps are injectable so this is
// unit-testable without a live cmux socket or task-list directory, matching
// bsc-prune.js's mainLocked/sweepVanished pattern.
function reconcileTaskSessions({ dryRun = false, deps = {} } = {}) {
  const {
    loadTasksFn = bscNext.loadTasks,
    tasksDir = bscNext.TASKS_DIR,
    listWorkspacesFn = cmuxws.listWorkspaces,
    isDoneTitleFn = cmuxws.isDoneTitle,
    claudeAliveInFn = cmuxws.claudeAliveIn,
    surfaceAliveInFn = cmuxws.terminalSurfaceAliveIn,
    readLedgerEntriesFn = ledger.readEntries,
    wakeFn = () => { osActivateCmuxApp(); return setAppFocus('active'); },
    clearWakeFn = () => setAppFocus('clear'),
    sleepFn = sleepMs,
    // --force is REQUIRED here, not a shortcut (self-review catch,
    // 2026-08-03): bsc-next's duplicate-dispatch guard (findLiveWorkspaceForTask)
    // matches on listing+title only, never liveness — the dead-but-still-open
    // tab this function just confirmed dead via TWO independent checkLiveness
    // calls (initial + post-wake) is exactly what that guard would otherwise
    // match and refuse as "a live workspace already matches task #N," even
    // though it is not live. Without --force, every redispatch attempt for
    // the literal scenario this reconciler exists for (#853: tab open,
    // claude dead inside) would be refused forever and nothing would heal.
    // Safe to force specifically because this function has ALREADY done more
    // verification than a human running --force blind, and already re-checks
    // everything else --force would otherwise skip at the call site: the
    // dead-attempt-limit (checked just below, mirroring deadDispatchGuard)
    // and parkedGuard/completedLaunchGuard (moot — this function never acts
    // on a missing ref or a non-in_progress task in the first place).
    dispatchFn = (taskId) => spawnSync('node', redispatchArgv(taskId), { encoding: 'utf8', cwd: REPO, timeout: DISPATCH_TIMEOUT_MS }),
    reportFn = report,
  } = deps;

  const tasks = loadTasksFn(tasksDir).filter(t => t.status === 'in_progress');
  if (!tasks.length) return { checked: 0, dead: [], redispatched: [] };

  const entries = readLedgerEntriesFn();
  // Latest workspace-shaped, non-terminal launch per task — what the ledger
  // currently believes is a live cmux session. Tasks with no such launch
  // were never dispatcher-managed (an interactively-opened session, or a
  // task claimed by hand) — nothing here to reconcile them against.
  const openLaunches = ledger.openTaskWorkspaceLaunches(entries);

  let workspaces;
  try { workspaces = listWorkspacesFn(); } catch (e) {
    reportFn({ kind: 'task-sweep-error', taskId: 'sweep', detail: `cmux listing failed: ${e.message}` });
    return { checked: tasks.length, dead: [], redispatched: [], error: e.message };
  }
  let byRef = new Map(workspaces.map(w => [w.ref, w]));

  const candidates = [];
  for (const task of tasks) {
    const launch = openLaunches.get(String(task.id));
    if (!launch) continue;
    const ws = byRef.get(launch.workspaceRef);
    // A ref MISSING from the listing (ship-check P1 fix, 2026-08-03) is
    // deliberately NOT this reconciler's call — it is ambiguous between a
    // cmux-restart renumber and the owner closing the tab, and bsc-prune's
    // sweepVanished() ALREADY owns that exact disambiguation (title-match
    // remap, then a bounded restart-hold before parking). Racing ahead of
    // it here — which an earlier version of this function did — could
    // re-dispatch a task the owner just closed, before bsc-prune's
    // 'vanished'/park write ever lands to make bsc-next's parkedGuard
    // refuse it: the exact regression #578's park guard exists to prevent.
    // Only act when the workspace IS still listed but its claude process is
    // confirmed gone — that is the literal "in_progress task with a dead
    // session" this card names (the #853 "found dead manually" shape).
    if (!ws) continue;
    if (isDoneTitleFn(ws.title)) continue; // finished — bsc-prune closes it
    if (!cmuxws.checkLiveness(ws.ref, claudeAliveInFn, surfaceAliveInFn).dead) continue;
    candidates.push({ task, launch });
  }
  if (!candidates.length) return { checked: tasks.length, dead: [], redispatched: [] };

  // Wake cmux once before trusting a "dead" verdict (#849 lazy-exec fix): a
  // backgrounded app can leave an EXISTING tab's surface dormant the same
  // way it defers a brand-new launch's typed command. Re-list and re-check
  // after a short nudge before concluding the session is actually gone.
  wakeFn();
  sleepFn(3000);
  try { workspaces = listWorkspacesFn(); byRef = new Map(workspaces.map(w => [w.ref, w])); }
  catch { /* keep the pre-wake snapshot — a failed re-list must not block the sweep */ }
  clearWakeFn();

  const dead = candidates.filter(({ launch }) => {
    const ws = byRef.get(launch.workspaceRef);
    if (!ws) return false; // vanished between the two listings — bsc-prune's call now, not ours
    return cmuxws.checkLiveness(ws.ref, claudeAliveInFn, surfaceAliveInFn).dead;
  });

  const redispatched = [];
  let dispatchBudget = MAX_REDISPATCH_PER_TICK;
  for (const { task, launch } of dead) {
    reportFn({ kind: 'task-session-dead', taskId: task.id, detail: `in_progress task #${task.id} "${task.subject}" — dispatched workspace ${launch.workspaceRef} has no live claude process` });
    if (dryRun) continue;
    // Refuse to keep re-shelling a task bsc-next has already given up on
    // (ship-check P2 fix): once DEAD_ATTEMPT_LIMIT deaths are recorded,
    // EVERY future bsc-next --id call for it fails the same way forever —
    // without this check the reconciler would hammer it every 5 minutes,
    // stealing cmux focus (wakeFn) and spamming the digest for no gain. It
    // genuinely needs a human (or --force) now; surface that once per tick,
    // not retry it.
    if (ledger.deadAttemptsForTask(task.id, entries).length >= ledger.DEAD_ATTEMPT_LIMIT) {
      reportFn({ kind: 'task-redispatch-blocked', taskId: task.id, detail: `#${task.id} has already died ${ledger.DEAD_ATTEMPT_LIMIT}+ times — needs investigation or --force, not another automatic retry` });
      continue;
    }
    if (dispatchBudget <= 0) {
      reportFn({ kind: 'task-redispatch-throttled', taskId: task.id, detail: `#${task.id} deferred — this tick's redispatch budget (${MAX_REDISPATCH_PER_TICK}) is spent; will retry next tick` });
      continue;
    }
    dispatchBudget--;
    let r;
    try { r = dispatchFn(task.id); } catch (e) { r = { status: 1, stderr: e.message }; }
    const ok = r.status === 0;
    reportFn({
      kind: ok ? 'task-redispatched' : 'task-redispatch-refused',
      taskId: task.id,
      detail: ok
        ? `re-dispatched #${task.id} via bsc-next --id`
        : `bsc-next refused #${task.id}: ${String(r.stderr || r.stdout || 'unknown error').trim().split('\n').slice(-1)[0]}`,
    });
    if (ok) redispatched.push(task.id);
  }

  return { checked: tasks.length, dead: dead.map(d => d.task.id), redispatched };
}

// ── Stalled-task sweep (owner mandate 2026-08-03: "close the loop") ────────
// The 2026-08-03 digest claimed four issues were "being fixed by a session
// right now" (#733/#807/#808/#935); in reality every one had been dispatched
// as a headless job that TERMINATED hours earlier (job-failed for two,
// job-done without the task ever being completed for the other two) while the
// task sat in_progress. That state was invisible to both sweeps above: the
// orphan sweep only watches OPEN jobs, and reconcileTaskSessions only watches
// open WORKSPACE launches. This sweep owns the leftover shape: an in_progress
// task whose ledger holds SOME dispatch history but nothing open — no live
// tab, no live job. It redispatches once per stall through bsc-next's normal
// guarded path (no --force — see stallRedispatchArgv), and stamps a
// stall-sweep marker either way so a refused/parked task is surfaced once,
// not re-attempted every 5-minute tick. Tasks with NO ledger history at all
// are skipped on purpose — same rationale as reconcileTaskSessions: a
// hand-claimed interactive session is invisible to us and not ours to declare
// dead.
const STALL_EVENT = 'stall-sweep-attempted';
const STALL_COOLDOWN_MS = 30 * 60 * 1000; // let a just-finished session's task-status writes land first
// Codex pre-ship catch: deadAttemptsForTask counts only failures/orphans, so a
// job that keeps ending job-DONE without ever completing its task would re-arm
// the sweep every cooldown — one task could burn ~48 sessions/day forever.
// Total stall redispatches per task are therefore capped by counting the
// task's own stall markers: past the cap it gets ONE task-stall-exhausted
// report per re-arm (which lands in the digest's stuck bucket) and no more
// sessions until a human intervenes.
const MAX_STALL_ATTEMPTS_PER_TASK = 2;

function reconcileStalledTasks({ dryRun = false, deps = {} } = {}) {
  const {
    loadTasksFn = bscNext.loadTasks,
    tasksDir = bscNext.TASKS_DIR,
    readLedgerEntriesFn = ledger.readEntries,
    appendLedgerFn = ledger.appendEntry,
    dispatchFn = (taskId) => spawnSync('node', stallRedispatchArgv(taskId), { encoding: 'utf8', cwd: REPO, timeout: DISPATCH_TIMEOUT_MS }),
    reportFn = report,
    nowFn = Date.now,
  } = deps;

  const tasks = loadTasksFn(tasksDir).filter(t => t.status === 'in_progress');
  if (!tasks.length) return { checked: 0, stalled: [], redispatched: [] };

  const entries = readLedgerEntriesFn();
  const openLaunches = ledger.openTaskWorkspaceLaunches(entries);
  const openJobTasks = new Set(ledger.openJobs(entries).map(j => String(j.taskId)));

  const stalled = [];
  const redispatched = [];
  let dispatchBudget = MAX_REDISPATCH_PER_TICK;

  for (const task of tasks) {
    const id = String(task.id);
    if (openLaunches.has(id) || openJobTasks.has(id)) continue; // something is (believed) live — other sweeps own it
    const taskEntries = entries.filter(e => String(e.taskId) === id);
    if (!taskEntries.length) continue; // never dispatcher-managed — invisible on purpose

    const tsOf = (e) => Date.parse(e.ts || '') || 0;
    const lastActivity = Math.max(...taskEntries.filter(e => e.event !== STALL_EVENT).map(tsOf));
    if (!lastActivity || nowFn() - lastActivity < STALL_COOLDOWN_MS) continue; // still settling
    const markers = taskEntries.filter(e => e.event === STALL_EVENT);
    const lastMarker = Math.max(0, ...markers.map(tsOf));
    if (lastMarker >= lastActivity) continue; // this stall already attempted/surfaced — new activity re-arms

    // Classify how the last dispatch ended, purely for the report line.
    const jobs = [...ledger.foldJobs(taskEntries).values()].sort((a, b) => tsOf(a) - tsOf(b));
    const lastJob = jobs[jobs.length - 1];
    const how = lastJob
      ? (lastJob.event === ledger.JOB_EVENTS.DONE ? 'last job reported done but the task was never completed' : `last job ended ${lastJob.event}`)
      : 'last workspace launch is terminal';

    stalled.push(id);
    reportFn({ kind: 'task-stalled', taskId: id, detail: `in_progress task #${id} "${task.subject}" has no live session or job (${how}) — nothing is actually working on it` });
    if (dryRun) continue;

    if (markers.length >= MAX_STALL_ATTEMPTS_PER_TASK) {
      appendLedgerFn({ event: STALL_EVENT, taskId: id });
      reportFn({ kind: 'task-stall-exhausted', taskId: id, detail: `#${id} has already been stall-redispatched ${markers.length}x and is stalled AGAIN — a session keeps ending without completing it; needs a human look, no further automatic sessions` });
      continue;
    }
    if (ledger.deadAttemptsForTask(id, entries).length >= ledger.DEAD_ATTEMPT_LIMIT) {
      // Marker stamped: this verdict is stable, so surface it once per stall,
      // not every 5-minute tick.
      appendLedgerFn({ event: STALL_EVENT, taskId: id });
      reportFn({ kind: 'task-stall-blocked', taskId: id, detail: `#${id} already died ${ledger.DEAD_ATTEMPT_LIMIT}+ times — needs a human look, not another automatic retry` });
      continue;
    }
    if (dispatchBudget <= 0) {
      // NO marker on throttle: the budget is per-tick, so the next tick must
      // pick this task up again — a backlog drains at MAX_REDISPATCH_PER_TICK
      // per tick instead of stalling forever behind a spent budget.
      reportFn({ kind: 'task-stall-throttled', taskId: id, detail: `#${id} deferred — this tick's stall budget (${MAX_REDISPATCH_PER_TICK}) is spent` });
      continue;
    }
    // Marker stamped before the attempt: whether bsc-next accepts or refuses
    // (parked card, card-gate rejection), the outcome is recorded once and the
    // report line is the surface — a refusal must not re-fire every tick.
    appendLedgerFn({ event: STALL_EVENT, taskId: id });
    dispatchBudget--;
    let r;
    try { r = dispatchFn(id); } catch (e) { r = { status: 1, stderr: e.message }; }
    const ok = r && r.status === 0;
    reportFn({
      kind: ok ? 'task-stall-redispatched' : 'task-stall-refused',
      taskId: id,
      detail: ok
        ? `re-dispatched stalled #${id} via bsc-next --id`
        : `bsc-next refused stalled #${id}: ${String((r && (r.stderr || r.stdout)) || 'unknown error').trim().split('\n').slice(-1)[0]}`,
    });
    if (ok) redispatched.push(id);
  }

  return { checked: tasks.length, stalled, redispatched };
}

// ── Flagless-resume sweep (task #985) ───────────────────────────────────────
// cmux's OWN restart-recovery path (triggered reviving a dead pane — #886)
// can resume a session with a bare `claude --worktree X --resume <id>`
// command that never carries --dangerously-skip-permissions, so a 🤖
// auto-dispatched tab silently degrades to manual permission mode and stalls
// on the next tool-call approval — invisible to every OTHER sweep in this
// file, which only checks whether a claude process exists, not what flags it
// was started with. Every 🤖 workspace with a LIVE claude process is checked
// each tick; a flagless one is respawned in place (same pane, flag restored)
// via revive-session.js rather than closed/redispatched, so the owner's tab
// and its conversation stay put.
function reconcileFlaglessSessions({ dryRun = false, deps = {} } = {}) {
  const {
    listWorkspacesFn = cmuxws.listWorkspaces,
    claudeAliveInFn = cmuxws.claudeAliveIn,
    claudeMidTurnInFn = cmuxws.claudeMidTurnIn,
    readLedgerEntriesFn = ledger.readEntries,
    detectFn = reviveSessionLib.detectFlaglessSession,
    reviveFn = reviveSessionLib.reviveSession,
    reportFn = report,
  } = deps;

  let workspaces;
  try { workspaces = listWorkspacesFn(); } catch (e) {
    reportFn({ kind: 'flagless-sweep-error', taskId: 'sweep', detail: `cmux listing failed: ${e.message}` });
    return { checked: 0, flagless: [], revived: [] };
  }

  let entries = [];
  try { entries = readLedgerEntriesFn(); } catch { /* isLedgerAutoDispatched below falls back to title-only */ }

  const autoDispatched = workspaces.filter(w =>
    hasAutoDispatchMarker(w.title) || ledger.isLedgerAutoDispatched(w.ref, w.title, entries));

  const flagless = [];
  const revived = [];
  let budget = MAX_REVIVE_PER_TICK;
  for (const ws of autoDispatched) {
    // Never yank a tab the owner is looking at right now (same rule as
    // pruneDone's close-path guard, card #971) — a flagless session stalled
    // at a permission prompt is often exactly the tab the owner has open to
    // go approve it by hand; respawning under them is disruptive, and the
    // next tick catches it if they haven't.
    if (ws.selected) continue;

    // Only a LIVE process can be flagless in a meaningful sense — a dead
    // workspace is reconcileTaskSessions'/bsc-prune's territory, not this
    // sweep's; checking it here would just duplicate their work.
    let alive = true;
    try { alive = claudeAliveInFn(ws.ref); } catch { alive = true; } // fail-safe: uncertain → skip, don't revive
    if (!alive) continue;

    const detection = detectFn(ws.ref, deps);
    if (!detection.flagless) continue;

    flagless.push(ws.ref);
    reportFn({ kind: 'flagless-session', taskId: 'sweep', detail: `🤖 workspace ${ws.ref} "${ws.title}" is running claude WITHOUT --dangerously-skip-permissions (pid ${detection.pid}) — stalls on the next permission prompt` });
    if (dryRun) continue;

    // Mid-turn safety (ship-check adversarial finding): a flagless session
    // that hasn't hit its first permission-gated tool call yet is still
    // ACTIVELY WORKING, not stalled — `cmux respawn-pane` kills the running
    // process outright. Same idle-vs-mid-turn distinction bsc-prune.js
    // already applies before any destructive action on a live claude
    // process (hasLiveClaude && !hasRunningClaude). Only revive when idle —
    // i.e. actually stalled — and defer a busy one to the next tick, when it
    // will either have finished naturally or hit the permission wall and
    // gone idle.
    let running = false;
    try { running = claudeMidTurnInFn(ws.ref); } catch { running = true; } // fail-safe: uncertain → treat as busy, don't kill it
    if (running) {
      reportFn({ kind: 'flagless-revive-deferred-busy', taskId: 'sweep', detail: `${ws.ref} is flagless but still mid-turn (actively running) — deferring revive to next tick rather than killing in-progress work` });
      continue;
    }

    if (budget <= 0) {
      reportFn({ kind: 'flagless-revive-throttled', taskId: 'sweep', detail: `${ws.ref} deferred — this tick's revive budget (${MAX_REVIVE_PER_TICK}) is spent; will retry next tick` });
      continue;
    }
    budget--;
    let result;
    try { result = reviveFn(ws.ref, { deps }); } catch (e) { result = { revived: false, reason: e.message }; }
    reportFn({
      kind: result.revived ? 'flagless-revived' : 'flagless-revive-failed',
      taskId: 'sweep',
      detail: result.revived
        ? `respawned ${ws.ref} with --dangerously-skip-permissions restored`
        : `failed to revive ${ws.ref}: ${result.reason || 'unknown error'}`,
    });
    if (result.revived) revived.push(ws.ref);
  }

  return { checked: autoDispatched.length, flagless, revived };
}

async function main() {
  const entries = ledger.readEntries();
  const open = ledger.openJobs(entries);
  let orphaned = 0;
  const orphans = [];

  for (const job of open) {
    const lease = readLease(job.taskId);
    // STARTUP GRACE (ship-check Codex blocker): a freshly-acquired lease has
    // pid:null until claude-cli's onSpawn lands. Treating that window as dead
    // would orphan a healthy job at t+0 and let a duplicate dispatch in.
    // Anything younger than the grace window is presumed starting.
    const leaseAgeMs = lease && lease.acquiredAt ? Date.now() - Date.parse(lease.acquiredAt) : Infinity;
    const starting = lease && lease.jobId === job.jobId && leaseAgeMs < GRACE_MS;
    const alive = lease && lease.jobId === job.jobId && pidLooksLikeClaude(lease.pid);
    if (alive || starting) continue;
    orphaned++;
    orphans.push({ job, lease });
    if (!DRY) {
      ledger.appendEntry({ event: ledger.JOB_EVENTS.ORPHANED, taskId: job.taskId, jobId: job.jobId, subject: job.subject || '', hadLease: Boolean(lease) });
      releaseLease(job.taskId, job.jobId); // ownership-checked: never removes a replacement job's lease
    }
    report({ kind: 'orphan', taskId: job.taskId, jobId: job.jobId, detail: `job ${job.jobId} (task #${job.taskId} ${job.subject || ''}) has no live claude process` });
  }

  // Optional, capped resume-retry (default OFF — detection first, automation later).
  if (process.env.BSC_RECONCILE_RETRY === '1' && !DRY && orphans.length) {
    const dayCount = retriesInLast24h(entries);
    let budget = Math.min(MAX_RETRIES_PER_TICK, MAX_RETRIES_PER_DAY - dayCount);
    for (const { job, lease } of orphans) {
      if (budget <= 0) {
        report({ kind: 'retry-cap', taskId: job.taskId, detail: `retry cap reached (tick ${MAX_RETRIES_PER_TICK}, day ${MAX_RETRIES_PER_DAY}) — remaining orphans left for the digest` });
        break;
      }
      const alreadyRetried = entries.some(e => e.event === ledger.JOB_EVENTS.RETRIED && e.jobId === job.jobId);
      const sessionId = (lease && lease.sessionId) || job.sessionId;
      // Resume is cwd-scoped: no session, no cwd, or a torn-down worktree ⇒
      // resuming is impossible — leave it orphaned for the digest instead of
      // logging a doomed "resuming" line (ship-check Codex finding).
      if (alreadyRetried || !sessionId || !job.cwd || !fs.existsSync(job.cwd)) continue;
      budget--;
      ledger.appendEntry({ event: ledger.JOB_EVENTS.RETRIED, taskId: job.taskId, jobId: job.jobId, sessionId });
      report({ kind: 'retry', taskId: job.taskId, jobId: job.jobId, detail: `resuming session ${sessionId} for task #${job.taskId}` });
      // Sequential on purpose: one resumed job at a time per tick keeps the
      // blast radius of a bad retry to a single session.
      await runJob({
        taskId: job.taskId, subject: job.subject || '', isolate: false, cwd: job.cwd,
        resumeSessionId: sessionId,
        prompt: 'Your previous headless run was interrupted (process died). Continue exactly where you left off and finish the task.',
        model: job.model || undefined,
        // Short leash: a retry blocking this tick for the full 30-min default
        // would stall orphan detection (launchd skips overlapping runs).
        timeoutMs: 10 * 60 * 1000,
      });
    }
  }

  // Sweep stale lease dirs (task has no open job → nothing should hold it).
  let sweptLeases = 0;
  const openTasks = new Set(ledger.openJobs(ledger.readEntries()).map(j => String(j.taskId)));
  let leaseDirs = [];
  try { leaseDirs = fs.readdirSync(LEASE_ROOT); } catch { /* none yet */ }
  for (const dir of leaseDirs) {
    if (openTasks.has(dir)) continue;
    const lease = readLease(dir);
    if (lease && pidLooksLikeClaude(lease.pid)) continue; // live process, not ours to sweep
    // Same startup grace as the orphan loop (Opus ship-check P0): runJob
    // acquires the lease BEFORE provisioning the worktree and appending
    // job-spawned, so a young pid:null lease with no open job is a healthy
    // job mid-startup, not a straggler.
    const ageMs = lease && lease.acquiredAt ? Date.now() - Date.parse(lease.acquiredAt) : Infinity;
    if (ageMs < GRACE_MS) continue;
    sweptLeases++;
    if (!DRY) releaseLease(dir);
  }

  console.log(`[bsc-reconcile] open=${open.length} orphaned=${orphaned} sweptLeases=${sweptLeases}${DRY ? ' (dry-run)' : ''}`);

  // Task #883: cmux-tab session reconciler, same tick. Failure here must
  // never take down the headless-job detection above it — this whole step
  // is best-effort.
  try {
    const taskSweep = reconcileTaskSessions({ dryRun: DRY });
    console.log(`[bsc-reconcile] tasks checked=${taskSweep.checked} dead=${taskSweep.dead.length} redispatched=${taskSweep.redispatched.length}${DRY ? ' (dry-run)' : ''}`);
  } catch (e) {
    console.error(`[bsc-reconcile] task-session sweep crashed (non-fatal): ${e.message}`);
  }

  // Owner mandate 2026-08-03: stalled-task sweep, same best-effort isolation.
  try {
    const stallSweep = reconcileStalledTasks({ dryRun: DRY });
    console.log(`[bsc-reconcile] stalled checked=${stallSweep.checked} stalled=${stallSweep.stalled.length} redispatched=${stallSweep.redispatched.length}${DRY ? ' (dry-run)' : ''}`);
  } catch (e) {
    console.error(`[bsc-reconcile] stalled-task sweep crashed (non-fatal): ${e.message}`);
  }

  // Task #985: flagless-resume sweep, same best-effort isolation.
  try {
    const flaglessSweep = reconcileFlaglessSessions({ dryRun: DRY });
    console.log(`[bsc-reconcile] flagless checked=${flaglessSweep.checked} flagless=${flaglessSweep.flagless.length} revived=${flaglessSweep.revived.length}${DRY ? ' (dry-run)' : ''}`);
  } catch (e) {
    console.error(`[bsc-reconcile] flagless-session sweep crashed (non-fatal): ${e.message}`);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('bsc-reconcile crashed:', err); process.exit(1); });
}

module.exports = { main, retriesInLast24h, reconcileTaskSessions, reconcileStalledTasks, reconcileFlaglessSessions, redispatchArgv, stallRedispatchArgv, STALL_EVENT, STALL_COOLDOWN_MS, MAX_STALL_ATTEMPTS_PER_TASK, USAGE, REPORT_PATH, MAX_RETRIES_PER_TICK, MAX_RETRIES_PER_DAY, MAX_REDISPATCH_PER_TICK, MAX_REVIVE_PER_TICK };
