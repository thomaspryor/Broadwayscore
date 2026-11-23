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

const BAD_EVENTS = new Set(['job-failed', 'job-stranded', 'job-blocked', 'job-stopped-short', 'watchdog-park']);
// Rows that mean the task moved on after a bad row: re-dispatched, retried, finished or landed.
const MOVED_ON_EVENTS = new Set(['launch', 'job-spawned', 'job-retried', 'job-done', 'landed-acked', 'landed-before-dispatch', 'landed-outside-dispatch']);
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
function wakeMessage(row, subject) {
  const card = cardLabel(row.taskId);
  const title = subject ? ` ("${String(subject).replace(/^BRO-\d+\s+/, '').slice(0, 90)}")` : '';
  const at = String(row.ts || '').slice(11, 16);
  return `${NOTICE_PREFIX} The job you dispatched for ${card}${title} ended ${row.event} at ${at}Z without landing: ${nextStep(row, card)}.`.replace(/\s*\n\s*/g, ' ');
}

/**
 * PURE. entries: dispatch-ledger rows (any order). attempts: Map key -> {attempts, sent}.
 * Returns [{key, taskId, event, workspaceId, sessionId, message}] newest first, capped.
 */
function planDispatcherWakes(entries, { attempts = new Map(), nowMs = Date.now(), minAgeMs = MIN_AGE_MS, maxAgeMs = MAX_AGE_MS, maxPerSweep = MAX_PER_SWEEP } = {}) {
  const byTask = new Map();
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && e.taskId && e.ts && !Number.isNaN(Date.parse(e.ts)));
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const e of rows) {
    if (!BAD_EVENTS.has(e.event) && !MOVED_ON_EVENTS.has(e.event)) continue;
    const t = byTask.get(e.taskId) || { last: null, launch: null };
    t.last = e;
    if (e.event === 'launch') t.launch = e;
    byTask.set(e.taskId, t);
  }
  const wakes = [];
  for (const [taskId, t] of byTask) {
    const row = t.last;
    if (!row || !BAD_EVENTS.has(row.event)) continue;
    const age = nowMs - Date.parse(row.ts);
    if (age < minAgeMs || age > maxAgeMs) continue;
    const by = t.launch && t.launch.dispatchedBy;
    if (!by || !by.workspaceId) continue;
    // Key on the task's launch, not the bad row: a blocked-then-parked pair is one wake.
    const key = `${taskId}|${t.launch.ts}`;
    const a = attempts.get(key);
    if (a && (a.sent || a.attempts >= MAX_ATTEMPTS)) continue;
    wakes.push({ key, taskId, event: row.event, ts: row.ts, workspaceId: by.workspaceId, sessionId: by.sessionId || null, message: wakeMessage(row, t.launch.subject) });
  }
  wakes.sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts));
  return wakes.slice(0, maxPerSweep);
}

/** PURE. Fold the wake-state jsonl rows ({key, outcome: 'attempt'|'sent'|'gone'}) into Map key -> {attempts, sent}. */
function foldAttempts(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r || !r.key) continue;
    const cur = m.get(r.key) || { attempts: 0, sent: false };
    if (r.outcome === 'attempt') cur.attempts += 1;
    // 'gone': the dispatching tab closed or no longer runs Claude; nothing left to wake.
    if (r.outcome === 'sent' || r.outcome === 'gone') cur.sent = true;
    m.set(r.key, cur);
  }
  return m;
}

/**
 * PURE. May this wake be typed into that tab right now?
 * workspace: {ref, id, title} from listWorkspacesWithCwd, or undefined. topTsv: `cmux top` output or null.
 * Returns {send:true} or {send:false, why, retry} (retry=false means do not count an attempt).
 */
function deliveryDecision({ workspace, topTsv, isWatchdogTitle = () => false, hasLiveClaude, hasRunningClaude }) {
  if (!workspace) return { send: false, why: 'dispatching tab is closed', retry: false, gone: true };
  if (isWatchdogTitle(workspace.title)) return { send: false, why: 'dispatching tab is the watchdog', retry: false, gone: true };
  if (topTsv == null) return { send: false, why: 'cannot read the tab state', retry: true };
  if (!hasLiveClaude(topTsv)) return { send: false, why: 'no live Claude in the dispatching tab', retry: false, gone: true };
  if (hasRunningClaude(topTsv)) return { send: false, why: 'dispatching session is mid-turn; next tick', retry: false };
  return { send: true };
}

module.exports = {
  BAD_EVENTS,
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
