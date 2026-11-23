'use strict';
/**
 * dispatcher-wake.js (BRO-8079): when a dispatched job ends without landing, tell the session
 * that dispatched it, so it acts without the owner asking.
 *
 * Incident (2026-11-22): BRO-7984 job-failed stage=timeout at 15:50Z was found ~2h later, and
 * BRO-8065 job-stranded at 21:54Z 2.5h later, both only because the owner asked. Gate O
 * (exit-status-gate.sh) makes the dispatching session own the landing, but it fires only when
 * that session ends CLOSE ME/IDLE; a KEEP OPEN tab never re-checks.
 *
 * Two halves:
 *  - dispatchedByFromEnv(): the launch call sites (linear-next.js, bsc-next.js) stamp
 *    `dispatchedBy: {sessionId, workspaceId}` on their `launch` ledger row when they run inside
 *    an interactive Claude session in a cmux tab. Headless jobs never stamp: bsc-runner spawns them
 *    with ESG_HEADLESS=1 and claude-cli.js's strippedEnv drops CMUX_WORKSPACE_ID. The watchdog's
 *    own redispatches carry no CLAUDE_CODE_SESSION_ID, so they do not stamp either.
 *  - planDispatcherWakes(): PURE. Folds the dispatch ledger per task and returns the wakes owed:
 *    the task's NEWEST row is a bad outcome (job-failed / job-stranded / job-blocked /
 *    job-stopped-short / watchdog-park), it is old enough that bsc-reconcile's own retry had its
 *    chance (10 min) and young enough to still matter (24h), and the task's newest launch carries
 *    dispatchedBy. Any later launch, spawn, retry, done or landed-* row means the task moved on,
 *    so nothing is sent (16 of 37 bad rows 2026-11-21..22 were followed by one).
 *
 * dispatch-watchdog.js's dashboard loop delivers them (deliverDispatcherWakes there), after the
 * sweep lock is released, only into a tab whose Claude is alive and idle, through
 * cmux-workspaces.sendToWorkspace's title-checked path. Kill switches: DISPATCHER_WAKE_DISABLED=1
 * or the file ~/.claude/state/dispatcher-wake-off.
 */

// Bad outcomes. job-orphaned: SIGKILL/OOM with no exit row. dead/vanished: the cmux-tab lane's deaths.
// job-abandoned counts only for disk pressure (the job never ran); a lease-held abandon means another
// job for the task is running fine (see isBadRow).
const BAD_EVENTS = new Set(['job-failed', 'job-stranded', 'job-blocked', 'job-stopped-short', 'job-orphaned', 'watchdog-park', 'dead', 'vanished', 'job-abandoned']);
// Rows that mean the task moved on after a bad row: re-dispatched, retried, finished, closed done or landed.
const LANDED_EVENTS = (() => { try { return [...require('./dispatch-ledger.js').LANDED_ACK_EVENTS]; } catch { return ['landed-acked', 'landed-before-dispatch', 'landed-outside-dispatch']; } })();
const MOVED_ON_EVENTS = new Set(['launch', 'job-spawned', 'job-retried', 'job-done', 'prune-closed', ...LANDED_EVENTS]);
const isLeaseHeldAbandon = (e) => e.event === 'job-abandoned' && !/^disk-pressure/.test(String(e.reason || ''));
function isBadRow(e) {
  return BAD_EVENTS.has(e.event) && !(e.event === 'job-abandoned' && !/^disk-pressure/.test(String(e.reason || '')));
}
const MIN_AGE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_PER_SWEEP = 5;
const NOTICE_PREFIX = '[automated dispatch-watchdog notice, not owner input]';

/** PURE. The dispatchedBy stamp for a launch row, or null when this is not an interactive cmux Claude session. */
function dispatchedByFromEnv(env = process.env) {
  const sessionId = String(env.CLAUDE_CODE_SESSION_ID || '').trim();
  const workspaceId = String(env.CMUX_WORKSPACE_ID || '').trim();
  if (!sessionId || !workspaceId) return null;
  if (env.ESG_HEADLESS === '1') return null;
  return { sessionId, workspaceId };
}

/** Spread into a launch row: {dispatchedBy} or {} (no key at all, so rows written outside a cmux tab are unchanged). */
function dispatchedByField(env = process.env) {
  const by = dispatchedByFromEnv(env);
  return by ? { dispatchedBy: by } : {};
}

function cardLabel(taskId) {
  return String(taskId || '').replace(/^linear:/, '');
}

function nextStep(row, card) {
  const reason = String(row.reason || row.detail || '');
  if (row.event === 'job-stranded') {
    return `its commits${row.sha ? ` (${String(row.sha).slice(0, 11)})` : ''} never reached main. Land them or re-dispatch: node scripts/linear-next.js --id ${card} --force; if they did land, node scripts/ack-landed.js`;
  }
  if (row.event === 'job-blocked') {
    if (/land(?:\.yml| run| queue)|rebase|merge conflict/i.test(reason)) return `it is stuck landing (${reason.slice(0, 140)}). Fix the land, then confirm on main`;
    return `it says it needs a decision (${reason.slice(0, 140)}). Read the card and answer or unblock it`;
  }
  if (row.event === 'watchdog-park') return `the watchdog stopped retrying (${reason.slice(0, 140)}). Read the card, fix the cause, re-dispatch with node scripts/linear-next.js --id ${card} --force`;
  if (row.event === 'job-failed') return `it failed${row.stage ? ` at stage ${row.stage}` : ''}${reason ? ` (${reason.slice(0, 100)})` : ''}. Resume or re-dispatch: node scripts/linear-next.js --id ${card} --force`;
  return `it stopped without finishing${reason ? ` (${reason.slice(0, 100)})` : ''}. Re-dispatch: node scripts/linear-next.js --id ${card} --force`;
}

