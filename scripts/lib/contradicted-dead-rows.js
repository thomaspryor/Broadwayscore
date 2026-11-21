/**
 * contradicted-dead-rows.js — which `dead` ledger rows for a task are PROVEN
 * false by the buried worker's own later session report (BRO-2575 / BRO-2599 /
 * BRO-2648).
 *
 * A `dead` row is bsc-prune's (or checkDeadDispatch's) verdict that a
 * dispatched cmux workspace died mid-task. dispatchCapDecision counts those
 * rows toward DEAD_ATTEMPT_LIMIT, so a false one refuses a legitimate
 * re-dispatch with "has died Nx already". A worker that reports back cannot
 * have died before it reported — so a session report attributable to the
 * buried worker disproves the row, and dispatchCapDecision drops it via
 * opts.contradictedDeadKeys (`${workspaceRef}|${ts}`).
 *
 * Shared by scripts/audit-false-dead-ledger-rows.js (read-only audit) and the
 * LIVE gate (linear-next.js -> checkDeadDispatch -> deadDispatchGuard), so the
 * audit's capImpact is exactly what the gate does.
 *
 * ATTRIBUTION (strict, because a live gate must not erode the cap):
 *   - only `**Session report` comments (parseSessionReportStatus, rule 15)
 *     count, and AUTOMATION-posted reports are skipped entirely: the zombie
 *     sweep's reset (ZOMBIE_RESET_MARKER) and the watchdog's blocked-job
 *     park (WATCHDOG_SAFETY_NET_PREFIX) go through the same cmdReport writer
 *     but say nothing about whether a worker was alive;
 *   - the FIRST remaining report strictly after the dead row is the candidate;
 *   - it contradicts the row only if it lands before BOTH the next ledger
 *     `launch` for this taskId AND the next "Dispatched ..." comment on the
 *     thread after the dead row. Either one means a successor may have been
 *     dispatched, so the report could be the successor's: `ambiguous`, never
 *     a key.
 *
 * Known residual: a session that leaves neither a ledger launch on this host
 * nor a Dispatched comment (a cloud worker, an owner's manual session, a
 * cross-machine headless job whose comment is only posted at job END) can
 * still have its report credited to the corpse. Accepted: the worst case is
 * one extra re-dispatch of a card that someone demonstrably worked on.
 *
 * Scope: only cmux `dead` rows are ever discounted (classifyDeadAttemptsForTask
 * filters only event === 'dead'); headless job-failed/job-orphaned deaths stay
 * substantive.
 *
 * Pure: no I/O. Comments are sorted here, never trusted as returned (the
 * Linear connection's order is not reliably createdAt-ascending).
 */
'use strict';

const { parseSessionReportStatus, HEADLESS_END_MARKER } = require('./linear-session-reporting.js');
const { ZOMBIE_RESET_MARKER } = require('./linear-started-zombie-sweep.js');
const { WATCHDOG_SAFETY_NET_PREFIX } = require('./dispatch-watchdog-core.js');

// Same test newestDispatchComment uses (linear-dispatch.js) — deliberately
// not DISPATCH_COMMENT_CORRELATION_RE, which misses comments with no
// correlationId.
const DISPATCH_COMMENT_RE = /^Dispatched\b/;

function isAutomationReport(body) {
  const b = String(body || '');
  return b.includes(ZOMBIE_RESET_MARKER) || b.includes(WATCHDOG_SAFETY_NET_PREFIX) || b.trim().startsWith(HEADLESS_END_MARKER);
}

function sortedComments(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter(c => c && typeof c.createdAt === 'string')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// Timestamp of the first `launch` for this taskId strictly after `afterTs`,
// or null when the task was never dispatched again.
function nextLaunchAfter(rows, taskId, afterTs) {
  let best = null;
  for (const e of rows || []) {
    if (!e || e.event !== 'launch' || String(e.taskId) !== String(taskId)) continue;
    if (!(String(e.ts || '') > afterTs)) continue;
    if (best === null || e.ts < best) best = e.ts;
  }
  return best;
}

/**
 * Classify every Linear-tracked `dead` row of `taskId` against the issue's
 * comment thread.
 * @returns {{contradicted: object[], ambiguous: object[]}} records with
 *   workspaceRef, deadAt, reportedAt, reportStatus, nextLaunchAt,
 *   nextDispatchCommentAt, key
 */
function classifyDeadRowsForTask(taskId, ledgerRows, comments) {
  const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
  const sorted = sortedComments(comments);
  const reports = sorted
    .filter(c => !isAutomationReport(c.body))
    .map(c => ({ createdAt: c.createdAt, status: parseSessionReportStatus(c.body) }))
    .filter(r => r.status !== null);
  const dispatchComments = sorted.filter(c => DISPATCH_COMMENT_RE.test(String(c.body || '').trim()));

  const contradicted = [];
  const ambiguous = [];
  for (const row of rows) {
    if (!row || row.event !== 'dead' || String(row.taskId) !== String(taskId)) continue;
    const deadAt = String(row.ts || '');
    if (!deadAt) continue;
    const first = reports.find(r => r.createdAt > deadAt);
    if (!first) continue;
    const nextLaunchAt = nextLaunchAfter(rows, taskId, deadAt);
    const nextDispatch = dispatchComments.find(c => c.createdAt > deadAt);
    const nextDispatchCommentAt = nextDispatch ? nextDispatch.createdAt : null;
    const record = {
      workspaceRef: row.workspaceRef || null,
      deadAt,
      reportedAt: first.createdAt,
      reportStatus: first.status,
      nextLaunchAt,
      nextDispatchCommentAt,
      key: `${row.workspaceRef}|${row.ts}`,
    };
    const successorPossible = (nextLaunchAt && first.createdAt >= nextLaunchAt)
      || (nextDispatchCommentAt && first.createdAt >= nextDispatchCommentAt);
    (successorPossible ? ambiguous : contradicted).push(record);
  }
  return { contradicted, ambiguous };
}

/** The Set dispatchCapDecision / deadDispatchGuard take as opts.contradictedDeadKeys. */
function contradictedDeadKeysForTask(taskId, ledgerRows, comments) {
  return new Set(classifyDeadRowsForTask(taskId, ledgerRows, comments).contradicted.map(r => r.key));
}

module.exports = {
  classifyDeadRowsForTask,
  contradictedDeadKeysForTask,
  nextLaunchAfter,
  isAutomationReport,
};
