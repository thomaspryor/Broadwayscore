'use strict';

/**
 * linear-dead-completion-source.js — Linear as a second candidate source for
 * reconcile-dead-completions.js (BRO-3431).
 *
 * reconcile-dead-completions.js's reconcileDeadCompletions() only ever
 * scanned the local ~/.claude/tasks Notion-mirror task files for
 * status === 'completed'. A Linear-dispatched job (scripts/linear-next.js)
 * never writes a mirror file at all — it is tracked purely by
 * dispatch-ledger.jsonl 'launch' entries carrying `taskId: "linear:BRO-N"`
 * (linear-watchdog-source.js's LINEAR_TASK_PREFIX) — so a Linear job that
 * died at launch had no path back to a reopened issue: correctNotionCard()
 * shells out to notion-brain.js, with nothing analogous for Linear.
 *
 * Rather than query Linear for every issue in a completed state (unbounded —
 * linear-recheck-source.js's header explains why that population grows
 * without bound and was deliberately excluded there), candidates are derived
 * from the ledger itself: any `linear:` taskId whose latest dispatch attempt
 * is dead is a candidate worth a single live state check. Bounded by ledger
 * activity, not by the whole board's history.
 *
 * findLinearDeadLaunchCandidates is PURE (no I/O) — the caller does the
 * live Linear fetch to confirm the issue is ACTUALLY sitting completed
 * before touching anything (same read-then-check discipline
 * correctNotionCard() already uses via shouldCorrectNotionStatus).
 */

const { parseLinearTaskId } = require('./linear-watchdog-source.js');
const { isLatestDispatchDead, resolveDeadAttempt } = require('./dispatch-ledger.js');

/**
 * @param {Array<object>} entries dispatch-ledger.jsonl entries
 * @returns {Array<{taskId: string, identifier: string, deadAttemptTs: string|null}>}
 *   one row per distinct linear: taskId whose latest dispatch attempt is
 *   dead — NOT filtered by the issue's current Linear state (the caller
 *   must fetch that live; see header).
 */
function findLinearDeadLaunchCandidates(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const taskIds = new Set();
  for (const e of list) {
    const identifier = parseLinearTaskId(e && e.taskId);
    if (identifier) taskIds.add(String(e.taskId));
  }
  const out = [];
  for (const taskId of taskIds) {
    if (!isLatestDispatchDead(taskId, list)) continue;
    const deadAttempt = resolveDeadAttempt(taskId, list);
    out.push({
      taskId,
      identifier: parseLinearTaskId(taskId),
      deadAttemptTs: (deadAttempt && deadAttempt.ts) || null,
    });
  }
  return out;
}

/**
 * Whether a live Linear issue fetched for a candidate should be reopened.
 * Read-then-check (mirrors shouldCorrectNotionStatus): only an issue
 * CURRENTLY sitting in a completed-type state is touched — one the owner
 * has since re-triaged by hand (e.g. back to In Progress) is left alone.
 */
function shouldReopenLinearIssue(issue) {
  return Boolean(issue && issue.state && issue.state.type === 'completed');
}

module.exports = { findLinearDeadLaunchCandidates, shouldReopenLinearIssue };
