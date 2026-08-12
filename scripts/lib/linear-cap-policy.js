/**
 * linear-cap-policy.js — pure decision logic for the Linear issue-cap monitor
 * (BRO-285). Linear's free tier hard-caps a workspace at 250 unarchived
 * issues; scripts/lib/linear-issue-create.js's USAGE_LIMIT_MESSAGE documents
 * the hard cap itself, this file's WARN_THRESHOLD is the earlier trip wire
 * scripts/check-linear-cap.js and scripts/linear-archive-done.js act on.
 *
 * No fetch, no fs, no Date.now() — callers pass `now` in so this stays a pure
 * function CLAUDE.md rule 15 requires tests to require() directly.
 *
 * Scope note: the 250-issue cap is workspace-wide, but every caller counts
 * only team BRO's issues (scripts/lib/linear-client.js's TEAM_KEY) — the same
 * team-scoped assumption every other Linear script in this repo already
 * makes. Correct today because BRO is the only team in the workspace; if a
 * second team is ever added, this stops being an accurate proxy for the real
 * cap and needs a workspace-wide count instead.
 */

'use strict';

// Warn well under the 250 hard cap so there's runway to archive before a
// createIssue() call fails with USAGE_LIMIT_EXCEEDED.
const WARN_THRESHOLD = 200;

// Don't archive an issue the moment it closes — a quick reopen shouldn't
// require an unarchive round-trip.
const ARCHIVE_AGE_HOURS = 48;

function isOverCapThreshold(count, threshold = WARN_THRESHOLD) {
  return count >= threshold;
}

// issue: { stateType, completedAt, canceledAt } (the shape linear-client.js's
// listIssues() returns). closedAt is picked by CURRENT stateType, not by an
// completedAt-wins fallback — an issue moved Done -> Canceled can carry a
// stale completedAt from its earlier Done pass, and blindly preferring it
// would archive on the wrong (older) timestamp, undercutting the 48h reopen
// buffer for the transition that actually made it terminal.
function isArchivableIssue(issue, now, ageHours = ARCHIVE_AGE_HOURS) {
  if (!issue || (issue.stateType !== 'completed' && issue.stateType !== 'canceled')) return false;
  const closedAt = issue.stateType === 'completed' ? issue.completedAt : issue.canceledAt;
  if (!closedAt) return false;
  const ageMs = now - new Date(closedAt).getTime();
  return ageMs >= ageHours * 60 * 60 * 1000;
}

module.exports = { WARN_THRESHOLD, ARCHIVE_AGE_HOURS, isOverCapThreshold, isArchivableIssue };
