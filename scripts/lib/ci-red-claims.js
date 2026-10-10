/**
 * ci-red-claims — append-only record of "I am fixing this CI red" claims, so
 * a session can check whether another in_progress task already owns a given
 * failing run/symbol before pushing a fix (task #584, closing the wiring gap
 * left by task #542's evaluateCiRedClaim predicate).
 *
 * Why a file: the shared task list (TaskList/TaskGet/TaskUpdate) is a
 * conversation-scoped tool, not a file — a PreToolUse/pre-push hook is a
 * separate bash process and cannot call it. This ledger is a plain jsonl
 * file any bash process CAN read, following the same append-only pattern as
 * scripts/lib/dispatch-ledger.js (data/audit/*.jsonl, gitignored, Mac-local).
 *
 * Claims expire after CLAIM_TTL_MS so a session that finished (or died)
 * mid-fix doesn't block unrelated future work on the same symbol forever.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Hardcoded for the same reason as dispatch-ledger.js's REPO constant: every
// caller (a hook, a CLI a session runs from inside a worktree) must share
// ONE ledger file, not a worktree-local copy that would defeat the whole
// point of a cross-session claim.
const REPO = '/Users/tompryor/Broadwayscore';
const CLAIMS_PATH = path.join(REPO, 'data', 'audit', 'ci-red-claims.jsonl');

// 2 hours — long enough to cover one session's diagnose-fix-push cycle,
// short enough that a claim from a session that finished or died doesn't
// permanently block someone else from touching the same symbol.
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

function appendClaim({ symbol = null, runId = null, taskId }, claimsPath = CLAIMS_PATH) {
  if (!taskId || (!symbol && !runId)) {
    throw new Error('ci-red-claims entry requires taskId and at least one of symbol/runId');
  }
  const line = { ts: new Date().toISOString(), symbol, runId, taskId: String(taskId) };
  fs.mkdirSync(path.dirname(claimsPath), { recursive: true });
  fs.appendFileSync(claimsPath, JSON.stringify(line) + '\n');
  return line;
}

// Corrupt lines (partial write from a crash) are skipped, never fatal — same
// invariant as dispatch-ledger.js's readEntries.
function readClaims(claimsPath = CLAIMS_PATH) {
  let raw;
  try { raw = fs.readFileSync(claimsPath, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// Adapts raw ledger entries into the task-like shape
// scripts/lib/duplicate-dispatch-guard.js's evaluateCiRedClaim expects
// ({id, status, subject, description}) — it matches via substring search
// over subject+description, so folding symbol/runId into subject is
// sufficient. Expired claims (older than CLAIM_TTL_MS) are dropped here so
// callers never see a stale claim as active.
//
// excludeTaskId drops the caller's OWN prior claim from the result. Without
// this, a session that claims a symbol and later re-checks it sees its own
// claim as a conflict and gets a false REFUSE (adversarial review finding,
// task #584) — the whole point is to detect OTHER sessions' claims.
function activeClaimsAsTasks(claimsPath = CLAIMS_PATH, now = Date.now(), excludeTaskId = null) {
  return readClaims(claimsPath)
    .filter(c => now - new Date(c.ts).getTime() < CLAIM_TTL_MS)
    .filter(c => excludeTaskId == null || String(c.taskId) !== String(excludeTaskId))
    .map(c => ({
      id: c.taskId,
      status: 'in_progress',
      subject: [c.symbol, c.runId].filter(Boolean).join(' '),
      description: '',
    }));
}

module.exports = { CLAIMS_PATH, CLAIM_TTL_MS, appendClaim, readClaims, activeClaimsAsTasks };
