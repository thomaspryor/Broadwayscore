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
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
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
const cardDrift = require('./lib/dispatch-card-drift.js');
const cmuxws = require('./lib/cmux-workspaces.js');
const { hasAutoDispatchMarker } = require('./lib/prune-closeable.js');
const { setAppFocus, osActivateCmuxApp, makeSeedProcessProbe } = require('./lib/cmux-launch.js');
const reviveSessionLib = require('./lib/revive-session.js');
const bscNext = require('./bsc-next.js');
const { readLease, releaseLease, pidLooksLikeClaude, runJob, LEASE_ROOT, REPO } = require('./lib/bsc-runner.js');
const { RECHECK_AFTER_RE } = require('./lib/recheck-stamp.js');

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

// ── Timed-out job resume candidates (task #1184 S1) ─────────────────────────
// A job-failed entry with stage 'timeout' now carries sessionId + cwd
// (bsc-runner keeps the worktree on timeout for exactly this). Those are
// resumable: the transcript is on disk, the WIP is in the kept worktree.
// Pure + exported for tests. Caps:
//  - per-job: one resume ever (a RETRIED entry for the jobId, same rule as
//    the orphan path)
//  - per-task: MAX_RESUME_PER_TASK total RETRIED entries — a card that can't
//    finish in (1 + N) × 120 min is not time-starved, it's a bad brief; more
//    sessions won't fix it and attempt-memory should park it instead.
//  - lookback 24h: older timeouts predate today's queue state; their
//    worktrees belong to worktree-gc, not resurrection.
const MAX_RESUME_PER_TASK = 2;
const RESUME_LOOKBACK_MS = 24 * 3600 * 1000;

