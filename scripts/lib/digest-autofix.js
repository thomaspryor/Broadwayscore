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

// Some health rows self-document that they're already tracked, owner-accepted,
// and expected to clear on their own by a known date — the shared suffix shape
// emitted by scripts/lib/scrapingbee-ack.js / scrapingdog-ack.js:
// " — acknowledged: <reason> [expires YYYY-MM-DD]". Those rows stay 'warn'
// (by design — see task #367/#353) until the stamped date, so a P1 "fix this"
// card filed against them can never mechanically resolve before then; it's
// pure noise on top of the acknowledgment that already exists (task #804
// duplicated the already-closed #224 this exact way; #803 is the ScrapingDog
// cousin). Skip card-filing for these while the ack is still live.
const ACKNOWLEDGED_ROW_RE = /acknowledged:.*\[expires\s+(\d{4}-\d{2}-\d{2})\]/i;

function isRowAcknowledged(message, today) {
  const m = ACKNOWLEDGED_ROW_RE.exec(String(message || ''));
  if (!m) return false;
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return m[1] > todayDate;
}

/**
 * Pure planner (CLAUDE.md §15): health rows + extra issues + current tasks →
 * per-issue action plan. No I/O so the digest tests can exercise the real
 * decision table.
 * @returns {Array<{name, message, title, state, taskId}>}
 *   state: 'in-progress' | 'queued' | 'needs-card' | 'acknowledged'
 */
function planAutofix({ health, extraIssues = [], tasks = [], today } = {}) {
  const rows = [
    ...(Array.isArray(health?.errors) ? health.errors : []),
    ...(Array.isArray(health?.warns) ? health.warns : []),
    ...extraIssues,
  ].filter(r => r && r.name);
  return rows.map(r => {
    const existing = matchOpenTask(tasks, r.name);
    // Check the ack marker against the FULL text first — 400-char truncation
    // could otherwise sever a long reason's trailing "[expires ...]" token
    // and silently revert an acknowledged row to needs-card (ship-check P2).
    const rawMessage = String(r.message || '');
    const acknowledged = !existing && isRowAcknowledged(rawMessage, today);
    const message = rawMessage.slice(0, 400);
    const title = `BSC Daily: ${r.name}`;
    if (acknowledged) {
      return { name: r.name, message, title, state: 'acknowledged', taskId: null };
    }
    return {
      name: r.name,
      message,
      title,
      state: existing ? (existing.status === 'in_progress' ? 'in-progress' : 'queued') : 'needs-card',
      taskId: existing ? existing.id : null,
    };
  });
}

