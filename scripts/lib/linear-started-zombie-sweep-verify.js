'use strict';

/**
 * linear-started-zombie-sweep-verify.js — verify-driven decision for BRO-4510.
 *
 * linear-started-zombie-sweep.js's decideZombieReset refused every real
 * candidate (0 resets in 1,369 tries, 2026-09-23..10-01): "worktree gone" is
 * the EXPECTED state for a DONE job, and any comment that was not a session
 * report counted as "human" even though every machine comment is posted under
 * the owner's API key. It also moved cards to Backlog, which wastes a paid
 * session on a card whose work already landed (BRO-4487 triage: 67 of 186
 * stuck P0/P1 cards were provably done, 73 were not).
 *
 * This module decides from the card's own acceptance command instead:
 *   VERIFY passes on main (and a commit names the card) -> done
 *   VERIFY fails twice in a row, not an environment failure -> todo (re-dispatch)
 *   no safe-form VERIFY / unrunnable / first failure       -> leave
 * Anything that looks typed by a person within HUMAN_FRESH_MS blocks the
 * state change (BRO-3376: never touch a card someone is visibly on).
 *
 * Pure: the caller (bsc-reconcile.js sweepLinearStartedZombies) does every
 * fetch/fs/git/Linear call and hands in `runVerifyFn` / `commitOnMainFn`.
 */

const { parseSessionReportStatus } = require('./linear-session-reporting.js');
const { DISPATCH_COMMENT_CORRELATION_RE, isCompletePrEvidence } = require('./linear-dispatch.js');
const { BYPASS_LINE_PREFIX } = require('./linear-gate-bypass-ledger.js');
const { evaluateVerifiability } = require('./verify-gate.js');
const { ZOMBIE_RESET_MARKER, COMMENT_PAGE_CAP, sortedComments } = require('./linear-started-zombie-sweep.js');

// A person on the thread this recently blocks any state change. Older
// unclassified comments (typically the dispatched worker's own free-form
// write-up, e.g. "Already fixed and merged to main") do not.
const HUMAN_FRESH_MS = 24 * 3600 * 1000;
// A FAIL must be seen on this many consecutive sweep ticks (same dispatch)
// before a card is moved to Todo: one FAIL can be a flaky/partial checkout.
const FAILS_BEFORE_TODO = 2;
const FAIL_STRIKE_MIN_GAP_MS = 3600 * 1000;
// Todo moves per card across ALL dispatches — stops Todo -> redispatch ->
// DONE-without-report -> Todo cycles (the park hash is per-jobId so it
// cannot catch these).
const MAX_TODO_RESETS_PER_CARD = 2;

// Environment (not card) failures that runVerify reports as plain FAIL.
const ENV_FAILURE_RE = /ENOENT|Cannot find module|MODULE_NOT_FOUND|no such file or directory/i;

/**
 * @returns {'own-reset'|'report'|'machine'|'unclassified'}
 */
function classifyZombieComment(body) {
  const text = String(body || '');
  if (text.includes(ZOMBIE_RESET_MARKER)) return 'own-reset';
  const trimmed = text.trim();
  if (parseSessionReportStatus(trimmed) || isCompletePrEvidence(trimmed)) return 'report';
  if (DISPATCH_COMMENT_CORRELATION_RE.test(trimmed)
    || trimmed.startsWith(BYPASS_LINE_PREFIX)
    || /^\*\*Re-arm \(auto\b/.test(trimmed)) return 'machine';
  return 'unclassified';
}

/** Order-independent scan of every comment posted after spawn. */
function scanThreadSinceSpawn(issue, spawnedTs, nowMs) {
  const nodes = (issue && issue.comments && issue.comments.nodes) || [];
  const out = { truncated: nodes.length >= COMMENT_PAGE_CAP, reported: false, ownReset: false, humanFresh: false };
  for (const c of sortedComments(issue)) {
    const ts = String((c && c.createdAt) || '');
    if (!(ts > spawnedTs)) continue;
    const kind = classifyZombieComment(c && c.body);
    if (kind === 'own-reset') out.ownReset = true;
    else if (kind === 'report') out.reported = true;
    else if (kind === 'unclassified') {
      const at = Date.parse(ts);
      // Unparseable ts: cannot prove it is old, so treat as fresh.
      if (!Number.isFinite(at) || nowMs - at < HUMAN_FRESH_MS) out.humanFresh = true;
    }
  }
  return out;
}

// git log -P pattern for "a commit names this card": bounded on both sides so
// BRO-44 never matches BRO-447 / XBRO-44.
function commitGrepPattern(identifier) {
  return `(?<![A-Za-z0-9-])${String(identifier).replace(/[^A-Za-z0-9-]/g, '')}(?![0-9])`;
}

function countPriorTodoResets(ledgerEntries, cardId) {
  return (ledgerEntries || []).filter((e) => e && e.cardId === cardId && e.event === 'card-pass' && e.action === 'todo').length;
}

// Consecutive FAIL strikes for this dispatch: the trailing run of 'verify-fail'
// rows, broken by any other row for the same card+job (a pass / leave in
// between resets the streak). Only strikes at least FAIL_STRIKE_MIN_GAP_MS old
// count, so a budget carry that re-verifies the same card minutes later cannot
// turn one flaky FAIL into the second strike.
function countVerifyFails(ledgerEntries, cardId, jobId, nowMs = Date.now()) {
  const rows = (ledgerEntries || []).filter((e) => e && e.cardId === cardId && e.jobId === jobId);
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].event !== 'verify-fail') break;
    const at = Date.parse(rows[i].ts);
    if (Number.isFinite(at) && nowMs - at < FAIL_STRIKE_MIN_GAP_MS) continue; // too recent to be a separate strike
    n++;
  }
  return n;
}

