'use strict';

/**
 * dispatch-dead-launch-guard — refuse to let a task be marked 'completed'
 * when its most recent dispatch attempt never actually ran.
 *
 * Card #1144: a task's dispatch died (bsc-next.js's failedLaunchEntries()
 * journaled it dead in dispatch-ledger.jsonl — see task #1140's real
 * incident), yet the task showed up [completed] in the shared task list
 * minutes later. No hook or script in this repo writes task status directly
 * (workspace-mark-done.js only renames cmux tab titles; bsc-prune.js's
 * parkCard only sets Notion status to Paused) — that only happens via the
 * harness's TaskUpdate tool, called by a live session, and nothing
 * intercepted it. This module is the decision half of the mechanical
 * backstop: guardTaskCompletion() is meant to be consulted by a PreToolUse
 * hook on TaskUpdate BEFORE the write lands; reconcileDeadCompletions() is
 * meant to be run by a reconciler script AFTER, for anything that bypasses
 * the hook (a cloud session with no ~/.claude/hooks, a long-running session
 * that started before the hook was registered, a --force override).
 *
 * The actual dead/alive classification lives in dispatch-ledger.js
 * (isLatestDispatchDead) — this file is deliberately thin: it turns that
 * ledger-level fact into the two TaskUpdate-shaped decisions above, without
 * re-deriving or duplicating the event-vocabulary logic (second-opinion
 * review, card #1144 plan phase).
 *
 * Pure — no I/O (rule 15: callers do the file/ledger reads; the required
 * test require()s this directly instead of copying the decision logic in).
 */

const { isLatestDispatchDead } = require('./dispatch-ledger.js');
// notionIdOf already parses the "[notion:<id>] ..." marker notion-tasks-sync
// writes into a mirrored task's description (dispatch-watchdog-core.js) —
// reused rather than re-implementing the same regex a third place (card #1157).
const { notionIdOf } = require('./dispatch-watchdog-core.js');

// Decision for a completion attempt (a TaskUpdate-shaped {taskId, status}
// plus the ledger entries already read from disk). Non-'completed' statuses
// are always allowed — this guard has nothing to say about pending/
// in_progress transitions.
function guardTaskCompletion({ taskId, status, entries }) {
  if (status !== 'completed') return { block: false };
  if (!isLatestDispatchDead(taskId, entries)) return { block: false };
  return {
    block: true,
    reason: `task #${taskId}'s most recent dispatch attempt never actually launched `
      + `(journaled dead in dispatch-ledger.jsonl) — no session ran to do this work. `
      + `Re-dispatch it (node scripts/bsc-next.js --id ${taskId} --force) or fix the `
      + `launch failure before marking it completed.`,
  };
}

// A task a human/session has explicitly certified done by out-of-band means
// (task #1697: e.g. its own Notion page 404s permanently, but the
// underlying work was independently confirmed complete under a different
// card) rather than through a normal dispatch. Requires BOTH fields (not
// either alone) — same all-or-nothing shape as the manual review-protection
// fields (memory: feedback_manual_review_protection_fields.md): Reason alone
// has no timestamp to hang a future staleness check on, At alone has no
// audit trail for why the safety net was bypassed. Deliberately NOT
// consulted by guardTaskCompletion() — that guard has no task object, only
// {taskId, status, entries}, so it can't see these fields; manual resolution
// stays a JSON-hand-edit side channel, not a first-class TaskUpdate path.
function isManuallyResolved(task) {
  return Boolean(
    String(task?.manuallyResolvedReason || '').trim()
    && String(task?.manuallyResolvedAt || '').trim()
  );
}

// Tasks that are ALREADY marked 'completed' but whose latest dispatch is
// dead — the reconciler's input. `tasks` is the shape loadTasks() already
// produces ({id, status, subject, ...}). notionId (card #1157) lets the
// caller also correct the mirrored Notion card's status — a dead-completed
// task whose description carries notion-tasks-sync's "[notion:<id>] ..."
// marker had its card pushed to "Done" by notion-tasks-sync push BEFORE the
// dead dispatch was discovered; null for native (non-mirrored) tasks.
function reconcileDeadCompletions(tasks, entries) {
  return (tasks || [])
    .filter((t) => t && t.status === 'completed' && !isManuallyResolved(t) && isLatestDispatchDead(t.id, entries))
    .map((t) => ({ id: t.id, subject: t.subject || null, notionId: notionIdOf(t) }));
}

// Whether a Notion card's CURRENT status should be corrected back off "Done"
// when its mirrored task is reopened. Read-then-check (rather than writing
// unconditionally) so a card the owner has since re-triaged by hand isn't
// clobbered (card #1157).
function shouldCorrectNotionStatus(currentStatus) {
  return currentStatus === 'Done';
}

module.exports = { guardTaskCompletion, reconcileDeadCompletions, shouldCorrectNotionStatus, isManuallyResolved };
