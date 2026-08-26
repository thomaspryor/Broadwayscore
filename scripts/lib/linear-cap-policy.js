/**
 * linear-cap-policy.js — pure decision logic for the Linear issue-cap monitor
 * (BRO-285). Linear's free tier hard-caps a workspace at 250 unarchived
 * issues; scripts/lib/linear-issue-create.js's USAGE_LIMIT_MESSAGE documents
 * the hard cap itself, this file's WARN_THRESHOLD is the earlier trip wire
 * scripts/check-linear-cap.js and scripts/linear-archive-done.js act on.
 *
 * No fetch, no fs — callers pass `now` in so this stays a pure function
 * CLAUDE.md rule 15 requires tests to require() directly. isArchivableIssue
 * requires `now`; isCapEnforced DEFAULTS it to Date.now() for the one-arg
 * production call at check-linear-cap.js:48, which does read it whenever a
 * cancelAt is present. Tests that exercise a time-dependent path inject `now`;
 * the shape-only cases (null/non-object/no-type/no-cancel-fields) return
 * before it matters and call with one argument.
 *
 * Scope note: the 250-issue cap is workspace-wide, but every caller counts
 * only team BRO's issues (scripts/lib/linear-client.js's TEAM_KEY) — the same
 * team-scoped assumption every other Linear script in this repo already
 * makes. Correct today because BRO is the only team in the workspace; if a
 * second team is ever added, this stops being an accurate proxy for the real
 * cap and needs a workspace-wide count instead.
 */

'use strict';

const { isTerminalStateType } = require('./linear-state-types.js');

// Warn well under the 250 hard cap so there's runway to archive before a
// createIssue() call fails with USAGE_LIMIT_EXCEEDED.
const WARN_THRESHOLD = 200;

// Don't archive an issue the moment it closes — a quick reopen shouldn't
// require an unarchive round-trip.
const ARCHIVE_AGE_HOURS = 48;

function isOverCapThreshold(count, threshold = WARN_THRESHOLD) {
  return count >= threshold;
}

// The 250-issue ceiling is a FREE-tier limit; paid plans lift it. Once the
// workspace carries a subscription, the warn threshold is a false alarm that
// re-fires every day forever — and because check-linear-cap.js routes it as
// decision:true, each of those days costs the owner a decision row in the
// 7:30 digest asking a question he has already answered (owner upgraded to
// basic_yearly_10 on 2026-08-12). Callers pass organization.subscription
// through; null/undefined means free tier and the cap still applies.
// A canceled-but-lingering subscription record stays a truthy object, so a bare
// truthiness test would disable the cap guard exactly when the workspace is
// about to fall back to the free tier.
//
// But the two cancellation fields mean different things and must not be
// conflated: Linear sets `canceledAt` when cancel is CLICKED (past) and
// `cancelAt` to when the paid period actually ENDS (future). The plan stays
// paid until `cancelAt`. Treating either as "re-arm now" would restart the
// >=200 false alert the moment cancel is clicked and keep it firing daily for
// up to a full year while the workspace is still on a paid plan — the exact
// noise this predicate exists to remove.
//
// So: the cap is enforced once the paid period has lapsed, not when cancel was
// requested. `now` is injected (same contract as isArchivableIssue) so this
// stays pure. A cancellation with no end date is unknowable, so it re-arms —
// the conservative direction, since hitting the hard cap jams issue creation.
function isCapEnforced(subscription, now = Date.now()) {
  if (!subscription || typeof subscription !== 'object') return true;
  if (!subscription.type) return true;
  if (subscription.cancelAt) {
    const endsAt = Date.parse(subscription.cancelAt);
    // A cancelAt we cannot parse is a cancellation whose end date is unknown —
    // fail toward the armed cap. Lifting it on garbage would leave the guard
    // silently off through a real lapse until createIssue starts throwing
    // USAGE_LIMIT_EXCEEDED, which is the failure this module exists to prevent.
    return Number.isFinite(endsAt) ? endsAt <= now : true;
  }
  // Cancel requested but no end date exposed — same reasoning.
  if (subscription.canceledAt) return true;
  return false;
}

// issue: { stateType, completedAt, canceledAt } (the shape linear-client.js's
// listIssues() returns). closedAt is picked by CURRENT stateType, not by an
// completedAt-wins fallback — an issue moved Done -> Canceled can carry a
// stale completedAt from its earlier Done pass, and blindly preferring it
// would archive on the wrong (older) timestamp, undercutting the 48h reopen
// buffer for the transition that actually made it terminal. `canceled` and
// `duplicate` share the `canceledAt` branch — confirmed live (BRO-2466) that
// Linear populates `canceledAt`, not a separate field, for duplicate-type
// issues too.
function closedAtOf(issue) {
  return issue.stateType === 'completed' ? issue.completedAt : issue.canceledAt;
}

function isArchivableIssue(issue, now, ageHours = ARCHIVE_AGE_HOURS) {
  if (!issue || !isTerminalStateType(issue.stateType)) return false;
  const closedAt = closedAtOf(issue);
  if (!closedAt) return false;
  const ageMs = now - new Date(closedAt).getTime();
  return ageMs >= ageHours * 60 * 60 * 1000;
}

module.exports = { WARN_THRESHOLD, ARCHIVE_AGE_HOURS, isOverCapThreshold, isCapEnforced, isArchivableIssue, closedAtOf };
