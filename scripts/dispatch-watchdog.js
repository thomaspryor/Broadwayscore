#!/usr/bin/env node
/**
 * dispatch-watchdog.js — the durable owner of dispatched-work outcomes
 * (owner escalation 2026-08-06; plan-reviewed same day, verdict in
 * .claude/review-verdicts.jsonl).
 *
 * The crowned "👑 OWNER watchdog" cmux tab runs `--dashboard`: a plain node
 * loop (NOT a Claude session — sessions run out of context and rot; four
 * appointed supervisor sessions did exactly that) that sweeps the dispatch
 * ledger, re-dispatches ledger-confirmed-dead work through bsc-next's own
 * guarded machinery, parks retries-exhausted cards for the owner, dispatches
 * undispatched P0/P1 cards (standing owner rule 2026-07-24), and keeps its
 * tab title honest: "👑 OWNER watchdog — N in flight · M need you · upd HH:MM".
 *
 * Decisions live in scripts/lib/dispatch-watchdog-core.js (pure, tested).
 * Death facts come ONLY from the ledger (bsc-prune writes them); verifyCmd
 * re-runs come ONLY from the nightly acceptance recheck (surfaced here).
 *
 * Modes:
 *   --sweep [--dry-run]   one pass (classify → act). Dry-run prints the plan,
 *                         takes no action, writes NO heartbeat (a test run
 *                         must not satisfy the exit-status gate).
 *   --dashboard           the crowned tab's loop: sweep + narrate every 90s.
 *   --ensure-tab          create/adopt/resurrect the crowned tab. Fast no-op
 *                         when healthy — safe to call from a Stop hook.
 *   --health              launchd-side check (runs OUTSIDE cmux): if the
 *                         heartbeat is stale, page the owner via the alert
 *                         router (it cannot call cmux — socket ACL — but it
 *                         can always email) and best-effort try --ensure-tab.
 *   --status [--json]     print the current plan without acting.
 *
 * Kill switches (checked as FILES so hooks and this CLI agree without
 * sharing an environment):
 *   ~/.claude/state/dispatch-watchdog-off          everything off; the
 *                                                  exit-status gate's Gate O
 *                                                  also fails open on this
 *   ~/.claude/state/dispatch-watchdog-no-dispatch  visibility only
 *   DISPATCH_WATCHDOG_DISABLED=1                   same as -off, env form
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const core = require('./lib/dispatch-watchdog-core.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { findUnlandedJobDoneEntries } = require('./lib/headless-unlanded-detection.js');
const cmuxws = require('./lib/cmux-workspaces.js');
const { classifyCmuxError } = require('./lib/cmux-socket-auth.js');
const { hasAutoDispatchMarker } = require('./lib/prune-closeable.js');
const flowHealth = require('./lib/dispatch-flow-health.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

// Hardcoded canonical repo (same rationale as dispatch-ledger.js: this tool
// is routinely run from worktrees, and the ledger/dispatcher must be the one
// canonical copy, never a worktree-local fork).
const REPO = '/Users/tompryor/Broadwayscore';
const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const HEARTBEAT_PATH = path.join(STATE_DIR, 'dispatch-watchdog.json');
const TAB_STATE_PATH = path.join(STATE_DIR, 'dispatch-watchdog-tab.json');
const LOCK_DIR = path.join(STATE_DIR, 'dispatch-watchdog.lock');
const OFF_FILE = path.join(STATE_DIR, 'dispatch-watchdog-off');
const NO_DISPATCH_FILE = path.join(STATE_DIR, 'dispatch-watchdog-no-dispatch');
const RECHECK_LEDGER = path.join(REPO, 'data', 'audit', 'autonomous-recheck-ledger.jsonl');
// BRO-3924 (R3): BRO-3551's own report — same canonical-REPO reasoning as
// RECHECK_LEDGER above (this file runs from worktrees but always reads the
// canonical repo's audit data).
const OPEN_BACKLOG_SWEEP_REPORT_PATH = path.join(REPO, 'data', 'audit', 'open-backlog-acceptance-sweep.json');

const DASHBOARD_INTERVAL_MS = 90 * 1000;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;      // ensure-tab resurrection bar
const HEALTH_STALE_MS = 30 * 60 * 1000;         // launchd paging bar
const DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;     // bsc-next slow-boot worst case + margin
const RECHECK_WINDOW_MS = 48 * 3600 * 1000;
// BRO-3424: how far back findUnlandedJobDoneEntries re-checks job-done
// ancestry each sweep. Unbounded would re-walk every job-done the ledger has
// ever recorded (most worktrees long gone — a fast existsSync-false, but
// still O(all-time jobs) per 90s sweep). This is a visibility window only —
// this signal drives no auto-redispatch (see planSweep's own comment), so it
// has no REDISPATCH_REARM_MS-style self-heal to line up with. The real
// backstop for anything older is gc-merged-worktrees.sh's independent
// stale_unmerged digest (it reports, never deletes, an unmerged worktree); a
// week just keeps this sweep's own git-subprocess cost bounded.
const UNLANDED_CHECK_WINDOW_MS = 7 * 24 * 3600 * 1000;

const USAGE = `dispatch-watchdog.js — durable owner of dispatched-work outcomes

  --sweep [--dry-run]   one classify→act pass (dry-run: print plan only)
  --dashboard           crowned-tab loop (sweep + narrate every 90s)
  --ensure-tab          create/adopt/resurrect the 👑 OWNER watchdog tab
  --health              stale-heartbeat pager (for launchd, outside cmux)
  --status [--json]     print current classification without acting
`;

function watchdogOff() {
  return process.env.DISPATCH_WATCHDOG_DISABLED === '1' || fs.existsSync(OFF_FILE);
}
function dispatchEnabled() {
  return !fs.existsSync(NO_DISPATCH_FILE);
}

// ── atomic state ───────────────────────────────────────────────────────────

function writeHeartbeat(fields) {
  // tmp+rename: the exit-status gate and --health read this file — a torn
  // read must be impossible (plan-review consensus). Tmp name is pid-unique
  // (ship-check P1: a shared '.tmp' lets concurrent writers rename/unlink
  // each other's half-written file).
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${HEARTBEAT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...fields }, null, 2));
  fs.renameSync(tmp, HEARTBEAT_PATH);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function heartbeatAgeMs(now = Date.now()) {
  const hb = readJson(HEARTBEAT_PATH);
  if (!hb || !hb.ts) return null;
  const t = Date.parse(hb.ts);
  return Number.isFinite(t) ? now - t : null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// mkdir-based lock: atomic on POSIX, stale-broken by dead pid (plan-review
// P0: concurrent Stop hooks + the dashboard must not both create tabs or
// both spend the dispatch budget). Ship-check P0 hardening: mkdir succeeds
// BEFORE the pid file lands, so a concurrent reader can observe a pid-less
// live lock — a missing pid file is only stale when the lock DIR itself is
// old (>60s), never in the mkdir→write gap. After writing our pid we
// re-read it: if another breaker replaced the dir between our write and
// now, the read disagrees and we back off instead of both holding it.
function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pidFile = path.join(LOCK_DIR, 'pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(pidFile, String(process.pid));
      try {
        if (fs.readFileSync(pidFile, 'utf8').trim() !== String(process.pid)) return false;
      } catch { return false; }
      return true;
    } catch {
      let holderRaw = null;
      try { holderRaw = fs.readFileSync(pidFile, 'utf8'); } catch { holderRaw = null; }
      if (holderRaw !== null) {
        const holder = parseInt(holderRaw, 10);
        if (holder && pidAlive(holder)) return false;
      } else {
        // No pid file: either mid-acquisition (fresh dir — leave it alone)
        // or a crash in the gap (old dir — break it).
        let dirAgeMs = 0;
        try { dirAgeMs = Date.now() - fs.statSync(LOCK_DIR).mtimeMs; } catch { return false; }
        if (dirAgeMs < 60 * 1000) return false;
      }
      try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* raced another breaker */ }
    }
  }
  return false;
}
function releaseLock() {
  try {
    const holder = parseInt(String(fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8')), 10);
    if (holder === process.pid) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch { /* already gone */ }
}

// ── inputs ─────────────────────────────────────────────────────────────────

// Union live + archive/ (the #1075 lesson, via audit-dispatch-outcomes.js —
// reuse its exact loader, do not re-derive).
const { loadTasksUnioned } = require('./audit-dispatch-outcomes.js');

let ledgerCache = { mtimeMs: 0, size: 0, entries: [] };
function readLedgerCached() {
  try {
    const st = fs.statSync(dispatchLedger.LEDGER_PATH);
    if (st.mtimeMs === ledgerCache.mtimeMs && st.size === ledgerCache.size) return ledgerCache.entries;
    const entries = dispatchLedger.readEntries();
    ledgerCache = { mtimeMs: st.mtimeMs, size: st.size, entries };
    return entries;
  } catch {
    return dispatchLedger.readEntries();
  }
}

// null = cmux unobservable (missing binary, socket error, EMPTY listing —
// empty is indistinguishable from mid-restart; plan-review P0: never act on
// it). Map<ref,title> otherwise.
function liveTitleMap() {
  if (!cmuxws.cmuxAvailable()) return null;
  let list;
  try { list = cmuxws.listWorkspaces(); } catch { return null; }
  if (!Array.isArray(list) || list.length === 0) return null;
  const m = new Map();
  for (const w of list) m.set(w.ref, w.title);
  return m;
}

function recentRecheckFailures(now) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(RECHECK_LEDGER, 'utf8'); } catch { return out; }
  const latestByCard = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.event !== 'recheck' || !e.cardId) continue;
    latestByCard.set(e.cardId, e);
  }
  for (const e of latestByCard.values()) {
    if (e.status !== 'fail') continue;
    const ts = Date.parse(e.ts || '');
    if (!Number.isFinite(ts) || now - ts > RECHECK_WINDOW_MS) continue;
    out.push({ notionId: e.cardId, taskSubject: e.name || null, ts: e.ts });
  }
  return out;
}

