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
const cmuxws = require('./lib/cmux-workspaces.js');
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

const DASHBOARD_INTERVAL_MS = 90 * 1000;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;      // ensure-tab resurrection bar
const HEALTH_STALE_MS = 30 * 60 * 1000;         // launchd paging bar
const DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;     // bsc-next slow-boot worst case + margin
const RECHECK_WINDOW_MS = 48 * 3600 * 1000;

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

function buildPlan(now) {
  const entries = readLedgerCached();
  const tasks = loadTasksUnioned();
  return core.planSweep(entries, tasks, {
    now,
    liveTitles: liveTitleMap(),
    recheckFailures: recentRecheckFailures(now),
    dispatchEnabled: dispatchEnabled(),
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
function runBscNext(taskId, { onTick } = {}) {
  return new Promise(resolve => {
    // detached: bsc-next spawns its own helpers (cmux calls, sleep loops) —
    // a timeout must kill the whole PROCESS GROUP, or the node child dies
    // while its wrapper keeps launching unjournaled (ship-check P1).
    const child = spawn('node', [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId)], {
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

  for (const item of plan.toDispatch) {
    // Claim BEFORE the spawn: the day budget must survive a crash mid-dispatch
    // (plan-review: a durable claimed attempt precedes every dispatch).
    dispatchLedger.appendEntry({ event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: item.taskId, subject: item.subject, kind: item.deaths ? 'retry' : 'p01-backlog' });
    console.error(`[watchdog] dispatching #${item.taskId} "${(item.subject || '').slice(0, 60)}" (${item.deaths ? 'retry' : 'undispatched ' + (item.priority || 'P0/P1')})`);
    const r = await runBscNext(item.taskId, { onTick: () => hb({ busy: `dispatching #${item.taskId}` }) });
    if (r.code === 0) results.dispatched.push(item.taskId);
    else {
      results.failed.push(item.taskId);
      console.error(`[watchdog] bsc-next --id ${item.taskId} exited ${r.code}: ${r.out.split('\n').slice(-3).join(' / ')}`);
    }
    hb({});
  }

  if (plan.outage.outage) {
    // Card #1829: cause-specific title + description — the old hardcoded
    // "injection" wording would misdiagnose a pure surface-not-found cluster
    // (cmux DID accept the commands; it never rendered a working pane for
    // them), which is exactly the failure class this card exists to fix.
    const cause = dispatchLedger.describeOutageCause(plan.outage.causes);
    pageOwner({
      conditionKey: 'watchdog-launcher-outage',
      title: 'cmux launcher outage — dispatches are dying before a session starts',
      description: `Watchdog: ${plan.outage.count} launches across tasks ${plan.outage.taskIds.join(', ')} died: ${cause}. Foreground/restart the cmux app. Watchdog is holding all dispatches until a launch verifies.`,
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
    // #1564: suppressed cards are subtracted from p01Queued, so without this
    // the heartbeat and --status --json show a backlog that silently shrank.
    // Every machine-readable surface must carry the population the filter
    // removed, or the "not silent" claim only holds for the crowned tab.
    awaitingClaim: plan.awaitingClaim.map(a => a.taskId),
    dispatchedToday: plan.budgets.usedToday,
    holds: plan.budgets.holds,
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
  const r = spawnSync(cmuxws.CMUX, ['new-workspace', '--name', `${WATCHDOG_TITLE_START} — starting…`,
    '--cwd', REPO, '--command', ` bash ${cmdFile}`, '--focus', 'false'], { encoding: 'utf8', timeout: 15000 });
  const m = /workspace:\d+/.exec(String(r.stdout || ''));
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

async function sweepOnce({ dryRun }) {
  const now = Date.now();
  const plan = buildPlan(now);
  console.log(core.renderNarrative(plan));
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
  if (!stale) { console.log(`watchdog healthy — heartbeat ${Math.round(age / 60000)} min old`); return 0; }
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
};
