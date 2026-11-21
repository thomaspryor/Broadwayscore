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
const { BYPASS_LINE_PREFIX } = require('./linear-gate-bypass-ledger.js');

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

// BRO-4487: how close to the issue's completedAt a DONE-GATE-BYPASS comment
// must be to count as the bypass that produced THIS completion. linear-
// brain.js posts the bypass line immediately before the state move (seconds
// apart); the window is generous so a slow round-trip never hides one.
const BYPASS_BEFORE_COMPLETION_MS = 30 * 60 * 1000;
const BYPASS_AFTER_COMPLETION_MS = 2 * 60 * 1000;
const BYPASS_LINE_RE = new RegExp(`^${BYPASS_LINE_PREFIX}`, 'm');

/**
 * Whether a live Linear issue fetched for a candidate should be reopened.
 * Read-then-check (mirrors shouldCorrectNotionStatus): only an issue
 * CURRENTLY sitting in a completed-type state is touched — one the owner
 * has since re-triaged by hand (e.g. back to In Progress) is left alone.
 *
 * BRO-4487: and only when that completion BYPASSED the Done gate. A Linear
 * issue cannot reach Done through linear-brain.js without done-evidence the
 * gate itself checked (PR-EVIDENCE or a VERIFY command) unless --force /
 * LINEAR_DONE_GATE_DISABLED was used, and every such bypass posts a
 * DONE-GATE-BYPASS line on the issue (BRO-4241). A dead dispatch-ledger row
 * says the JOB died, not that the WORK is missing: measured 2026-10-01, 50 of
 * the 59 open Urgent/High issues that had been reopened from Done were
 * reopened by this reconcile pass, 44 of them after the work had landed and
 * been acked, 9 of them more than once. Gated completions are therefore left
 * alone; the Notion-era reopen (card #1144) existed because TaskUpdate had
 * no such gate. An issue moved to Done in the Linear app by the owner has no
 * bypass line either, and is the owner's call to keep.
 */
function shouldReopenLinearIssue(issue) {
  if (!(issue && issue.state && issue.state.type === 'completed')) return false;
  return completionBypassedDoneGate(issue);
}

/** PURE. Did a DONE-GATE-BYPASS comment accompany this issue's completion? */
function completionBypassedDoneGate(issue) {
  const completedMs = Date.parse((issue && issue.completedAt) || '');
  if (!Number.isFinite(completedMs)) return false;
  const comments = (issue.comments && issue.comments.nodes) || [];
  return comments.some((c) => {
    if (!c || !BYPASS_LINE_RE.test(String(c.body || ''))) return false;
    const at = Date.parse(c.createdAt || '');
    return Number.isFinite(at)
      && at >= completedMs - BYPASS_BEFORE_COMPLETION_MS
      && at <= completedMs + BYPASS_AFTER_COMPLETION_MS;
  });
}

module.exports = { findLinearDeadLaunchCandidates, shouldReopenLinearIssue, completionBypassedDoneGate };