// Codex adversarial review (BRO-3924): without an age check, a report that
// stops being regenerated (BRO-3551's own cron disabled, erroring, or just
// never scheduled) would suppress a card as "already-passes" FOREVER off one
// stale verdict — including past the point where main regresses and the
// card's acceptance command no longer actually passes. Same window
// RECHECK_WINDOW_MS already uses for recheckFailures below, so both
// consumers of "how stale is too stale for an acceptance verdict" agree.
const OPEN_BACKLOG_SWEEP_MAX_AGE_MS = RECHECK_WINDOW_MS;

// BRO-3924 (R3): the watchdog consumes BRO-3551's own report as an
// ineligible reason — it NEVER runs runVerify itself inside the 90s sweep.
// Fail-soft (same doctrine as recentRecheckFailures above): a missing or
// corrupt report degrades to "no already-passing cards known", never blocks
// a sweep.
function loadAlreadyPassesReport(now = Date.now(), reportPath = OPEN_BACKLOG_SWEEP_REPORT_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const generatedMs = Date.parse(raw.generatedAt || '');
    if (!Number.isFinite(generatedMs) || now - generatedMs > OPEN_BACKLOG_SWEEP_MAX_AGE_MS) {
      return { alreadyDone: [], checkoutSha: null };
    }
    const alreadyDone = Array.isArray(raw.alreadyDone) ? raw.alreadyDone : [];
    return { alreadyDone, checkoutSha: raw.checkoutSha || null };
  } catch {
    return { alreadyDone: [], checkoutSha: null };
  }
}

// ── Linear as a second task source (BRO-3390) ──────────────────────────────
//
// loadTasksUnioned() reads ONLY ~/.claude/tasks/<list>/<digits>.json — the
// Notion mirror, frozen at task id 1285 since 2026-08-20. Measured 2026-09-15:
// all 180 watchdog-redispatch rows since 2026-09-01 carry Notion ids and none
// carry a linear: id, while 684 armed Linear issues sat with no continuous
// drain at all. This is the seam that fixes that.
//
// The fetch is ASYNC but buildPlan() is SYNC and called from four places
// (sweepOnce, the dashboard loop, the flow-health check, --status), two of
// them inside sync contexts. Rather than ripple async through all four, the
// fetch refreshes a module-level cache and buildPlan reads it synchronously.
// Fail-safe in both directions: a Linear outage leaves the cache untouched and
// the Notion-sourced half of the sweep keeps working, and a cache older than
// LINEAR_CACHE_TTL_MS is dropped rather than dispatched from, so a long outage
// degrades to "no Linear work" instead of to stale work. A mildly stale entry
// is safe anyway — linear-next.js re-checks state at dispatch time and refuses
// anything that has since started or closed.
const LINEAR_CACHE_TTL_MS = 10 * 60 * 1000;
let linearTaskCache = { tasks: new Map(), started: new Map(), ts: 0, ok: false, reason: 'not-fetched', scanned: 0, alreadyPasses: [] };

async function refreshLinearTasks() {
  // BRO-3924 (R3): loaded independently of the Linear fetch below (it's a
  // local file, not a network call) so a Linear outage never hides an
  // already-known-passing card, and injected into fetchLinearWatchdogTasks
  // as opts.alreadyPassesIds — the pure source module never touches the
  // filesystem itself.
  const report = loadAlreadyPassesReport();
  const alreadyPassesIds = new Set(report.alreadyDone.map(r => r.id));
  try {
    const source = require('./lib/linear-watchdog-source.js');
    const client = require('./lib/linear-client.js');
    const res = await source.fetchLinearWatchdogTasks(client, { alreadyPassesIds });
    if (res.ok) {
      linearTaskCache = {
        tasks: res.tasks, started: res.started || new Map(),
        ts: Date.now(), ok: true, reason: null, scanned: res.scanned,
        alreadyPasses: report.alreadyDone,
      };
    } else {
      // Keep the previous cache (if still fresh) rather than blanking the
      // queue on one bad fetch; record why for the narrative.
      linearTaskCache = { ...linearTaskCache, ok: false, reason: res.reason, alreadyPasses: report.alreadyDone };
      console.error(`[watchdog] Linear source unavailable (${res.reason}) — Notion-sourced sweep continues`);
    }
  } catch (e) {
    linearTaskCache = { ...linearTaskCache, ok: false, reason: `linear-source-error: ${e.message}`, alreadyPasses: report.alreadyDone };
    console.error(`[watchdog] Linear source error (${e.message}) — Notion-sourced sweep continues`);
  }
  return linearTaskCache;
}

