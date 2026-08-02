/**
 * digest-autofix — the morning digest FIXES issues instead of asking the owner.
 *
 * Owner mandate 2026-08-02 (fifth escalation on this email, verbatim): "Why do
 * I need to hit 'Fix this'. I'm obvi going to hit it for everything here. So
 * why EVEN ASK ME? … Just have a Claude session fix them."
 *
 * The Fix-this button (card #634) was a human finger in front of an already
 * automated pipeline: the button's endpoint files a "BSC Daily: <name>" card
 * and the backlog drain / bsc-next --headless dispatches cards as fix
 * sessions. This module removes the finger: at digest-build time every named
 * health issue gets its card filed (deduped against the shared task list) and
 * the oldest few are dispatched through the EXACT same detached
 * `bsc-next.js --id N --headless` spawn the backlog drain uses
 * (scripts/backlog-drain.js) — one code path, same guards (duplicate lease,
 * dead-dispatch, verify gate), no new dispatch machinery.
 *
 * Safety rails:
 *  - DISPATCH_CAP per digest run (a 14-warning morning queues, never fans out
 *    14 sessions; the drain's own 3 ticks/day keep draining the rest).
 *  - Dedup: an open task whose subject contains "BSC Daily: <name>" (or the
 *    email-worker's "Fix: BSC Daily: <name>" variant) is NEVER re-filed —
 *    same conditionKey idea as api/autonomous-action handleDispatch.
 *  - bsc-next's own refusal guards still apply to every dispatch (this module
 *    deliberately spawns the CLI, never re-implements its checks — the same
 *    reasoning as backlog-drain.js's header comment).
 *  - Everything is fail-soft: a broken create/dispatch degrades that ONE row
 *    to 'card-failed'/'dispatch-attempted', never blocks the email.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(REPO, 'data', 'audit', 'digest-autofix-logs');
const DISPATCH_CAP = 3;

// Which open task (pending/in_progress) already covers this health issue?
// Subject match is deliberately loose-prefixed: the button endpoint files
// "BSC Daily: <name>", the email worker files "Fix: BSC Daily: <name>" — both
// mean "this issue already has an owner-side card"; filing a third helps nobody.
function matchOpenTask(tasks, name) {
  const needle = `BSC Daily: ${name}`;
  return (tasks || []).find(t =>
    t && (t.status === 'pending' || t.status === 'in_progress')
    && String(t.subject || '').includes(needle)) || null;
}

/**
 * Pure planner (CLAUDE.md §15): health rows + extra issues + current tasks →
 * per-issue action plan. No I/O so the digest tests can exercise the real
 * decision table.
 * @returns {Array<{name, message, title, state, taskId}>}
 *   state: 'in-progress' | 'queued' | 'needs-card'
 */
function planAutofix({ health, extraIssues = [], tasks = [] } = {}) {
  const rows = [
    ...(Array.isArray(health?.errors) ? health.errors : []),
    ...(Array.isArray(health?.warns) ? health.warns : []),
    ...extraIssues,
  ].filter(r => r && r.name);
  return rows.map(r => {
    const existing = matchOpenTask(tasks, r.name);
    return {
      name: r.name,
      message: String(r.message || '').slice(0, 400),
      title: `BSC Daily: ${r.name}`,
      state: existing ? (existing.status === 'in_progress' ? 'in-progress' : 'queued') : 'needs-card',
      taskId: existing ? existing.id : null,
    };
  });
}

// Detached headless dispatch — byte-for-byte the backlog drain's pattern
// (stdio to a log file so a refusal is debuggable, unref so the digest exits).
function dispatchDetached(taskId, log) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${taskId}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn('node', [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(taskId), '--headless'],
    { cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  log(`[digest-autofix] dispatch attempted for #${taskId} (headless, detached; log: ${logPath})`);
}

/**
 * File missing cards, refresh the task list, dispatch up to `cap`.
 * Mutates each plan row's state to one of:
 *   'in-progress' | 'dispatched' | 'queued' | 'card-filed' | 'card-failed'
 * and returns the same array (annotated) for the email renderer.
 */
function runAutofix({ plan, cap = DISPATCH_CAP, dryRun = false, log = () => {}, loadTasksFn = null } = {}) {
  if (!Array.isArray(plan) || !plan.length) return [];
  if (dryRun) {
    // Never file cards or spawn sessions on --dry-run — but show what WOULD
    // happen so the preview is honest about the new behavior.
    for (const row of plan) if (row.state === 'needs-card') row.state = 'card-filed';
    let budget = cap;
    for (const row of plan) if (row.state === 'queued' && budget > 0) { row.state = 'dispatched'; budget--; }
    return plan;
  }

  // 1. File missing cards (dedup already done in planAutofix). notion-brain
  //    create is the same card-creation path every session uses; VERIFY line
  //    keeps the card dispatchable through the verify gate (#480) — re-running
  //    the health check IS the acceptance test for a health-row fix.
  let filedAny = false;
  for (const row of plan) {
    if (row.state !== 'needs-card') continue;
    try {
      execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'create', row.title,
        '--priority', 'P2', '--status', 'Not started',
        '--notes', `${row.message}\n\nAuto-filed by the morning digest (Digest v3, owner mandate 2026-08-02: fix automatically, never ask). Fix the underlying issue, then prove it.\n\nVERIFY: node scripts/health-check.js\n\n## Acceptance criteria\n\`node scripts/health-check.js\` no longer lists "${row.name}" among errors or warnings.`,
      ], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
      row.state = 'card-filed';
      filedAny = true;
      log(`[digest-autofix] filed card: ${row.title}`);
    } catch (err) {
      row.state = 'card-failed';
      log(`[digest-autofix] WARN card create failed for "${row.title}": ${String(err.message).slice(0, 120)}`);
    }
  }

  // 2. Sync newly filed cards into the shared task list so they get numbers.
  if (filedAny) {
    try {
      execFileSync('node', [path.join(REPO, 'scripts', 'notion-tasks-sync.js'), 'pull'],
        { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    } catch (err) {
      log(`[digest-autofix] WARN tasks-sync pull failed (cards stay queued for the drain): ${String(err.message).slice(0, 120)}`);
    }
  }

  // 3. Re-resolve task ids and dispatch the first `cap` queued rows. Rows
  //    whose card just got filed pick up their fresh task id here.
  let tasks = [];
  try { tasks = loadTasksFn ? loadTasksFn() : require('../bsc-next.js').loadTasks(); } catch { /* dispatch skipped below */ }
  let budget = cap;
  for (const row of plan) {
    if (row.state === 'in-progress' || row.state === 'card-failed') continue;
    if (!row.taskId) {
      const t = matchOpenTask(tasks, row.name);
      if (t) row.taskId = t.id;
    }
    if (!row.taskId) continue; // sync lag — the drain picks it up on its next tick
    if (budget <= 0) { row.state = 'queued'; continue; }
    try {
      dispatchDetached(row.taskId, log);
      row.state = 'dispatched';
      budget--;
    } catch (err) {
      row.state = 'queued';
      log(`[digest-autofix] WARN dispatch spawn failed for #${row.taskId}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return plan;
}

module.exports = { planAutofix, runAutofix, matchOpenTask, DISPATCH_CAP };
