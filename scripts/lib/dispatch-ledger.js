/**
 * dispatch-ledger — append-only record of cmux auto-dispatch attempts, so
 * bsc-next / bsc-prune can tell "this task has already died here" from "this
 * is a fresh dispatch" instead of blind re-dispatching forever.
 *
 * Task #334 (2026-07-22): task #297 accumulated THREE dead cmux workspaces
 * (workspace:227/229/234, "Terminal surface not found") because nothing
 * recorded that all three launches were onto the same task, and a session
 * killed at the #289 >30min timeout never runs the Stop hook's ✅ self-mark
 * (that mark only exists on the SUCCESS path — see #154). bsc-next.js
 * appends a 'launch' entry on every verified dispatch; bsc-prune.js appends
 * a 'dead' entry the first time its idle-unmarked sweep finds a launched
 * workspace with no live claude process and no ✅ (the missing failure
 * breadcrumb). bsc-next.js then refuses a further blind dispatch once a
 * task has DEAD_ATTEMPT_LIMIT dead entries, instead of opening a 3rd/4th/5th
 * dead shell on the same task.
 *
 * Ledger: data/audit/dispatch-ledger.jsonl (gitignored, Mac-local — same
 * append-only-jsonl pattern as autonomous-ledger.jsonl). Never rewritten.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Hardcoded (not path.join(__dirname, '..', '..')) on purpose: both callers
// of this module (bsc-next.js, bsc-prune.js) are interactive tools an owner
// routinely runs from inside a worktree (this session included) — a
// __dirname-relative REPO would resolve to that worktree's own
// scripts/lib/, splitting the ledger into a worktree-local copy instead of
// the single canonical file every dispatch/sweep needs to share. Same fix
// bsc-next.js already applies to its own REPO/QUEUE_PATH, with the same
// rationale in its header comment. (autonomous-ledger.js gets away with the
// relative pattern because autonomous-run.js only ever runs from the
// canonical checkout via launchd — never from a worktree.)
const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER_PATH = path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl');

// A task with this many recorded 'dead' entries blocks further blind
// dispatch (bsc-next's deadDispatchGuard) until the owner investigates or
// passes --force. 2 = the 3rd dispatch attempt is the one that gets refused,
// matching the real incident (2 dead shells already existed when the 3rd
// was opened).
const DEAD_ATTEMPT_LIMIT = 2;

function appendEntry(entry, ledgerPath = LEDGER_PATH) {
  if (!entry || typeof entry.event !== 'string' || !entry.event || !entry.taskId) {
    throw new Error('dispatch-ledger entry requires an event string and a taskId');
  }
  const line = { ts: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
  return line;
}

// Corrupt lines (partial write from a crash) are skipped, never fatal — the
// ledger must stay readable after any crash, same invariant as
// autonomous-ledger.js's readEntries.
function readEntries(ledgerPath = LEDGER_PATH) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); }
  catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return entries;
}

function deadAttemptsForTask(taskId, entries) {
  return entries.filter(e => e.event === 'dead' && String(e.taskId) === String(taskId));
}

function launchByRef(workspaceRef, entries) {
  return entries.find(e => e.event === 'launch' && e.workspaceRef === workspaceRef) || null;
}

// Cross-reference bsc-prune's idle (no live claude, un-✅-marked) workspaces
// against the ledger's launch records, and return the NEW 'dead' breadcrumbs
// to append — one per idle workspace that (a) was actually launched by
// bsc-next.js and (b) doesn't already have a recorded death. Idempotent
// across repeated bsc-prune runs: a workspace only ever contributes one dead
// breadcrumb, however many times the sweep re-scans it.
function deadBreadcrumbs(idleWorkspaces, entries) {
  const alreadyDead = new Set(
    entries.filter(e => e.event === 'dead').map(e => e.workspaceRef)
  );
  const out = [];
  for (const w of idleWorkspaces) {
    if (alreadyDead.has(w.ref)) continue;
    const launch = launchByRef(w.ref, entries);
    if (!launch) continue; // not a bsc-next auto-dispatch — not ours to journal
    out.push({ event: 'dead', taskId: launch.taskId, subject: launch.subject, workspaceRef: w.ref, title: w.title });
  }
  return out;
}

module.exports = {
  LEDGER_PATH, DEAD_ATTEMPT_LIMIT,
  appendEntry, readEntries, deadAttemptsForTask, launchByRef, deadBreadcrumbs,
};
