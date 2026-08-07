'use strict';

// scripts/lib/dispatch-outcome-digest.js — turn audit-dispatch-outcomes.js's
// classification into the one health-check digest row.
//
// Card #1106: scripts/audit-dispatch-outcomes.js + scripts/lib/dispatch-outcome.js
// already compute the right answer — 37 abandoned dispatches on their first
// run — but nothing calls the script, so abandoned dispatches (dead
// workspace, card never completed) go unseen for up to 14 days. This module
// is the pure decision logic scripts/health-check.js wires into the daily
// digest; it does no I/O and takes no clock (CLAUDE.md rule 15: tested by
// require()-ing this, not by copying the counting logic into the test).
//
// tasksById is REQUIRED and must be a non-empty Map. loadTasksUnioned() (the
// real loader in audit-dispatch-outcomes.js) already throws on an
// empty/unreadable task store, precisely so a dead task store can't
// misreport every dispatch as abandoned (see its own comment: "would call
// every dispatch abandoned"). This function repeats that guard as a second
// line of defense: a future caller that swallows loadTasksUnioned()'s throw
// and passes an empty Map through must still fail loud here, not silently
// compute a wrong count (the vacuous-gate class, #1063/#1069).

const { classifyDispatches, OUTCOMES } = require('./dispatch-outcome.js');

/**
 * @param {object} a
 * @param {object[]} a.dispatchLedgerEntries raw data/audit/dispatch-ledger.jsonl rows
 * @param {Map<string,{status:string}>} a.tasksById task mirror, keyed by task id.
 *   Must be a non-empty Map — throws otherwise.
 * @param {Set<string>} [a.liveWorkspaceRefs] cmux-observed live workspace refs (optional;
 *   omit to fall back to ledger-only classification when cmux is unavailable)
 * @param {number|null} [a.previousAbandonedCount] yesterday's abandoned count, or
 *   null on the first run / no history available. ACTION-only email policy
 *   (memory/email-broadcast-rules.md, cloud-memory/email-broadcast-rules.md):
 *   a static, already-known abandoned count is not new information and
 *   doesn't need a fresh row every day — only a CHANGE (new abandonment, or
 *   one resolved) is actionable.
 * @returns {{name:string, status:string, message:string, hint:string,
 *            abandonedCount:number, oldestAbandonedLaunchedAt:string|null}|null}
 *   null when there is nothing actionable to report.
 */
function computeDispatchOutcomeDigest({
  dispatchLedgerEntries,
  tasksById,
  liveWorkspaceRefs,
  previousAbandonedCount = null,
} = {}) {
  if (!(tasksById instanceof Map) || tasksById.size === 0) {
    throw new Error(
      'dispatch-outcome-digest: empty/unreadable task store — refusing to report ' +
      '(would misclassify every dispatch; the vacuous-gate class from #1063/#1069)'
    );
  }

  const results = classifyDispatches(
    dispatchLedgerEntries || [],
    tasksById,
    liveWorkspaceRefs ? { liveWorkspaceRefs } : {}
  );

  const abandoned = results
    .filter((r) => r.outcome === OUTCOMES.ABANDONED)
    .sort((x, y) => new Date(x.launchedAt || 0) - new Date(y.launchedAt || 0));

  const abandonedCount = abandoned.length;
  if (abandonedCount === 0) return null;
  if (abandonedCount === previousAbandonedCount) return null;

  const oldestAbandonedLaunchedAt = abandoned[0].launchedAt || null;

  return {
    name: 'Dispatch outcomes: abandoned',
    status: 'warn',
    message: `${abandonedCount} dispatch(es) abandoned (workspace gone, card never completed) — oldest launched ${oldestAbandonedLaunchedAt || 'unknown'}`,
    hint: 'Run `node scripts/audit-dispatch-outcomes.js` for the full list — re-dispatch or close each card.',
    abandonedCount,
    oldestAbandonedLaunchedAt,
  };
}

module.exports = { computeDispatchOutcomeDigest };