// Row text comes from health-check output (semi-trusted: workflow names and
// scraped strings can leak in). extractVerifyCmd treats the FIRST
// "## Acceptance criteria" section / any "VERIFY:" line / backticked span in
// the notes as the card's executable proof, so hostile row text could inject
// its own safe-but-unrelated command (Codex finding, 2026-08-02). Neutralize
// the three carriers before interpolating.
function sanitizeRowText(s) {
  return String(s || '')
    .replace(/`/g, "'")
    .replace(/^#+\s/gm, '')
    .replace(/VERIFY\s*:/gi, 'VERIFY -');
}

// The b64url token must fit SAFE_CHECK_FORMS' 200-char cap AND decode back to
// exactly what check-health-row-absent.js compares — so BOTH sides slice the
// row name to the same bound (120 chars ≈ ≤160 b64 chars even for multi-byte).
const ROW_NAME_MATCH_LIMIT = 120;

// Card notes must pass notion-brain's card-quality gate for "Not started"
// cards: ## Problem + ## Suggested approach + ## Acceptance criteria sections
// and >=300 chars (the gate rejected the first live send's shorter format).
function buildCardNotes(row) {
  const name = sanitizeRowText(row.name);
  const message = sanitizeRowText(row.message);
  return [
    '## Problem',
    `The daily health check (\`node scripts/health-check.js\`) reports an issue named "${name}": ${message || '(no detail message — reproduce locally for specifics)'}`,
    '',
    '## Evidence',
    `Auto-filed by the morning digest (Digest v3, owner mandate 2026-08-02: fix automatically, never ask). The row appeared in today's health-check errors/warnings; the message above is the check's own output.`,
    '',
    '## Suggested approach',
    `Run \`node scripts/health-check.js\` to reproduce, then grep scripts/health-check.js for the check that emits "${row.name}" to find the underlying data source or workflow. Fix the root cause (not the check), and include prevention per CLAUDE.md.`,
    '',
    '## Acceptance criteria',
    // The backticked command is the machine-checkable proof bsc-next's verify
    // gate arms and the nightly acceptance recheck re-runs. base64url keeps
    // the row name a single token (SAFE_CHECK_FORMS + quote-free argv split).
    // Encode the RAW name (the checker compares against raw snapshot names);
    // only prose gets sanitized. Slice matches the checker's own bound.
    `\`node scripts/check-health-row-absent.js --row-b64 ${Buffer.from(String(row.name).trim().slice(0, ROW_NAME_MATCH_LIMIT), 'utf8').toString('base64url')}\` passes — i.e. the daily health check no longer lists "${name}" among errors or warnings.`,
  ].join('\n');
}

// Detached headless dispatch — byte-for-byte the backlog drain's pattern
// (stdio to a log file so a refusal is debuggable, unref so the digest exits).
function dispatchDetached(taskId, log, delaySec = 0) {
  // Validate BEFORE opening the log fd — throwing after openSync leaked a
  // file descriptor per rejected dispatch (Codex review, 2026-08-02).
  const idNumEarly = Number(taskId);
  if (!Number.isSafeInteger(idNumEarly) || idNumEarly <= 0) throw new Error(`invalid taskId for dispatch: ${String(taskId).slice(0, 40)}`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${taskId}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  // Staggered start: simultaneous detached spawns race on the main repo's
  // `git worktree add` lock and all but one die 'worktree-error' (live-run
  // finding 2026-08-02: 3 same-instant dispatches → 2 failed). taskId is
  // numeric and delaySec is internal, so the sh -c line is injection-safe.
  // Codex hardening (2026-08-02): validate the id as a real integer (parseInt
  // silently truncates junk), and pass the script path as a positional shell
  // arg instead of interpolating it (JSON.stringify is NOT shell quoting —
  // $() would survive inside double quotes).
  const id = String(idNumEarly);
  const cmd = `sleep ${Math.max(0, Math.floor(delaySec))} && exec node "$1" --id ${id} --headless`;
  const child = spawn('sh', ['-c', cmd, 'sh', path.join(REPO, 'scripts', 'bsc-next.js')],
    { cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  log(`[digest-autofix] dispatch attempted for #${id} (headless, detached, +${delaySec}s stagger; log: ${logPath})`);
}

/**
 * File missing cards, refresh the task list, dispatch up to `cap`.
 * Mutates each plan row's state to one of:
 *   'in-progress' | 'dispatched' | 'queued' | 'card-filed' | 'card-failed'
 *   | 'acknowledged' (left untouched — no card, no dispatch)
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
      // P1, not P2: notion-tasks-sync pull mirrors ONLY P0/P1 cards into the
      // shared task list — a P2 card never gets a task number, so it can
      // never dispatch and gets re-filed as a duplicate every morning
      // (live-run finding 2026-08-02). P1 also matches the owner rule that
      // P0/P1 auto-dispatch at creation.
      execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'create', row.title,
        '--priority', 'P1', '--status', 'Not started',
        '--notes', buildCardNotes(row),
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
  try {
    if (loadTasksFn) tasks = loadTasksFn();
    else {
      // loadTasks REQUIRES the shared task directory — calling it bare returns
      // [] silently (readdirSync(undefined) is swallowed), which killed both
      // dedup and dispatch on the first live run (Codex finding, 2026-08-02).
      const bn = require('../bsc-next.js');
      tasks = bn.loadTasks(bn.TASKS_DIR);
    }
  } catch { /* dispatch skipped below */ }
  let budget = cap;
  for (const row of plan) {
    if (row.state === 'in-progress' || row.state === 'card-failed' || row.state === 'acknowledged') continue;
    if (!row.taskId) {
      const t = matchOpenTask(tasks, row.name);
      if (t) row.taskId = t.id;
    }
    if (!row.taskId) continue; // sync lag — the drain picks it up on its next tick
    if (budget <= 0) { row.state = 'queued'; continue; }
    try {
      dispatchDetached(row.taskId, log, (cap - budget) * 45);
      row.state = 'dispatched';
      budget--;
    } catch (err) {
      row.state = 'queued';
      log(`[digest-autofix] WARN dispatch spawn failed for #${row.taskId}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return plan;
}

module.exports = { planAutofix, runAutofix, matchOpenTask, buildCardNotes, isRowAcknowledged, DISPATCH_CAP };