function collectTimeoutResumeCandidates(entries, { nowMs, lookbackMs = RESUME_LOOKBACK_MS, maxResumePerTask = MAX_RESUME_PER_TASK } = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('collectTimeoutResumeCandidates requires nowMs');
  const retriedJobIds = new Set(entries.filter(e => e.event === ledger.JOB_EVENTS.RETRIED).map(e => e.jobId));
  const retriesByTask = new Map();
  for (const e of entries) {
    if (e.event !== ledger.JOB_EVENTS.RETRIED) continue;
    const id = String(e.taskId);
    retriesByTask.set(id, (retriesByTask.get(id) || 0) + 1);
  }
  const out = [];
  for (const job of ledger.foldJobs(entries).values()) {
    if (job.event !== ledger.JOB_EVENTS.FAILED || job.stage !== 'timeout') continue;
    if (!job.sessionId || !job.cwd) continue; // pre-#1184 entries: unresumable
    if (retriedJobIds.has(job.jobId)) continue;
    if ((retriesByTask.get(String(job.taskId)) || 0) >= maxResumePerTask) continue;
    const ts = Date.parse(job.ts || '');
    if (!Number.isFinite(ts) || nowMs - ts > lookbackMs) continue;
    out.push(job);
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// Detached on purpose — a resume runs on the full job budget (2h), and this
// tick fires every 5 min under launchd, which skips overlapping runs: an
// inline await here would silently disable orphan detection for the duration
// (same reasoning as digest-autofix.js's dispatchDetached). The resume child
// re-acquires the task lease itself (runJob), so a duplicate spawn against a
// task whose resume is already running is refused at the lease, not here.
function spawnDetachedResume(job) {
  const { LOG_ROOT } = require('./lib/bsc-runner.js');
  const logPath = path.join(LOG_ROOT, `resume-${job.taskId}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const args = [path.join(REPO, 'scripts', 'resume-headless-job.js'),
    '--task', String(job.taskId), '--session', String(job.sessionId), '--cwd', String(job.cwd)];
  if (job.model) args.push('--model', String(job.model));
  const child = require('child_process').spawn('node', args,
    { cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  return logPath;
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
    // BRO-2575 test seam — the OS-process third signal. Same default and same
    // lazy `ps` sampling as bsc-prune's.
    makeWrapperAliveProbe: makeWrapperAliveProbeFn = makeSeedProcessProbe,
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

  // BRO-2575: checkLiveness's two signals are both cmux reads over one socket,
  // so a daemon blackout reports the whole fleet dead — and THIS reconciler
  // responds by re-dispatching with --force, which is a duplicate worker on
  // live work, not just a bogus ledger row. The wake+recheck below only asks
  // cmux again, so it cannot see through a blackout either. Drop any candidate
  // whose launch wrapper is still in the OS process table — the one signal not
  // read through cmux. Same fail directions as bsc-prune: no marker (a launch
  // predating this field) or an unbuildable probe leaves the verdict exactly as
  // it was. See dispatch-ledger.deadBreadcrumbs' header for the mechanism.
  let isWrapperAlive = null;
  try { isWrapperAlive = makeWrapperAliveProbeFn(); }
  catch (e) { reportFn({ kind: 'task-sweep-error', taskId: 'sweep', detail: `wrapper-process probe unavailable (${e.message}) — cmux-only liveness this tick` }); }
  const confirmedDead = candidates.filter(({ task, launch }) => {
    if (!ledger.wrapperVouchesAlive(launch, isWrapperAlive)) return true;
    reportFn({
      kind: 'task-session-wrapper-alive', taskId: task.id,
      detail: `cmux reported ${launch.workspaceRef} dead but its launch wrapper ${launch.marker} is still running — NOT re-dispatching in_progress task #${task.id} "${task.subject}"`,
    });
    return false;
  });
  if (!confirmedDead.length) return { checked: tasks.length, dead: [], redispatched: [] };

  // Wake cmux once before trusting a "dead" verdict (#849 lazy-exec fix): a
  // backgrounded app can leave an EXISTING tab's surface dormant the same
  // way it defers a brand-new launch's typed command. Re-list and re-check
  // after a short nudge before concluding the session is actually gone.
  wakeFn();
  sleepFn(3000);
  try { workspaces = listWorkspacesFn(); byRef = new Map(workspaces.map(w => [w.ref, w])); }
  catch { /* keep the pre-wake snapshot — a failed re-list must not block the sweep */ }
  clearWakeFn();

  const dead = confirmedDead.filter(({ launch }) => {
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
    {
      // Card #1233: count only SUBSTANTIVE deaths toward the recurrence cap
      // — a task whose only failures are cmux's terminal surface never
      // rendering isn't the thing that needs investigating.
      const cap = ledger.dispatchCapDecision(task.id, entries);
      if (cap.blocked) {
        const detail = cap.reason === 'infra'
          ? `#${task.id}'s cmux launch has failed to start ${cap.infra.length}x in a row (cmux itself looks wedged) — needs investigation or --force, not another automatic retry`
          : `#${task.id} has already died ${cap.substantive.length}x — needs investigation or --force, not another automatic retry`;
        reportFn({ kind: 'task-redispatch-blocked', taskId: task.id, detail });
        continue;
      }
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
    {
      // Card #1233: same substantive-only cap as the redispatch guard above.
      const cap = ledger.dispatchCapDecision(id, entries);
      if (cap.blocked) {
        // Marker stamped: this verdict is stable, so surface it once per
        // stall, not every 5-minute tick.
        appendLedgerFn({ event: STALL_EVENT, taskId: id });
        const detail = cap.reason === 'infra'
          ? `#${id}'s cmux launch has failed to start ${cap.infra.length}x in a row (cmux itself looks wedged) — needs a human look, not another automatic retry`
          : `#${id} already died ${cap.substantive.length}+ times — needs a human look, not another automatic retry`;
        reportFn({ kind: 'task-stall-blocked', taskId: id, detail });
        continue;
      }
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

// ── Untracked in_progress zombie sweep (task #1184 S2) ──────────────────────
// reconcileStalledTasks above deliberately skips in_progress tasks with NO
// ledger history ("a hand-claimed interactive session is invisible to us and
// not ours to declare dead"). That left a permanent blind spot the health
// check reports daily as "Stuck work: orphaned in-progress cards" (72 on
// 2026-08-09): a card claimed by an interactive session whose tab is long
// gone stays in_progress forever — and digest-autofix's planAutofix reads
// its health row as "being fixed right now" and never dispatches a fix.
// This sweep owns exactly that complementary shape. It does NOT dispatch:
// it flips the task back to pending (every bsc-next guard still decides
// dispatchability later), corrects the mirrored Notion card, and leaves a
// note the next owner/session sees. Guards, in order, are in the loop below.
const UNTRACKED_SWEEP_STATE_PATH = path.join(REPO, 'data', 'audit', 'untracked-sweep-state.json');
const UNTRACKED_SWEEP_INTERVAL_MS = 6 * 3600 * 1000;   // Notion fetches cost quota — no need for 5-min cadence on 48h-stale cards
const UNTRACKED_IDLE_MS = 48 * 3600 * 1000;            // same bar as the health check's "orphaned in-progress" row
const MAX_UNTRACKED_FLIPS_PER_SWEEP = 10;              // 72-at-once reads as a board wipe (plan-review user-impact finding)
const UNTRACKED_MARKER = '[zombie-sweep ';
// Distinct from UNTRACKED_MARKER (task #1272, ship-check Codex finding): the
// outcome-park branch below never flips local status, so without its own
// idempotency stamp the sweep would re-fetch, re-park, and re-report the
// SAME card every idle window forever — an ever-growing Outcome history and
// a recurring digest nag, not a one-time correction.
const OUTCOME_PARK_MARKER = '[outcome-park ';

// Ship-check finding (task #1796, gpt-5.4-mini): stripOwnParkNote() used to
// hardcode this prefix/signature as a second literal copy of the note text
// built at the correctCardFn call site below — a future prose edit to one
// without the other would silently break idempotency detection. One shared
// pair, used at both sites, makes that structurally impossible.
const AUTO_PARK_NOTE_PREFIX = 'Auto-parked ';
const AUTO_PARK_NOTE_SIGNATURE = 'by bsc-reconcile zombie sweep:';

// Card #1796: strips exactly one leading auto-park note from a Notion
// outcome string, if present, to recover the "core" (human-authored)
// content for idempotency hashing. Mirrors notion-brain.js's own prepend
// separator (`outcomeText + '\n\n---\n\n' + existingOutcome`,
// scripts/notion-brain.js:957-983) rather than guessing a format — only the
// FIRST segment is ever checked/stripped, since a correctly-idempotent sweep
// never lets its own note stack twice on the same underlying content (see
// the park branch's coreOutcomeHash guard).
function stripOwnParkNote(outcome) {
  let s = String(outcome || '');
  // Ship-check finding (task #1796): notion-brain.js's --outcome writer runs
  // hoistRecheckAfterStamp() on the FULL combined text after prepending our
  // note (scripts/notion-brain.js:972,979) — if the existing outcome
  // mentions RECHECK-AFTER anywhere, that hoist pushes a canonical
  // `RECHECK-AFTER: <date>\n\n` stamp in front of EVERYTHING, including our
  // own note, breaking the "our note is always the literal head" assumption
  // below. Strip that optional leading stamp first so it can't mask our own
  // note (and, symmetrically, so a genuinely new dispute hiding under a
  // stamp isn't mistaken for our own note either).
  const stampMatch = new RegExp(`^${RECHECK_AFTER_RE.source}\\n\\n`, 'i').exec(s);
  if (stampMatch) s = s.slice(stampMatch[0].length);
  const sep = '\n\n---\n\n';
  const idx = s.indexOf(sep);
  if (idx === -1) return s;
  const head = s.slice(0, idx);
  if (head.startsWith(AUTO_PARK_NOTE_PREFIX) && head.includes(AUTO_PARK_NOTE_SIGNATURE)) {
    return s.slice(idx + sep.length);
  }
  return s;
}

function notionIdOfTask(task) {
  if (task && task.metadata && task.metadata.notionCard) return String(task.metadata.notionCard);
  const m = /\[notion:([0-9a-f-]{16,})\]/i.exec(String((task && task.description) || ''));
  return m ? m[1] : null;
}

function sweepUntrackedInProgress({ dryRun = false, deps = {} } = {}) {
  const {
    loadTasksFn = bscNext.loadTasks,
    tasksDir = bscNext.TASKS_DIR,
    readLedgerEntriesFn = ledger.readEntries,
    listWorkspacesFn = cmuxws.listWorkspaces,
    readLeaseFn = readLease,
    fetchCardFn = (notionId) => {
      const r = spawnSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', notionId], { encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) return null;
      try { return JSON.parse(r.stdout); } catch { return null; }
    },
    flipFn = (task, note, eventTs = null) => {
      const file = path.join(tasksDir, `${task.id}.json`);
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Check-then-act guard (ship-check Codex finding): a session can claim
      // or complete this task between the sweep's snapshot and this write —
      // the re-read is the last word, never the stale snapshot.
      if (t.status !== 'in_progress') return;
      t.status = 'pending';
      t.owner = null;
      t.lastSweptForEventTs = eventTs; // card #1796: keys idempotency to THIS event, not marker presence
      t.description = note + (t.description || '');
      fs.writeFileSync(file, JSON.stringify(t, null, 2));
    },
    // Stamps OUTCOME_PARK_MARKER without touching status/owner — the park
    // only ever changes the NOTION side, so this exists purely to make the
    // sweep idempotent (same check-then-act shape as flipFn above).
    markOutcomeParkedFn = (task, note, outcomeHash = null) => {
      const file = path.join(tasksDir, `${task.id}.json`);
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (t.status !== 'in_progress') return;
      t.lastParkedOutcomeHash = outcomeHash; // card #1796: keys idempotency to THIS outcome's content, not marker presence
      t.description = note + (t.description || '');
      fs.writeFileSync(file, JSON.stringify(t, null, 2));
    },
    correctCardFn = (notionId, note, status = 'Not started') => {
      const r = spawnSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'update', notionId,
        '--status', status, '--outcome', note], { encoding: 'utf8', timeout: 60_000 });
      return r.status === 0;
    },
    reportFn = report,
    nowFn = Date.now,
    statePath = UNTRACKED_SWEEP_STATE_PATH,
  } = deps;

  // Cadence gate: at most one sweep per interval (state survives dry-runs
  // being skipped — dry-run never stamps).
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  if (state && Number.isFinite(Date.parse(state.lastRunTs)) && nowFn() - Date.parse(state.lastRunTs) < UNTRACKED_SWEEP_INTERVAL_MS) {
    return { ran: false, checked: 0, flipped: [], skipped: [] };
  }

  const tasks = loadTasksFn(tasksDir).filter(t => t.status === 'in_progress');
  const entries = readLedgerEntriesFn();
  const trackedIds = new Set(entries.filter(e => e.taskId != null).map(e => String(e.taskId)));
  let workspaces = [];
  try { workspaces = listWorkspacesFn() || []; } catch { /* cmux down — title guard degrades to skip-none */ }

  const flipped = [];
  const skipped = [];
  let checked = 0;
  for (const task of tasks) {
    if (flipped.length >= MAX_UNTRACKED_FLIPS_PER_SWEEP) break;
    const id = String(task.id);
    if (trackedIds.has(id)) continue;                       // ledger-tracked — the other sweeps own it
    if (task.metadata && task.metadata.recheckAfter) continue; // RECHECK-AFTER parked by process rule, not stuck
    // Card #1796 (the #1795 class): a bare marker-substring check can't tell
    // "this SAME zombie-sweep/outcome-park event already handled this task"
    // from "a task handled once for an EARLIER event has genuinely hit the
    // same condition again and needs handling a second time" — flipFn/
    // markOutcomeParkedFn PREPEND their note and never clear it, so the old
    // any-marker check blocked every future event forever once stamped once.
    // Fix (same shape as #1795's lastReopenedForEventTs, adapted since these
    // tasks are by definition ledger-less): key idempotency to a structured
    // field per branch, each comparable across occurrences without needing
    // to re-derive history from ever-growing prose:
    //   - lastSweptForEventTs (flip branch) = the Notion card's own
    //     lastEditedAt at detection time. Safe here specifically because a
    //     flip sets local status to 'pending' (line below), which drops the
    //     task out of the in_progress candidate pool at the top of this
    //     function — this sweep never re-evaluates it until something
    //     external reclaims it back to in_progress, at which point being a
    //     candidate again is itself evidence of a new occurrence.
    //   - lastParkedOutcomeHash (park branch) = a hash of the human-authored
    //     "core" outcome content (our own prior park note stripped first —
    //     see stripOwnParkNote above and the park branch below). The park
    //     branch deliberately never flips local status (comment above), so
    //     it stays a candidate on every future sweep tick forever —
    //     lastEditedAt would self-invalidate here (our own correction write
    //     moves it past whatever we stamped), so identity has to be keyed on
    //     content we control, not on Notion's own edit-tracking metadata.
    // A task carrying the OLD marker text but neither structured field yet
    // (pre-fix data) falls back to the original any-marker skip below —
    // conservative, matches pre-fix behavior, and avoids spending a Notion
    // fetch a legacy task can't be compared against anyway.
    const hasSweptField = Object.prototype.hasOwnProperty.call(task, 'lastSweptForEventTs');
    const hasParkedField = Object.prototype.hasOwnProperty.call(task, 'lastParkedOutcomeHash');
    if (!hasSweptField && String(task.description || '').includes(UNTRACKED_MARKER)) continue;
    if (!hasParkedField && String(task.description || '').includes(OUTCOME_PARK_MARKER)) continue;
    const lease = readLeaseFn(id);
    if (lease && pidLooksLikeClaude(lease.pid)) { skipped.push({ id, why: 'live-lease' }); continue; }
    const liveTab = workspaces.find(w => ledger.titleMatchesSubject(w.title, task.subject));
    if (liveTab) { skipped.push({ id, why: `live-tab ${liveTab.ref}` }); continue; }
    const notionId = notionIdOfTask(task);
    if (!notionId) { skipped.push({ id, why: 'no-notion-id' }); continue; } // no timestamp source — too blind to flip
    checked++;
    const card = fetchCardFn(notionId);
    if (!card || !card.lastEditedAt) { skipped.push({ id, why: 'card-fetch-failed' }); continue; }
    const idleMs = nowFn() - Date.parse(card.lastEditedAt);
    if (!Number.isFinite(idleMs) || idleMs < UNTRACKED_IDLE_MS) continue;   // recently touched — someone may be on it

    const days = Math.round(idleMs / 86400e3);

    // Outcome already filled (task #1272, the #383 class): this card records
    // COMPLETED work, so flipping it to Not started makes it re-eligible for
    // dispatch and just redoes finished work (card #383: reopened by this
    // exact branch on 2026-07-24, redispatched 2026-08-11). Park it in
    // Notion instead (status Paused, same convention as bsc-prune's
    // tab-close park) for a human yes/no. The LOCAL task is deliberately
    // left in_progress — it keeps surfacing in the daily "stuck work:
    // orphaned in-progress cards" digest row (#801) instead of silently
    // re-entering the auto-dispatch pool; bsc-next.js's staleOutcomeGuard is
    // the actual dispatch-time backstop regardless of local status.
    if (String(card.outcome || '').trim()) {
      // Card #1796: identity for THIS branch can't be card.lastEditedAt —
      // this branch deliberately never flips local status (comment above),
      // so the task stays a sweep candidate on every future tick forever,
      // and correctCardFn's OWN write below would move lastEditedAt past
      // whatever we stamped, self-invalidating the guard into an infinite
      // re-park loop (the exact failure OUTCOME_PARK_MARKER was built to
      // stop). Instead, key off the CONTENT of the human-authored outcome,
      // with our own prior park note (if any) stripped first so our own
      // write never looks like "new" content: notion-brain.js's --outcome
      // update always prepends as `note + '\n\n---\n\n' + existingOutcome`
      // (scripts/notion-brain.js:957-983) — a fixed, date-independent
      // separator — so stripping one leading `Auto-parked ... by
      // bsc-reconcile zombie sweep:` note (if present) reliably recovers
      // the same "core" text across repeated no-op runs of the SAME event,
      // while any genuinely new content prepended by a human (or a second
      // real dispute) changes the hash and correctly re-fires.
      const coreOutcome = stripOwnParkNote(card.outcome);
      const coreOutcomeHash = crypto.createHash('sha256').update(coreOutcome).digest('hex');
      if (hasParkedField && task.lastParkedOutcomeHash === coreOutcomeHash) {
        skipped.push({ id, why: 'already-parked-this-outcome' });
        continue;
      }
      skipped.push({ id, why: 'has-completed-outcome' });
      reportFn({ kind: 'zombie-outcome-needs-review', taskId: id, detail: `in_progress task #${id} "${task.subject}" sat In progress ${days}d with no live session, but its Notion card already has a filled Outcome — parking for human review instead of auto-reopening (task #1272, the #383 class).` });
      if (dryRun) continue;
      let parked = false;
      try {
        parked = correctCardFn(notionId, `${AUTO_PARK_NOTE_PREFIX}${new Date().toISOString().slice(0, 10)} ${AUTO_PARK_NOTE_SIGNATURE} card sat In progress ${days}d with no live session, but already has a completed Outcome — needs a human yes/no, not an automatic reopen (task #1272). Resume dispatch with \`node scripts/bsc-next.js --id ${id} --force\` once reviewed.`, 'Paused');
      } catch (e) {
        reportFn({ kind: 'zombie-outcome-park-failed', taskId: id, detail: `card correction threw for #${id}: ${e.message}` });
        continue;
      }
      // ship-check Codex finding: correctCardFn returning false (a failed
      // Notion write) was previously indistinguishable from success — the
      // digest said "parked" while the card stayed In progress. Only stamp
      // the local idempotency marker on a CONFIRMED write, so a failed park
      // is retried on the next sweep instead of being silently abandoned.
      if (!parked) {
        reportFn({ kind: 'zombie-outcome-park-failed', taskId: id, detail: `Notion update to Paused failed for #${id} — card status unchanged, will retry next sweep` });
        continue;
      }
      const parkNote = `${OUTCOME_PARK_MARKER}${new Date().toISOString().slice(0, 10)}] parked — Notion card set to Paused, needs a human yes/no on the recorded Outcome (task #1272).\n\n`;
      try { markOutcomeParkedFn(task, parkNote, coreOutcomeHash); } catch (e) { reportFn({ kind: 'zombie-outcome-park-marker-failed', taskId: id, detail: `local marker write failed: ${e.message}` }); }
      continue;
    }

    // Card #1796: the flip branch DOES exit the candidate pool (status →
    // 'pending' below), so card.lastEditedAt is a safe identity here — no
    // self-invalidation risk, since this task won't be re-evaluated by this
    // sweep until something external reclaims it back to in_progress, at
    // which point being a candidate again already signals a new occurrence.
    if (hasSweptField && task.lastSweptForEventTs === card.lastEditedAt) {
      skipped.push({ id, why: 'already-swept-this-event' });
      continue;
    }
    reportFn({ kind: 'zombie-flip', taskId: id, detail: `in_progress task #${id} "${task.subject}" — no ledger history, no live lease/tab, card idle ${days}d → flipped back to pending` });
    if (dryRun) { flipped.push(id); continue; }
    const note = `${UNTRACKED_MARKER}${new Date().toISOString().slice(0, 10)}] reopened — sat In progress ${days}d with no live session, workspace, or dispatch record (owning session likely died; task #1184 S2). Re-eligible for dispatch.\n\n`;
    try { flipFn(task, note, card.lastEditedAt); } catch (e) { reportFn({ kind: 'zombie-flip-failed', taskId: id, detail: `local flip failed: ${e.message}` }); continue; }
    flipped.push(id);
    try {
      if (card.status === 'In progress') correctCardFn(notionId, `Auto-corrected ${new Date().toISOString().slice(0, 10)} by bsc-reconcile zombie sweep: card sat In progress ${days}d with no live session (task #1184 S2) — back to Not started, re-eligible for dispatch.`);
    } catch { /* card correction is best-effort; local flip is authoritative */ }
  }

  if (!dryRun) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ lastRunTs: new Date(nowFn()).toISOString(), flipped, skipped: skipped.length }, null, 2));
    } catch { /* state write must never fail the sweep */ }
  }
  return { ran: true, checked, flipped, skipped };
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