// BRO-3390: the write-back leak, computed from the SAME scan the queue came
// from (no extra API call). Surfaced rather than acted on: moving someone
// else's card is not this process's job, and BRO-3376 owns triaging the
// existing pile. What this ends is the SILENCE.
function linearWriteBackLeak(now = Date.now()) {
  try {
    if (!linearTaskCache.ts || now - linearTaskCache.ts > LINEAR_CACHE_TTL_MS) return [];
    const source = require('./lib/linear-watchdog-source.js');
    return source.detectWriteBackLeak(readLedgerCached(), linearTaskCache.started, now);
  } catch { return []; }
}

function linearTasksForPlan(now = Date.now()) {
  if (!linearTaskCache.ts) return new Map();
  if (now - linearTaskCache.ts > LINEAR_CACHE_TTL_MS) return new Map();
  return linearTaskCache.tasks;
}

// BRO-3924 (R3): same staleness rule as linearTasksForPlan — a long Linear
// outage degrades to "no already-passing cards known" rather than narrating
// stale ones.
function linearAlreadyPassesForPlan(now = Date.now()) {
  if (!linearTaskCache.ts) return [];
  if (now - linearTaskCache.ts > LINEAR_CACHE_TTL_MS) return [];
  return linearTaskCache.alreadyPasses || [];
}

// BRO-3424 (ship-check catch, Codex): fetchLinearWatchdogTasks() deliberately
// keeps 'started' (In Progress / In Review) issues OUT of linearTaskCache.tasks
// — isWatchdogEligible() excludes them so they're never re-queued — but that
// means a started Linear card has NO entry at all in the `tasks` map planSweep
// reads. unlandedDone's gate is `isTaskOpen(tasks.get(id))`, so for exactly
// the case this whole card exists to catch (a headless job whose Linear card
// is still "In Progress" because the worker never merged and reported Done),
// tasks.get(id) was undefined and the finding was silently dropped — the
// PRIMARY real-world case (BRO-3388 in the card's own incident writeup) would
// never have surfaced. Mapped with status 'in_progress' (isTaskOpen's other
// accepted value) so unlandedDone sees it as open; p01Queue is unaffected
// (it only re-queues status 'pending').
function linearStartedTasksForPlan(now = Date.now()) {
  if (!linearTaskCache.ts || now - linearTaskCache.ts > LINEAR_CACHE_TTL_MS) return new Map();
  const source = require('./lib/linear-watchdog-source.js');
  const out = new Map();
  for (const [id, meta] of linearTaskCache.started || new Map()) {
    const task = source.mapStartedToTask(id, meta);
    if (task) out.set(id, task);
  }
  return out;
}

function buildPlan(now) {
  const entries = readLedgerCached();
  const tasks = loadTasksUnioned();
  // Union, never mutate the loader's own map semantics: Linear ids are
  // "linear:BRO-N" and Notion ids are bare digits, so the two namespaces
  // cannot collide and neither can shadow the other.
  for (const [id, task] of linearStartedTasksForPlan(now)) tasks.set(id, task);
  for (const [id, task] of linearTasksForPlan(now)) tasks.set(id, task);
  return core.planSweep(entries, tasks, {
    now,
    liveTitles: liveTitleMap(),
    recheckFailures: recentRecheckFailures(now),
    alreadyPasses: linearAlreadyPassesForPlan(now),
    dispatchEnabled: dispatchEnabled(),
    unlandedJobDone: findUnlandedJobDoneEntries(entries, {
      sinceMs: now - UNLANDED_CHECK_WINDOW_MS,
      mainRepoCwd: require('./lib/bsc-runner.js').REPO,
    }),
  });
}

// ── actions ────────────────────────────────────────────────────────────────

function pageOwner({ conditionKey, title, description, severity = 'error', cooldownHours = 24 }) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    routeAlert({ conditionKey, title, description, severity, disposition: 'digest', cooldownHours }).catch(() => {});
  } catch { /* alerting must never break the sweep */ }
}

// Async child dispatch with a hard timeout AND a heartbeat drip: a bsc-next
// launch legitimately takes minutes (slow-boot verify), and a silent
// heartbeat that long would let a concurrent --ensure-tab call a healthy
// dashboard dead (plan-review P0).
// Which dispatcher owns this taskId (BRO-3390). Same fork digest-autofix.js
// already makes at its own spawn site — matched on the id namespace, never on
// subject text.
//
// The Linear lane is dispatched --headless deliberately, and this is the one
// place the two lanes genuinely differ:
//   - headless needs no cmux terminal runtime, so the LAUNCH itself sidesteps
//     BRO-2709 (cmux at its runtime ceiling, where auto-dispatch fails
//     SILENTLY at launch). NOTE the limit of that claim, found by ship-check:
//     planSweep's holds are still global, so `cmux unobservable`, the
//     global auto-tab ceiling, a launcher outage or a launcher leak all stop
//     this lane too even though none of them can affect a headless child.
//     Headless is therefore more RELIABLE once launched, but it is not yet
//     ISOLATED from cmux's health. Tracked in BRO-3404;
//   - measured on data/audit/dispatch-ledger.jsonl since 2026-08-16, the
//     headless lane reaches job-done 83.0% of the time (460 jobs, 17.0%
//     trouble) against 30.5% dead/vanished for the cmux workspace lane
//     (462 launches). Raising concurrency onto the worse lane would have
//     spent the increase on launches that never run.
// The Notion lane keeps its existing cmux behaviour untouched — this change
// adds a lane, it does not re-point the old one.
// BRO-3423 (/what-else cousin sweep): this was a FOURTH private copy of the
// live-board id shape, in the very file whose mis-targeting the card was filed
// over. It happened to be byte-identical to the shared one, so there was no
// live bug — but two of the other three copies HAD already drifted apart
// (digest-autofix.js rejected team keys containing a digit while
// linear-watchdog-source.js accepted them), which is how a fleet ends up with
// two different answers to "is this the live board?". Declared once, in
// scripts/lib/task-id-namespace.js, alongside which board is live and which is
// retired.
const { LINEAR_TASK_ID_RE } = require('./lib/task-id-namespace.js');

