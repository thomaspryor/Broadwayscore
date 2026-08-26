/**
 * linear-drain-parked.js — pure selection logic for the Linear-side drain
 * (BRO-293, BRO-286 Phase 2 completion).
 *
 * BRO-286 repointed owner-alert-router.js's dispatchCard() to file PARKED
 * Linear issues instead of Notion Action Queue cards — but nothing ever
 * drained them. The old Notion path had the Action Queue poller / P0-P1
 * auto-dispatch rule; a parked Linear issue just sits in Backlog forever
 * until a human dispatches it by hand. This module is the pure "which
 * parked issues are safe to auto-dispatch unattended" predicate; the CLI
 * (scripts/linear-drain-parked.js) does the I/O (fetch, spawn, ledger).
 *
 * Two independent conditions, both required:
 *   1. It's an auto-filed, still-parked tracker — Backlog state (the
 *      state.type linear-issue-create.js's pickStateForMode('park') picks)
 *      whose description carries the marker owner-alert-router.js's
 *      dispatchCard() embeds via its parkReason ("Auto-filed by
 *      owner-alert-router ..." — linear-issue-create.js prefixes the final
 *      description "PARKED: <reason>\n\n<description>", so the marker
 *      survives verbatim in the stored issue body).
 *   2. It carries a safe-form backticked command in its own acceptance
 *      criteria — linear-next.js's own verify gate (evaluateVerifiability
 *      from ./verify-gate.js) requires exactly this before a --headless
 *      dispatch is allowed without --allow-unverifiable, so selecting for
 *      it here is what keeps every dispatch this drain attempts inside
 *      linear-next's own guard rather than needing --allow-unverifiable.
 */
'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');

// buildCardNotes' parkReason in owner-alert-router.js starts with this
// literal phrase; linear-issue-create.js's park-mode prefix ("PARKED: ") is
// prepended in front of it, so a substring check (not startsWith) is what
// survives that wrapping.
const AUTO_FILED_MARKER = 'Auto-filed by owner-alert-router';

// Linear identifiers are "<TEAM>-<N>", N increasing monotonically per team —
// the same FIFO-by-number convention linear-next.js's --list already treats
// as a proxy for "oldest first" (no createdAt field is fetched by the
// open-issues-with-descriptions query this module's caller uses).
function issueNumber(identifier) {
  const m = /-(\d+)$/.exec(String(identifier || ''));
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

// linear-issue-create.js's pickStateForMode('park') picks a 'backlog'-type
// state, falling back to 'unstarted' ONLY if the team has no backlog-type
// state at all (ship-check finding: two independent reviewers caught that
// an earlier version of this checked 'backlog' alone, which would silently
// starve every parked issue on a team configured that way — every issue
// owner-alert-router.js files goes through that same park path, so both
// outcomes count as "still parked, never picked up").
const PARKED_STATE_TYPES = new Set(['backlog', 'unstarted']);

// Still-parked, auto-filed-by-the-alert-router tracker.
function isAutoFiledParked(issue) {
  if (!issue || !issue.state || !PARKED_STATE_TYPES.has(issue.state.type)) return false;
  return typeof issue.description === 'string' && issue.description.includes(AUTO_FILED_MARKER);
}

// Carries a safe-form backticked command — linear-next.js's verify gate
// requirement. Deliberately requires an actual `.cmd`, not just the
// OWNER_JUDGMENT_RE marker evaluateVerifiability also treats as "armed": a
// parked issue drained unattended needs a machine-checkable proof of done,
// the same bar linear-next.js itself enforces without --allow-unverifiable.
function hasSafeVerifyCommand(issue) {
  if (!issue) return false;
  return !!evaluateVerifiability(issue.description || '').cmd;
}

/**
 * Pure selection: parked + auto-filed + verifiable issues, oldest (lowest
 * issue number) first, excluding anything the caller already attempted
 * recently, capped at `limit`.
 * @param {Array<object>} issues - Linear issues ({identifier, description, state})
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {Set<string>} [opts.alreadyAttempted] - identifiers to skip
 */
function selectDrainCandidates(issues, { limit = 3, alreadyAttempted = new Set() } = {}) {
  return (Array.isArray(issues) ? issues : [])
    .filter((iss) => iss && isAutoFiledParked(iss) && hasSafeVerifyCommand(iss) && !alreadyAttempted.has(iss.identifier))
    .sort((a, b) => issueNumber(a.identifier) - issueNumber(b.identifier))
    .slice(0, Math.max(0, limit));
}

module.exports = {
  AUTO_FILED_MARKER,
  PARKED_STATE_TYPES,
  issueNumber,
  isAutoFiledParked,
  hasSafeVerifyCommand,
  selectDrainCandidates,
};