/** PURE. One line, no newlines (sendToWorkspace refuses multi-line text). */
function wakeMessage(row, subject, sessionId) {
  const card = cardLabel(row.taskId);
  // Card titles are data, not instructions: keep them short and quoted.
  const title = subject ? ` ("${String(subject).replace(/^BRO-\d+\s+/, '').replace(/["`$\\]/g, "'").slice(0, 90)}")` : '';
  const at = String(row.ts || '').slice(11, 16);
  // The tab may now hold a different conversation (the session id is not observable from cmux), so the
  // notice names the dispatching session and tells any other session to ignore it (ship-check finding).
  const who = sessionId ? ` If your CLAUDE_CODE_SESSION_ID does not start with ${String(sessionId).slice(0, 8)}, this is not yours: ignore it.` : '';
  return `${NOTICE_PREFIX} The job this tab dispatched for ${card}${title} ended ${row.event} at ${at}Z without landing: ${nextStep(row, card)}.${who}`.replace(/\s*\n\s*/g, ' ');
}

/**
 * PURE. entries: dispatch-ledger rows (any order). attempts: Map key -> {attempts, sent}.
 * Returns [{key, taskId, event, workspaceId, sessionId, message}] newest first, capped.
 */
function planDispatcherWakes(entries, { attempts = new Map(), nowMs = Date.now(), minAgeMs = MIN_AGE_MS, maxAgeMs = MAX_AGE_MS, maxPerSweep = Infinity } = {}) {
  const byTask = new Map();
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && e.taskId && e.ts && !Number.isNaN(Date.parse(e.ts)));
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const e of rows) {
    const t = byTask.get(e.taskId) || { last: null, launch: null, prevLaunch: null, prevLast: null };
    // A lease-held abandon: a second launch raced a live job and did nothing, so the task's real
    // launch and state are the ones before it (ship-check finding: the racing unstamped launch would
    // otherwise hide the live job's later failure).
    if (isLeaseHeldAbandon(e)) {
      if (t.launch && t.prevLaunch !== undefined && t.last === t.launch) { t.launch = t.prevLaunch; t.last = t.prevLast; }
      byTask.set(e.taskId, t);
      continue;
    }
    if (!BAD_EVENTS.has(e.event) && !MOVED_ON_EVENTS.has(e.event)) continue;
    if (e.event === 'launch') { t.prevLaunch = t.launch; t.prevLast = t.last; t.launch = e; }
    t.last = e;
    byTask.set(e.taskId, t);
  }
  const wakes = [];
  for (const [taskId, t] of byTask) {
    const row = t.last;
    if (!row || !isBadRow(row)) continue;
    const age = nowMs - Date.parse(row.ts);
    if (age < minAgeMs || age > maxAgeMs) continue;
    const by = t.launch && t.launch.dispatchedBy;
    if (!by || !by.workspaceId) continue;
    // Key on the task's launch, not the bad row: a blocked-then-parked pair is one wake.
    const key = `${taskId}|${t.launch.ts}`;
    const a = attempts.get(key);
    if (a && (a.sent || a.attempts >= MAX_ATTEMPTS)) continue;
    wakes.push({ key, taskId, event: row.event, ts: row.ts, workspaceId: by.workspaceId, sessionId: by.sessionId || null, message: wakeMessage(row, t.launch.subject, by.sessionId) });
  }
  wakes.sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts));
  return wakes.slice(0, maxPerSweep);
}

/** PURE. Fold the wake-state jsonl rows ({key, outcome: 'attempt'|'sent'}) into Map key -> {attempts, sent}. */
function foldAttempts(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r || !r.key) continue;
    const cur = m.get(r.key) || { attempts: 0, sent: false };
    if (r.outcome === 'attempt') cur.attempts += 1;
    if (r.outcome === 'sent') cur.sent = true;
    m.set(r.key, cur);
  }
  return m;
}

/**
 * PURE. May this wake be typed into that tab right now?
 * workspace: {ref, id, title} from listWorkspacesWithCwd, or undefined. topTsv: `cmux top` output or null.
 * Returns {send:true} or {send:false, why, retry} (retry=false means do not count an attempt).
 */
// A closed tab, a ✅ finished tab, the watchdog tab or a tab with no live Claude each burn one attempt
// (retry:true) rather than giving up at once: one partial cmux listing must not silence a wake for good.
function deliveryDecision({ workspace, topTsv, isWatchdogTitle = () => false, isDoneTitle = () => false, hasLiveClaude, hasRunningClaude }) {
  if (!workspace) return { send: false, why: 'dispatching tab not in the listing', retry: true };
  if (isWatchdogTitle(workspace.title)) return { send: false, why: 'dispatching tab is the watchdog', retry: true };
  if (isDoneTitle(workspace.title)) return { send: false, why: 'dispatching tab is marked done', retry: true };
  if (topTsv == null) return { send: false, why: 'cannot read the tab state', retry: true };
  if (!hasLiveClaude(topTsv)) return { send: false, why: 'no live Claude in the dispatching tab', retry: true };
  if (hasRunningClaude(topTsv)) return { send: false, why: 'dispatching session is mid-turn; next tick', retry: false };
  return { send: true };
}

module.exports = {
  BAD_EVENTS,
  isBadRow,
  MOVED_ON_EVENTS,
  MIN_AGE_MS,
  MAX_AGE_MS,
  MAX_ATTEMPTS,
  MAX_PER_SWEEP,
  NOTICE_PREFIX,
  dispatchedByFromEnv,
  dispatchedByField,
  wakeMessage,
  planDispatcherWakes,
  foldAttempts,
  deliveryDecision,
};