function dispatchArgvFor(taskId) {
  const m = LINEAR_TASK_ID_RE.exec(String(taskId));
  // --detach is NOT optional here (ship-check P0). `--headless` alone AWAITS
  // runJob for the job's entire life, and runBscNext SIGKILLs the process
  // group at DISPATCH_TIMEOUT_MS = 15 minutes. Measured on the real ledger:
  // median headless job 21.9 min, and 277 of 424 (65.3%) run past 15 minutes —
  // so two out of every three paid jobs would have been killed mid-flight,
  // money spent and work discarded, with no terminal row written. That would
  // have FED the very write-back leak this change surfaces. With --detach,
  // linear-next re-execs in its own session and returns immediately, which is
  // exactly what digest-autofix.js's own spawn site does.
  // BRO-3652: detach is now linear-next's DEFAULT on the headless lane, and
  // `--headless` is a no-op alias for that default. `--detach` is deliberately
  // NOT passed any more: an EXPLICIT --detach on a card that routes to a tab
  // ('mac-only' label) is refused loudly by decideDetach, whereas the default
  // simply takes the tab path in-process — this lane has no mac-only filter
  // upstream, so the explicit flag would have parked every such card as
  // "redispatch never produced a launch" (ship-check finding).
  if (m) return [path.join(REPO, 'scripts', 'linear-next.js'), '--id', m[1], '--headless'];
  return [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId)];
}

// BRO-3429: the owner-facing re-arm command in a park page must match the
// lane the task actually dispatches through — sharing LINEAR_TASK_ID_RE with
// dispatchArgvFor keeps that guaranteed rather than hand-copied.
function reArmHintFor(taskId) {
  const m = LINEAR_TASK_ID_RE.exec(String(taskId));
  return m
    ? `node scripts/linear-next.js --id ${m[1]} --force`
    : `node scripts/bsc-next.js --id ${taskId} --force`;
}

