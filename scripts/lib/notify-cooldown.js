/**
 * Cooldown decision for .github/actions/notify-failure (default time-cooldown mode).
 *
 * A run is a "recent other failure" when it is a DIFFERENT run that FINISHED failing inside the
 * cooldown window. The window is measured on completion time (`updated_at`), not creation time:
 * the opening-night orchestrator polls for ~5h before it can fail, so on 2026-10-13 its two
 * market runs (created 17:21, failed 22:37 and 22:38) each looked "older than the 2h window" to
 * the other, the duplicate was never suppressed, and the owner got two pages (BRO-5302).
 * Same lesson the streak mode already encodes ("sort by COMPLETION time").
 */

/** True when `run` should suppress an alert for `currentRunId` at cooldown `cutoff` (a Date). */
function isRecentOtherFailure(run, cutoff, currentRunId) {
  if (!run || run.id === currentRunId) return false;
  const finished = new Date(run.updated_at || run.created_at);
  return finished >= cutoff;
}

/**
 * Date (YYYY-MM-DD) for listWorkflowRuns' `created:` filter. That filter works on CREATION date, so
 * it must reach back past the longest possible run (job max is 6h; one extra day keeps it simple
 * and survives a midnight boundary) or a long-running sibling is dropped before we can look at it.
 */
function createdFilterDate(cutoff, maxRunHours = 24) {
  return new Date(cutoff.getTime() - maxRunHours * 3600 * 1000).toISOString().split('T')[0];
}

module.exports = { isRecentOtherFailure, createdFilterDate };