// Card #1009: is any in-flight session executing a card that has since been
// CORRECTED? bsc-next seeds the card once, at launch; an edit afterwards
// changes Notion and nothing else, so the session keeps working the original
// text while everyone reading the card believes otherwise (task #1002,
// 2026-08-04 — caught only because a human happened to run `cmux send`).
//
// Rides this tick rather than its own launchd job (the ledger, cmux and the
// Notion CLI all live here already), but throttled to DRIFT_PASS_INTERVAL_MS:
// each pass costs one Notion read per in-flight session and the tick fires
// every 5 min. Deliveries are hash-proven drift only, capped per tick — see
// selectDriftDeliveries. Weak (timestamp-only) drift is reported, never typed
// into a live session.
function reconcileCardDrift({ dryRun = false, deps = {} } = {}) {
  const {
    readLedgerEntriesFn = ledger.readEntries,
    readReportFn = readReportEntries,
    fetchCardFn = fetchCardForDrift,
    amendFn = amendViaBscNext,
    reportFn = report,
    now = Date.now(),
  } = deps;

  if (!cardDrift.shouldRunDriftPass(readReportFn(), { now })) return { skipped: true, checked: 0, drifted: [], delivered: [] };

  const entries = readLedgerEntriesFn();
  // 24h, not the lib's 3-day default: a correction that reaches a day-old
  // session is still useful; one that reaches a 3-day-old zombie is not worth
  // a Notion read every half hour, forever.
  const launches = cardDrift.inFlightLaunches(entries, { now, maxAgeMs: 24 * 3600 * 1000 });

  // Stamp the pass BEFORE the (slow, Notion-costing) fetch loop, not after
  // (ship-check P1, GPT pass): a manual run overlapping the launchd tick would
  // otherwise both read "window open", both fetch, and both deliver the same
  // correction twice. Stamping first makes the loser of that race a no-op.
  // The cost of stamping early is one skipped pass if this run then crashes —
  // 30 minutes of delay on a correction, versus double-typing into a live
  // session.
  reportFn({ kind: cardDrift.DRIFT_PASS_EVENT, taskId: 'sweep', detail: `starting drift pass over ${launches.length} in-flight session(s)` });

  const cards = {};
  for (const l of launches) {
    if (l.notionId) cards[String(l.taskId)] = fetchCardFn(l.notionId);
  }
  const rows = launches.map(launch =>
    cardDrift.detectDrift({ launch, card: cards[String(launch.taskId)] || null, amendments: entries })
  );
  const { deliver, deferred, reportOnly } = cardDrift.selectDriftDeliveries(rows);
  reportFn({ kind: 'card-drift-summary', taskId: 'sweep', detail: `checked ${rows.length} in-flight session(s): ${deliver.length + deferred.length} proven drift, ${reportOnly.length} suspected` });

  for (const r of reportOnly) {
    reportFn({ kind: 'card-drift-suspected', taskId: String(r.taskId), detail: `${r.workspaceRef}: ${r.reason} — not auto-delivered (timestamp-only signal); check with: node scripts/bsc-next.js --id ${r.taskId} --amend` });
  }
  for (const r of deferred) {
    reportFn({ kind: 'card-drift-throttled', taskId: String(r.taskId), detail: `${r.workspaceRef} deferred — this tick's delivery budget (${cardDrift.MAX_DELIVERIES_PER_TICK}) is spent; will retry next pass` });
  }

  const delivered = [];
  for (const r of deliver) {
    if (dryRun) { reportFn({ kind: 'card-drift-would-deliver', taskId: String(r.taskId), detail: `${r.workspaceRef}: ${r.reason}` }); continue; }
    const res = amendFn(r.taskId);
    reportFn({
      kind: res.ok ? 'card-drift-delivered' : 'card-drift-delivery-failed',
      taskId: String(r.taskId),
      detail: res.ok
        ? `re-delivered the corrected card into ${r.workspaceRef} (${r.dispatchHash} → ${r.currentHash})`
        : `could NOT reach ${r.workspaceRef} — it is still running the ORIGINAL instructions: ${res.detail}`,
    });
    if (res.ok) delivered.push(String(r.taskId));
  }

  return { skipped: false, checked: rows.length, drifted: [...deliver, ...deferred, ...reportOnly], delivered };
}