function runBscNext(taskId, { onTick } = {}) {
  return new Promise(resolve => {
    // detached: bsc-next spawns its own helpers (cmux calls, sleep loops) —
    // a timeout must kill the whole PROCESS GROUP, or the node child dies
    // while its wrapper keeps launching unjournaled (ship-check P1).
    const child = spawn('node', dispatchArgvFor(taskId), {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const drip = setInterval(() => { if (onTick) onTick(taskId); }, 30 * 1000);
    const killer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, DISPATCH_TIMEOUT_MS);
    child.on('close', code => {
      clearInterval(drip);
      clearTimeout(killer);
      resolve({ code, out: out.slice(-2000) });
    });
    child.on('error', () => {
      clearInterval(drip);
      clearTimeout(killer);
      resolve({ code: -1, out: 'spawn failed' });
    });
  });
}

async function executeSweep(plan, { dryRun = false, heartbeat = true } = {}) {
  const results = { dispatched: [], failed: [], parked: [] };
  const hb = extra => { if (heartbeat && !dryRun) writeHeartbeat({ mode: 'sweep', ...summarize(plan), ...extra }); };
  hb({});

  if (dryRun) return results;

  for (const item of plan.toPark) {
    // Card #1233: item.deaths is substantive-only unless the park itself was
    // triggered by the infra ceiling (item.reason === 'infra'), in which case
    // it's the infra count instead — never build this message from a raw
    // "total deaths" assumption, or an infra-only park reads as "parked
    // after 0 dead dispatch attempts" (ship-check catch).
    const isInfra = item.reason === 'infra';
    const countPhrase = isInfra
      ? `${item.deaths} infra-only dead-launch attempts in a row`
      : `${item.deaths} dead dispatch attempts`;
    dispatchLedger.appendEntry({ event: core.WATCHDOG_EVENTS.PARK, taskId: item.taskId, subject: item.subject, reason: `${countPhrase} — retries exhausted` });
    pageOwner({
      conditionKey: `watchdog-park:${item.taskId}`,
      title: `Watchdog parked #${item.taskId} after ${countPhrase}`,
      description: isInfra
        ? `Watchdog: card "${item.subject}" failed to even boot ${item.deaths}x in a row — every attempt was cmux's terminal surface never rendering, not the task itself. It will NOT be retried automatically — bring cmux to the foreground (or restart it), then re-dispatch with bsc-next --id ${item.taskId} --force.`
        : `Watchdog: card "${item.subject}" was dispatched ${item.deaths} times and every session died. It will NOT be retried automatically — it needs your look (or a fresh dispatch with bsc-next --id ${item.taskId} --force once fixed).`,
    });
    results.parked.push(item.taskId);
  }

  // BRO-3442: a headless job that ended `THIS SESSION: CLOSE ME|IDLE —
  // BLOCKED: <reason>` did its job correctly — it hit something only the
  // owner can resolve and said so, instead of silently stopping short
  // (BRO-3424) or reading as job-done (BRO-3388). Park it (never
  // auto-retried — see JOB_EVENTS.BLOCKED's own comment for why this must
  // not burn a dead-attempt strike) and, for a Linear-backed task, post the
  // reason as a comment on the card itself — a safety net for when the
  // job's own self-report (the same `linear-session.js report --status=
  // blocked` call its prompt already tells it to make before ending on
  // BLOCKED:) didn't happen, e.g. it crashed or the call itself failed.
  // In-process require (not a spawned child) — linear-session.js's cmdReport
  // is a plain async function with no CLI-only side effect for
  // --status=blocked (process.exit(5) only fires on the done-gate refusal
  // path, gated on status==='done').
  for (const item of plan.jobBlocked) {
    const linearMatch = /^linear:(.+)$/.exec(item.taskId);
    if (linearMatch) {
      try {
        const { cmdReport } = require('./linear-session.js');
        await cmdReport({
          issue: linearMatch[1],
          status: 'blocked',
          summary: `Watchdog safety net: headless job ${item.jobId} ended THIS SESSION: CLOSE ME|IDLE — BLOCKED: ${item.reason || 'no reason given'}. Not retried automatically — resolve the blocker, then re-dispatch (node scripts/linear-next.js --id ${linearMatch[1]} --force once fixed).`,
        }, {});
      } catch (e) {
        console.error(`[watchdog] failed to post BLOCKED reason to Linear ${item.taskId}: ${e.message}`);
      }
    }
    dispatchLedger.appendEntry({
      event: core.WATCHDOG_EVENTS.PARK, taskId: item.taskId, subject: item.subject,
      reason: `headless job ${item.jobId} blocked: ${item.reason || 'no reason given'}`,
    });
    results.parked.push(item.taskId);
  }

  // BRO-3429: a claim that never produced a launch was previously invisible —
  // it just sat in the dashboard's "awaiting claim" label and quietly
  // re-armed itself after 24h, forever, with no ledger park and no page. Live
  // evidence: 84 redispatches / 0 launches / 0 parks over 7 days for stuck
  // pre-freeze Notion cards. planSweep() already suppresses this list during
  // a proven fleet-wide launcher outage (see noLaunchPark's own comment in
  // dispatch-watchdog-core.js) so this loop never misattributes a systemic
  // cmux failure to individually-fine cards.
  for (const item of plan.noLaunchPark) {
    dispatchLedger.appendEntry({
      event: core.WATCHDOG_EVENTS.PARK, taskId: item.taskId, subject: item.subject,
      reason: `claimed at ${item.claimedAt} but produced no launch — retries exhausted`,
    });
    pageOwner({
      conditionKey: `watchdog-park:${item.taskId}`,
      title: `Watchdog parked #${item.taskId} — redispatch never produced a launch`,
      description: `Watchdog: card "${item.subject}" was claimed for redispatch at ${item.claimedAt} but never produced a 'launch' event. It will NOT be retried automatically — check why (node scripts/predispatch-check.js --id ${item.taskId}), then re-arm with ${reArmHintFor(item.taskId)} once fixed.`,
    });
    results.parked.push(item.taskId);
  }

  for (const item of plan.toDispatch) {
    // Claim BEFORE the spawn: the day budget must survive a crash mid-dispatch
    // (plan-review: a durable claimed attempt precedes every dispatch).
    dispatchLedger.appendEntry({ event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: item.taskId, subject: item.subject, kind: item.deaths ? 'retry' : 'p01-backlog' });
    console.error(`[watchdog] dispatching #${item.taskId} "${(item.subject || '').slice(0, 60)}" (${item.deaths ? 'retry' : 'undispatched ' + (item.priority || 'P0/P1')})`);
    const r = await runBscNext(item.taskId, { onTick: () => hb({ busy: `dispatching #${item.taskId}` }) });
    if (r.code === 0) results.dispatched.push(item.taskId);
    else {
      console.error(`[watchdog] bsc-next --id ${item.taskId} exited ${r.code}: ${r.out.split('\n').slice(-3).join(' / ')}`);
      const structuralReason = core.structuralGuardRefusal(r.out);
      if (structuralReason) {
        // BRO-3481: this class of refusal is deterministic — the child's own
        // dispatch guard will refuse identically on every retry, so letting
        // the normal retry loop rediscover it burns a REDISPATCH claim each
        // time before noLaunchPark's generic "produced no launch" message
        // eventually fires several sweeps later. Park now, naming the
        // guard's own reason, instead of waiting for retries to exhaust.
        dispatchLedger.appendEntry({
          event: core.WATCHDOG_EVENTS.PARK, taskId: item.taskId, subject: item.subject,
          reason: `dispatch guard refuses structurally: ${structuralReason}`,
        });
        pageOwner({
          conditionKey: `watchdog-park:${item.taskId}`,
          title: `Watchdog parked #${item.taskId} — dispatch guard refuses by construction`,
          description: `Watchdog: card "${item.subject}" cannot be redispatched by the watchdog's own argv — its dispatcher refuses: "${structuralReason}". This will NOT clear on retry. Re-arm with ${reArmHintFor(item.taskId)} once you've confirmed it's safe (or fix the underlying cause).`,
        });
        results.parked.push(item.taskId);
      } else {
        results.failed.push(item.taskId);
      }
    }
    hb({});
  }

  if (plan.outage.outage) {
    pageOwner({
      conditionKey: 'watchdog-launcher-outage',
      title: 'cmux launcher outage — dispatches are dying at injection',
      description: `Watchdog: ${plan.outage.count} launches across tasks ${plan.outage.taskIds.join(', ')} died with "injection never ran". cmux is likely wedged or backgrounded — foreground/restart the cmux app. Watchdog is holding all dispatches until a launch verifies.`,
      cooldownHours: 6,
    });
  }
  // BRO-2318: independent of the outage page above — fires even when the
  // launcher looks "recovered" (a success always follows the next death),
  // because a sustained ~1-in-3 injection-failure rate was invisible until now.
  if (plan.failureRate.leaking) {
    pageOwner({
      conditionKey: 'watchdog-launcher-leak',
      title: 'cmux launcher leaking — a third-ish of dispatches never start',
      description: `Watchdog: ${plan.failureRate.failureCount}/${plan.failureRate.totalLaunches} launches (${Math.round(plan.failureRate.rate * 100)}%) died with "injection never ran" over the last 6h across tasks ${plan.failureRate.taskIds.join(', ')}. This is NOT the sustained-outage alarm — cmux keeps producing occasional verified successes, which is exactly why it never trips that one. Dispatched work is silently not running at this rate; check cmux responsiveness.`,
      cooldownHours: 6,
    });
  }
  return results;
}

function summarize(plan) {
  return {
    cmuxObserved: plan.cmuxObserved,
    inFlight: plan.inFlight.length,
    needsYou: plan.needsYou,
    p01Queued: plan.p01Queue.length,
    // BRO-3390: the write-back leak in the same machine-readable surface as
    // everything else, so "it fails loudly" is true for --status --json and
    // the heartbeat, not just for the crowned tab's narrative.
    writeBackLeak: linearWriteBackLeak().length,
    linearSource: { ok: linearTaskCache.ok, reason: linearTaskCache.reason, eligible: linearTaskCache.tasks.size },
    // #1564: suppressed cards are subtracted from p01Queued, so without this
    // the heartbeat and --status --json show a backlog that silently shrank.
    // Every machine-readable surface must carry the population the filter
    // removed, or the "not silent" claim only holds for the crowned tab.
    awaitingClaim: plan.awaitingClaim.map(a => a.taskId),
    // BRO-3429: the cards this sweep is actually parking (or already parked
    // on a prior tick) — omitting this from --status --json would leave the
    // exact escalation this ticket added invisible to anything reading the
    // machine-readable surface instead of the narrative (codex review catch).
    noLaunchPark: plan.noLaunchPark.map(p => p.taskId),
    // BRO-3924 (R3): same "not silent" doctrine as awaitingClaim/noLaunchPark
    // above — a card excluded from the queue for already passing must be
    // visible on the machine-readable surface too, not just the narrative.
    alreadyPasses: plan.alreadyPasses.map(a => a.id),
    parkedTotal: plan.parkedTotal,
    dispatchedToday: plan.budgets.usedToday,
    holds: plan.budgets.holds,
    // BRO-3924 (R5): spend circuit-breaker status, so --status --json and the
    // heartbeat both show whether dispatch is (or is about to be) held on
    // money, not just claim-count caps.
    spend: {
      halt: plan.budgets.spend.halt,
      spentUSD: plan.budgets.spend.spentUSD,
      reservedUSD: plan.budgets.spend.reservedUSD,
      thresholdUSD: plan.budgets.spend.thresholdUSD,
    },
    // BRO-2462: `holds` mixes policy pauses with failure-detection signals
    // (see dispatch-watchdog-core.js) — surfaced separately so `--status
    // --json` lets a human see directly whether health()'s tab-count/
    // queue-depth pager is currently gated, instead of re-deriving it from
    // the holds strings.
    pausedByPolicy: plan.budgets.pausedByPolicy,
  };
}

// ── crowned tab lifecycle ──────────────────────────────────────────────────

// The watchdog's own tab title always STARTS (after cmux's activity-glyph
// prefix, e.g. braille spinners) with the exact string "👑 OWNER watchdog".
// Ship-check P0: a substring match ("👑" + "watchdog" anywhere) also matched
// crowned SESSION tabs whose mandate merely mentions the watchdog (e.g.
// "👑 OWNER — repair dispatch-watchdog alerts") — and ensureTab would then
// CLOSE a live owner session. Exact-prefix only; mandate tabs use "👑 OWNER
// — <mandate>" which never starts with "👑 OWNER watchdog".
const WATCHDOG_TITLE_START = `${core.WATCHDOG_TAB_PREFIX} ${core.WATCHDOG_TAB_MARKER}`;
function isWatchdogTitle(title) {
  return String(title).replace(/^[^\p{L}\p{N}👑]*/u, '').startsWith(WATCHDOG_TITLE_START);
}
function findWatchdogTab(titles) {
  if (!(titles instanceof Map)) return null;
  for (const [ref, title] of titles) {
    if (isWatchdogTitle(title)) return { ref, title };
  }
  return null;
}

function renameTab(ref, title) {
  try { cmuxws.run(['workspace-action', '--action', 'rename', '--workspace', ref, '--title', title]); return true; }
  catch { return false; }
}

function createTab() {
  const cmdFile = path.join(os.tmpdir(), `bsc-watchdog-dashboard-${Date.now()}.sh`);
  fs.writeFileSync(cmdFile, `#!/bin/bash\nexec node ${REPO}/scripts/dispatch-watchdog.js --dashboard\n`);
  // Through cmuxws.run(), NOT a raw spawnSync (BRO-3001). This is a
  // launchd→cmux call: health() below reaches it every 900s whenever the
  // heartbeat is stale, which is precisely when nothing else is going to
  // resurrect the crowned tab. A raw spawnSync inherits process.env, so it
  // carried the socket credential only because three LaunchAgent plists still
  // set CMUX_SOCKET_PASSWORD by hand — the band-aid BRO-2959's own fix
  // describes as "REDUNDANT with the code fix", i.e. removable. Removing it
  // would have re-broken this path silently, which is the "per-plist
  // under-fixes BY CONSTRUCTION" failure cmux-socket-auth.js's header warns
  // about, reproduced inside the fix that warned about it.
  //
  // run() also buys the 3-rung auth-denied retry ladder — a ROTATED password
  // still killed this tab with a hand-rolled `env:`, because that gets
  // attempt 1 only. Its header names "creating a workspace" as safe to retry:
  // an auth rejection happens at the handshake, before the daemon sees the
  // command, so nothing was applied and re-sending cannot double-create.
  // Failure is a throw here, not a status code — the catch keeps the old
  // "return null → 'tab creation failed'" contract that ensureTab expects.
  let out = '';
  try {
    out = cmuxws.run(['new-workspace', '--name', `${WATCHDOG_TITLE_START} — starting…`,
      '--cwd', REPO, '--command', ` bash ${cmdFile}`, '--focus', 'false']);
  } catch (e) {
    console.error(`watchdog: new-workspace failed (${classifyCmuxError(e)}): ${e.message}`);
    return null;
  }
  const m = /workspace:\d+/.exec(String(out || ''));
  const ref = m ? m[0] : null;
  if (ref) {
    // 'starting' heartbeat only AFTER new-workspace succeeded (ship-check
    // P0: writing it before masked a hard launch failure as "healthy" for
    // 10-30 min — exactly what Gate O/--health exist to catch). The lock
    // already serializes racing ensure-tabs, so nothing needs the earlier
    // write. The dashboard overwrites this within one tick of booting;
    // ensureTab treats a 'starting' heartbeat >3 min old as a dead boot.
    writeHeartbeat({ mode: 'starting' });
    const tmp = `${TAB_STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ref, createdAt: new Date().toISOString() }));
    fs.renameSync(tmp, TAB_STATE_PATH);
  }
  return ref;
}

function ensureTab() {
  if (watchdogOff()) { console.log('watchdog: disabled (kill switch) — not ensuring tab'); return 0; }
  if (!acquireLock()) { console.log('watchdog: another watchdog process holds the lock — skipping'); return 0; }
  try {
    // List INSIDE the lock (ship-check P0: a pre-lock snapshot let a caller
    // that waited on the lock create a second crowned tab from stale data).
    const titles = liveTitleMap();
    if (!titles) { console.log('watchdog: cmux unobservable — cannot ensure tab from here'); return 1; }
    const hb = readJson(HEARTBEAT_PATH);
    const age = heartbeatAgeMs();
    // 'starting' heartbeats get a much shorter bar: the dashboard writes its
    // first real heartbeat within seconds of boot, so a starting-stamp older
    // than 3 min means the boot died (ship-check P1).
    const staleBar = hb && hb.mode === 'starting' ? 3 * 60 * 1000 : HEARTBEAT_STALE_MS;
    const existing = findWatchdogTab(titles);
    if (existing && age !== null && age < staleBar) {
      console.log(`watchdog: healthy — ${existing.ref} ("${existing.title}"), heartbeat ${Math.round(age / 1000)}s old`);
      return 0;
    }
    if (existing) {
      // Tab exists but the loop is stale/dead. Never close on age alone
      // (plan-review P0) — only when the recorded pid is provably gone; a
      // live pid means a long dispatch is in progress, leave it be.
      if (hb && hb.pid && pidAlive(hb.pid) && hb.mode !== 'starting') {
        console.log(`watchdog: heartbeat stale but pid ${hb.pid} alive (long dispatch?) — leaving ${existing.ref} alone`);
        return 0;
      }
      console.log(`watchdog: ${existing.ref} dashboard is dead (stale heartbeat, no live pid) — recreating`);
      try { cmuxws.closeWorkspace(existing.ref); } catch { /* already gone */ }
    }
    const ref = createTab();
    if (ref) {
      dispatchLedger.appendEntry({ event: 'watchdog-resurrect', taskId: 'watchdog', workspaceRef: ref, gapMs: age });
      console.log(`watchdog: crowned tab created — ${ref}${age !== null ? ` (gap ${Math.round(age / 60000)} min)` : ''}`);
      return 0;
    }
    console.log('watchdog: tab creation failed');
    return 1;
  } finally {
    releaseLock();
  }
}

// ── modes ──────────────────────────────────────────────────────────────────

// BRO-3390: render the write-back leak under the narrative. Capped at 8 lines
// — this is a nudge on a dashboard, not the triage list (BRO-3376 owns that).
function renderWriteBackLeak(now = Date.now()) {
  const leak = linearWriteBackLeak(now);
  if (!leak.length) return '';
  const lines = [
    '',
    `WRITE-BACK LEAK: ${leak.length} card(s) finished (job-done) but never left their started state:`,
  ];
  for (const l of leak.slice(0, 8)) {
    lines.push(`  • ${l.identifier} "${String(l.title).slice(0, 56)}" — done ${l.ageHours}h ago, still ${l.stateName}`);
  }
  if (leak.length > 8) lines.push(`  …and ${leak.length - 8} more`);
  lines.push('  close one: node scripts/linear-brain.js update <BRO-N> --state Done   (needs PR-EVIDENCE or a VERIFY: line)');
  return lines.join('\n');
}

async function sweepOnce({ dryRun }) {
  await refreshLinearTasks();          // BRO-3390: Linear is a task source now
  const now = Date.now();
  const plan = buildPlan(now);
  console.log(core.renderNarrative(plan));
  const leakText = renderWriteBackLeak(now);
  if (leakText) console.log(leakText);
  if (dryRun) { console.log('\n(dry-run: no actions taken, no heartbeat written)'); return 0; }
  if (!acquireLock()) { console.log('watchdog: lock held by another process — skipping actions'); return 0; }
  try {
    const results = await executeSweep(plan);
    if (results.dispatched.length || results.parked.length || results.failed.length) {
      console.log(`\nactions: dispatched [${results.dispatched}] parked [${results.parked}] failed [${results.failed}]`);
    }
  } finally { releaseLock(); }
  return 0;
}

async function dashboardLoop() {
  let lastTitle = '';
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  for (;;) {
    // BRO-3390: refresh the Linear source before each sweep. Awaited inside
    // the try so a Linear failure takes the same guarded path as a plan-build
    // failure and can never kill the loop.
    await refreshLinearTasks();
    const now = Date.now();
    let plan;
    try {
      plan = buildPlan(now);
      if (watchdogOff()) {
        writeHeartbeat({ mode: 'disabled' });
        console.clear();
        console.log('👑 Dispatch watchdog — DISABLED by kill switch (~/.claude/state/dispatch-watchdog-off). Delete the file to resume.');
      } else {
        if (acquireLock()) {
          try { await executeSweep(plan, { heartbeat: true }); }
          finally { releaseLock(); }
        }
        writeHeartbeat({ mode: 'dashboard', ...summarize(plan) });
        console.clear();
        console.log(core.renderNarrative(plan));
        const leakText = renderWriteBackLeak(now);
        if (leakText) console.log(leakText);
        // Rename own tab (freshness cue lives in the title). The tab is
        // located by TITLE in the current listing, never by the stored ref
        // alone (ship-check P0: cmux recycles refs across restarts — a
        // blind rename of tabState.ref can crown an unrelated live tab).
        const title = core.tabTitle(plan);
        if (title !== lastTitle) {
          const listing = liveTitleMap();
          const self = findWatchdogTab(listing);
          if (self && renameTab(self.ref, title)) {
            lastTitle = title;
            const tabState = readJson(TAB_STATE_PATH);
            if (!tabState || tabState.ref !== self.ref) {
              const tmp = `${TAB_STATE_PATH}.${process.pid}.tmp`;
              fs.writeFileSync(tmp, JSON.stringify({ ref: self.ref, createdAt: new Date().toISOString() }));
              fs.renameSync(tmp, TAB_STATE_PATH);
            }
          }
        }
      }
    } catch (e) {
      // The loop must survive any single-tick error — a crashed dashboard is
      // the "durable runner silently down" pre-mortem scenario.
      console.error(`[watchdog] tick failed: ${e.message}`);
      try { writeHeartbeat({ mode: 'dashboard-error', error: String(e.message).slice(0, 200) }); } catch { /* disk? next tick */ }
    }
    await new Promise(r => setTimeout(r, DASHBOARD_INTERVAL_MS));
  }
}

// Pages when a kill-switch FILE has sat engaged past core.KILL_SWITCH_STALE_MS
// — reusable so the next kill switch that wants this (e.g. NO_DISPATCH_FILE)
// calls this instead of copy-pasting health()'s branch (plan-review
// suggestion). Returns {stale, ageMs} for the caller's own log line; a
// missing file (already cleared, or env-var-only disable) is never stale.
// Known scope limit (ship-check/codex review, task #1543): a *persistent*
// DISPATCH_WATCHDOG_DISABLED=1 env var (no backing file — e.g. set in a
// launchd plist's EnvironmentVariables) has no mtime and stays invisible to
// this check forever. The card's own acceptance criteria scope this to the
// kill-switch FILE; env-var persistence would need a different mechanism
// (there's nothing to stat) and is out of scope here.
function pageIfKillSwitchStale(filePath, { conditionKey, label, clearHint, now = Date.now() }) {
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* env-var disable or already cleared */ }
  const { stale, ageMs } = core.killSwitchStaleness(mtimeMs, now);
  if (!stale) return { stale, ageMs };
  const hours = Math.round(ageMs / 3600000);
  pageOwner({
    conditionKey,
    title: `${label} has been ON for ${hours}h — intentional?`,
    description: `${filePath} has been in place for ${hours}h (bar: ${core.KILL_SWITCH_STALE_MS / 3600000}h). While it's set, --health cannot page on a dead watchdog either — this is the ONE mechanism meant to catch that, blind exactly here. If this is a deliberate maintenance window, ignore; otherwise clear it: ${clearHint}`,
    severity: 'error',
    cooldownHours: 24,
  });
  return { stale, ageMs };
}