/**
 * @param {object} p
 * @param {object} p.issue fetched Linear issue ({identifier, description, state, comments})
 * @param {string|null} p.spawnedTs
 * @param {{exists:boolean, dirty?:boolean, aheadCount?:number|null, error?:boolean}} p.worktree
 * @param {boolean} p.live
 * @param {number} p.nowMs
 * @param {(cmd:string)=>{status:'pass'|'fail'|'unverifiable', detail?:string}} p.runVerifyFn only called when every cheap guard passed
 * @param {()=>boolean} p.commitOnMainFn true when a commit on main names the card
 * @param {number} [p.priorTodoResets]
 * @param {number} [p.priorVerifyFails] consecutive FAILs already ledgered for THIS dispatch
 * @returns {{action:'skip'|'refuse'|'leave'|'done'|'todo', reason:string, cmd?:string, detail?:string}}
 */
function decideZombieAction({
  issue, spawnedTs, worktree, live, nowMs, runVerifyFn, commitOnMainFn,
  priorTodoResets = 0, priorVerifyFails = 0,
} = {}) {
  if (!(issue && issue.state && issue.state.type === 'started')) return { action: 'skip', reason: 'not-started' };
  if (!spawnedTs) return { action: 'refuse', reason: 'no-spawned-ts' };

  const thread = scanThreadSinceSpawn(issue, spawnedTs, nowMs);
  if (thread.reported) return { action: 'skip', reason: 'already-reported' };
  // The newest comments are the ones a truncated page hides (fresh human hold,
  // session report, our own marker): no state change on an incomplete thread.
  if (thread.truncated) return { action: 'refuse', reason: 'comment-history-truncated' };
  if (thread.ownReset) return { action: 'refuse', reason: 'own-reset-attempt-unconfirmed' };
  if (thread.humanFresh) return { action: 'refuse', reason: 'human-comment-recent' };

  // "Worktree gone" is the expected DONE state and is allowed. A worktree that
  // still exists must be provably clean, pushed and idle.
  if (worktree && worktree.exists !== false) {
    if (worktree.error || worktree.dirty || worktree.aheadCount !== 0) return { action: 'refuse', reason: 'worktree-unsafe' };
    if (live) return { action: 'refuse', reason: 'live-process' };
  }

  const verifiability = evaluateVerifiability(
    issue.description || '',
    sortedComments(issue).map((c) => (c && c.body) || ''),
  );
  if (!verifiability.cmd) return { action: 'leave', reason: 'no-safe-verify' };
  const cmd = verifiability.cmd;

  const result = runVerifyFn(cmd) || { status: 'unverifiable' };
  if (result.status === 'pass') {
    if (!commitOnMainFn()) return { action: 'leave', reason: 'verify-pass-no-commit-names-card', cmd };
    return { action: 'done', reason: 'verify-passes-on-main', cmd };
  }
  if (result.status !== 'fail') return { action: 'leave', reason: 'verify-unverifiable', cmd, detail: result.detail };
  if (ENV_FAILURE_RE.test(result.detail || '')) return { action: 'leave', reason: 'verify-env-failure', cmd, detail: result.detail };
  if (priorVerifyFails + 1 < FAILS_BEFORE_TODO) return { action: 'leave', reason: 'verify-failed-first-strike', cmd, detail: result.detail };
  if (priorTodoResets >= MAX_TODO_RESETS_PER_CARD) return { action: 'refuse', reason: 'reset-loop', cmd };
  return { action: 'todo', reason: 'verify-fails-on-main', cmd, detail: result.detail };
}

// Both write-back comments carry ZOMBIE_RESET_MARKER: linear-brain.js posts the
// comment BEFORE the state move, so a half-failed write must be recognisable
// on the next tick (decideZombieAction -> own-reset-attempt-unconfirmed).
function buildZombieActionComment({ action, identifier, jobId, cmd, sha } = {}) {
  const head = `${ZOMBIE_RESET_MARKER}: ${identifier}'s most recent dispatch (job ${jobId || '(unknown)'}) finished cleanly but never reported back.`;
  if (action === 'done') {
    return `${head} Its acceptance command passes on origin/main${sha ? ` @ ${String(sha).slice(0, 9)}` : ''} and a commit on main names the card, so it is closed as Done.\nVERIFY: ${cmd}`;
  }
  return `${head} Its acceptance command fails on origin/main on two consecutive sweeps, so the work did not land. Moved to Todo so the watchdog re-dispatches it.\nFailing command: ${cmd}`;
}

// The CLI, never an import: linear-brain.js's Done gate can process.exit(5),
// which no try/catch here could intercept. Never passes --force.
function applyZombieAction({ action, identifier, comment }, { spawnSyncFn = require('child_process').spawnSync, cwd = process.cwd() } = {}) {
  const state = action === 'done' ? 'Done' : 'Todo';
  const r = spawnSyncFn('node', ['scripts/linear-brain.js', 'update', identifier, '--state', state, '--comment', comment], {
    cwd, encoding: 'utf8', timeout: 300000,
  });
  return { ok: r.status === 0, status: r.status, stderr: String(r.stderr || '').trim().slice(-400) };
}

module.exports = {
  decideZombieAction,
  classifyZombieComment,
  scanThreadSinceSpawn,
  commitGrepPattern,
  countPriorTodoResets,
  countVerifyFails,
  buildZombieActionComment,
  applyZombieAction,
  HUMAN_FRESH_MS,
  FAILS_BEFORE_TODO,
  FAIL_STRIKE_MIN_GAP_MS,
  MAX_TODO_RESETS_PER_CARD,
};