function readReportEntries(reportPath = REPORT_PATH) {
  let raw;
  try { raw = fs.readFileSync(reportPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function fetchCardForDrift(pageId) {
  try {
    const raw = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', pageId],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch { return null; }
}

function amendViaBscNext(taskId) {
  try {
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId), '--amend'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, detail: String(out).trim().split('\n')[0] || '' };
  } catch (e) {
    return { ok: false, detail: `${e.stderr || e.stdout || e.message}`.trim().split('\n')[0] };
  }
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
        // Short leash: a retry blocking this tick for the full job default
        // would stall orphan detection (launchd skips overlapping runs).
        timeoutMs: 10 * 60 * 1000,
      });
    }
  }

  // Timed-out job resume (task #1184 S1) — same env gate and 24h retry budget
  // as the orphan path above, but spawned DETACHED (a resume runs on the full
  // 2h job budget; awaiting it here would block this 5-min tick for hours).
  if (process.env.BSC_RECONCILE_RETRY === '1' && !DRY) {
    const entriesNow = ledger.readEntries();
    const dayCount = retriesInLast24h(entriesNow);
    let budget = Math.min(MAX_RETRIES_PER_TICK, MAX_RETRIES_PER_DAY - dayCount);
    for (const job of collectTimeoutResumeCandidates(entriesNow, { nowMs: Date.now() })) {
      if (budget <= 0) break;
      if (!fs.existsSync(job.cwd)) continue; // worktree already GC'd — unresumable
      const lease = readLease(job.taskId);
      if (lease && pidLooksLikeClaude(lease.pid)) continue; // something live holds this task
      budget--;
      // RETRIED before spawn (terminal for the old jobId) — the same
      // ordering rule every two-write path in dispatch-ledger.js follows: a
      // concurrent sweep between the append and the spawn must see the old
      // job as reconciled, never as a fresh orphan.
      ledger.appendEntry({ event: ledger.JOB_EVENTS.RETRIED, taskId: job.taskId, jobId: job.jobId, sessionId: job.sessionId });
      const logPath = spawnDetachedResume(job);
      report({ kind: 'timeout-resume', taskId: job.taskId, jobId: job.jobId, detail: `resuming timed-out session ${job.sessionId} for task #${job.taskId} in ${job.cwd} (detached; log: ${logPath})` });
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

  // Task #1184 S2: untracked-zombie sweep, same best-effort isolation — a
  // crash here must never take down the stalled-task sweep below (or vice
  // versa), so each gets its own try.
  try {
    const zombieSweep = sweepUntrackedInProgress({ dryRun: DRY });
    if (zombieSweep.ran) console.log(`[bsc-reconcile] zombies checked=${zombieSweep.checked} flipped=${zombieSweep.flipped.length} skipped=${zombieSweep.skipped.length}${DRY ? ' (dry-run)' : ''}`);
  } catch (e) {
    console.error(`[bsc-reconcile] zombie sweep crashed (non-fatal): ${e.message}`);
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

  // Card #1009: instruction-drift pass, same best-effort isolation (throttled
  // internally to every DRIFT_PASS_INTERVAL_MS).
  try {
    const driftSweep = reconcileCardDrift({ dryRun: DRY });
    if (!driftSweep.skipped) {
      console.log(`[bsc-reconcile] card-drift checked=${driftSweep.checked} drifted=${driftSweep.drifted.length} delivered=${driftSweep.delivered.length}${DRY ? ' (dry-run)' : ''}`);
    }
  } catch (e) {
    console.error(`[bsc-reconcile] card-drift sweep crashed (non-fatal): ${e.message}`);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('bsc-reconcile crashed:', err); process.exit(1); });
}

module.exports = { main, retriesInLast24h, reconcileTaskSessions, reconcileStalledTasks, reconcileFlaglessSessions, reconcileCardDrift, redispatchArgv, stallRedispatchArgv, STALL_EVENT, STALL_COOLDOWN_MS, MAX_STALL_ATTEMPTS_PER_TASK, USAGE, REPORT_PATH, MAX_RETRIES_PER_TICK, MAX_RETRIES_PER_DAY, MAX_REDISPATCH_PER_TICK, MAX_REVIVE_PER_TICK, collectTimeoutResumeCandidates, MAX_RESUME_PER_TASK, RESUME_LOOKBACK_MS, sweepUntrackedInProgress, UNTRACKED_SWEEP_STATE_PATH, stripOwnParkNote, UNTRACKED_MARKER, OUTCOME_PARK_MARKER };