// I/O boundary for the flow-dead check (task #1915). Reads the ledger file
// directly rather than via dispatchLedger.readEntries(), which fails closed
// to [] on any read error — that would collapse "genuinely zero launches"
// and "ledger unreadable" into the same signal, losing the -1 fail-safe
// sentinel isDispatchFlowDead relies on to tell "confirmed dead" from
// "cannot prove dead".
function launchesInFlowWindow(now) {
  let raw;
  try { raw = fs.readFileSync(dispatchLedger.LEDGER_PATH, 'utf8'); }
  catch { return -1; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return dispatchLedger.countRecentLaunches(entries, { now, windowMs: flowHealth.FLOW_WINDOW_MS });
}

function health() {
  if (watchdogOff()) {
    // Deliberate disable is not an outage — paging on it would train the
    // owner to ignore the pager (ship-check P0). But a disable left engaged
    // past the staleness bar gets its own distinct page (task #1543) — the
    // ONE thing that's supposed to catch "the watchdog died" must not also
    // go blind while it's off.
    const { stale, ageMs } = pageIfKillSwitchStale(OFF_FILE, {
      conditionKey: 'watchdog-kill-switch-stale',
      label: 'Dispatch watchdog kill switch',
      clearHint: `rm ${OFF_FILE}`,
    });
    if (stale) {
      console.log(`watchdog: disabled by kill switch — STALE (${Math.round(ageMs / 3600000)}h), owner paged`);
      return 1;
    }
    console.log('watchdog: disabled by kill switch — health check skipped');
    return 0;
  }
  const age = heartbeatAgeMs();
  const stale = age === null || age > HEALTH_STALE_MS;
  if (!stale) {
    // Heartbeat-healthy is exactly the blind spot task #1915 closes: the
    // watchdog can heartbeat forever while dispatching ZERO work. cmux
    // calls are best-effort here (same rationale as ensureTab() below —
    // --health runs OUTSIDE cmux via launchd, which can't reach the socket
    // pre-restart) — a cmux failure means "cannot observe," which must
    // fail safe to "cannot prove dead," not silently page.
    // Distinct suffixes on the two success paths below are deliberate: this
    // is the only launchd-outside-cmux code path in the file, and without a
    // visible marker for "the flow check actually ran" vs. "it silently
    // skipped (cmux unobservable)", ~/Library/Logs/dispatch-watchdog-health.log
    // can't prove which one happened on a given tick.
    let flowSuffix = ' (flow check skipped: cmux unobservable)';
    try {
      const now = Date.now();
      const liveAutoWorkspaces = cmuxws.listWorkspaces().filter(w => hasAutoDispatchMarker(w.title)).length;
      const launchesLast45m = launchesInFlowWindow(now);
      // BRO-409: only trust a real queue depth when dispatch is actually
      // enabled AND no other legitimate hold explains zero launches — a
      // deliberate dispatch pause (NO_DISPATCH_FILE), or the watchdog's own
      // day budget / concurrency / global-auto-tab cap being spent
      // (planSweep's `holds`, dispatch-watchdog-core.js), routinely
      // produces zero launches with a deep, still-growing p01Queue and must
      // not page — that's expected pacing, not a stall (ship-check adversarial
      // catch: day-budget-spent was the LIVE state — 12/12 used, 199 queued —
      // when this was reviewed, so this isn't a hypothetical). -1 is the
      // existing "don't trust this" sentinel, so leaving it at -1 here
      // reduces to the pre-BRO-409 tab-count-only check. Unchanged by
      // BRO-2462 below — deliberately: widening this path's trust condition
      // too (e.g. to trust it during a detected outage) is a separate,
      // untested behavior change outside this ticket's scope.
      //
      // BRO-2462: dispatchEnabled() read once into dispatchEnabledNow and
      // reused for both the init and the guard below — two separate reads
      // could disagree if NO_DISPATCH_FILE is created in between (Codex
      // adversarial catch). dispatchPaused gates the tab-count path too, but
      // ONLY on a genuine policy pause (plan.budgets.pausedByPolicy) — never
      // on a detected failure (launcher outage, failure-rate leak, claim
      // outage). Those still appear in plan.budgets.holds (which
      // pausedByPolicy is deliberately narrower than) precisely because a
      // real stall must still page through the tab-count path, not get
      // silenced by its own symptom. If buildPlan() throws, dispatchPaused
      // stays at !dispatchEnabledNow (the cheap, non-throwing signal) — a
      // transient plan-build error deliberately fails toward the old
      // unconditional tab-count behavior (paging), not toward silently
      // suppressing it; an unknown state must never look like a known pause.
      let eligibleQueueDepth = -1;
      const dispatchEnabledNow = dispatchEnabled();
      let dispatchPaused = !dispatchEnabledNow;
      if (dispatchEnabledNow) {
        try {
          const plan = buildPlan(now);
          dispatchPaused = plan.budgets.pausedByPolicy;
          if (plan.budgets.holds.length === 0) eligibleQueueDepth = plan.p01Queue.length;
        } catch (e) { console.error(`[watchdog] queue-depth check skipped (${e.message})`); }
      }
      if (flowHealth.isDispatchFlowDead({ liveAutoWorkspaces, launchesLast45m, eligibleQueueDepth, dispatchPaused })) {
        pageOwner({
          conditionKey: 'dispatch-flow-dead',
          title: 'Dispatch flow is DEAD — heartbeat is fine but nothing is being dispatched',
          description: `Only ${liveAutoWorkspaces} live 🤖 auto-dispatch workspace(s) and ${launchesLast45m} ledger launch(es) in the last ${Math.round(flowHealth.FLOW_WINDOW_MS / 60000)} min (eligible P0/P1 queue depth: ${eligibleQueueDepth}). The watchdog heartbeat looks healthy, but dispatch itself has stalled — check the 👑 OWNER watchdog tab and bsc-next.js for a stuck sweep.`,
          severity: 'error',
          cooldownHours: 24,
        });
        console.log(`watchdog: heartbeat healthy but dispatch flow DEAD (live=${liveAutoWorkspaces}, launches45m=${launchesLast45m}, queueDepth=${eligibleQueueDepth}) — owner paged`);
        return 1;
      }
      flowSuffix = ` (flow: live=${liveAutoWorkspaces}, launches45m=${launchesLast45m}, queueDepth=${eligibleQueueDepth})`;
    } catch (e) {
      console.error(`[watchdog] flow-dead check skipped (cmux unobservable): ${e.message}`);
    }
    console.log(`watchdog healthy — heartbeat ${Math.round(age / 60000)} min old${flowSuffix}`);
    return 0;
  }
  pageOwner({
    conditionKey: 'watchdog-heartbeat-stale',
    title: 'Dispatch watchdog is DOWN — nobody owns in-flight dispatches',
    description: `The 👑 OWNER watchdog heartbeat is ${age === null ? 'missing' : Math.round(age / 60000) + ' min old'} (bar: ${HEALTH_STALE_MS / 60000} min). If cmux restarted, open any Claude session (its Stop hook resurrects the tab) or run: node scripts/dispatch-watchdog.js --ensure-tab`,
    severity: 'error',
    cooldownHours: 6,
  });
  // Best-effort: works when the launchd→cmux ACL allows it (post-restart
  // password mode); harmless "cmux unobservable" otherwise.
  try { ensureTab(); } catch { /* ACL rejection expected pre-restart */ }
  console.log('watchdog STALE — owner paged via alert router');
  return 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv) || argv.length === 0) { console.log(USAGE); return 0; }
  if (watchdogOff() && !argv.includes('--status') && !argv.includes('--health') && !argv.includes('--dashboard')) {
    console.log('watchdog: disabled (DISPATCH_WATCHDOG_DISABLED / dispatch-watchdog-off file)');
    return 0;
  }
  if (argv.includes('--ensure-tab')) return ensureTab();
  if (argv.includes('--sweep')) return sweepOnce({ dryRun: argv.includes('--dry-run') });
  if (argv.includes('--dashboard')) return dashboardLoop();
  if (argv.includes('--health')) return health();
  if (argv.includes('--status')) {
    // Refresh before reporting: --status is the owner's read-only view, and a
    // status that silently omitted the Linear half of the queue would be the
    // same blind spot BRO-3390 exists to close.
    await refreshLinearTasks();
    const plan = buildPlan(Date.now());
    if (argv.includes('--json')) console.log(JSON.stringify({ ...summarize(plan), heartbeatAgeMs: heartbeatAgeMs(), tab: readJson(TAB_STATE_PATH) }, null, 2));
    else console.log(core.renderNarrative(plan));
    return 0;
  }
  console.log(USAGE);
  return 2;
}

if (require.main === module) {
  main().then(code => { if (code) process.exitCode = code; })
    .catch(e => { console.error(`watchdog fatal: ${e.message}`); process.exitCode = 1; });
}
module.exports = {
  main, ensureTab, findWatchdogTab, recentRecheckFailures, HEARTBEAT_PATH, TAB_STATE_PATH,
  pageIfKillSwitchStale,
  // BRO-3390: exported so the lane fork is tested against the REAL function
  // rather than a copy of its regex (CLAUDE.md rule 15). LINEAR_CACHE_TTL_MS
  // and linearTasksForPlan go with it so the cache's staleness contract is
  // testable without a network call.
  dispatchArgvFor, linearTasksForPlan, linearStartedTasksForPlan, LINEAR_CACHE_TTL_MS,
  // BRO-3429: same rationale — tested against the real function, not a copy.
  reArmHintFor,
  // BRO-3924 (R3): exported (with an injectable path param) so the staleness
  // check is tested against the real function, not a copy.
  loadAlreadyPassesReport, OPEN_BACKLOG_SWEEP_REPORT_PATH, OPEN_BACKLOG_SWEEP_MAX_AGE_MS,
};
