/**
 * linear-drain-parked.js: selection logic and shortlisted comment reads for the Linear-side drain
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
// BRO-4054: the OTHER provenance line owner-alert-router writes — on cards it
// files in DISPATCH mode (no `PARKED:` sentinel) for the Mac-side red-first
// pass (scripts/lib/red-first-dispatch.js). Deliberately not a superstring of
// AUTO_FILED_MARKER: isAutoFiledParked() below uses `.includes`, and this
// drain must never select those cards too (double-dispatch).
const DISPATCH_AT_FILING_MARKER = 'Filed by owner-alert-router for dispatch-at-filing';

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
// Comments count when the caller fetched them (BRO-4642): linear-next.js's gate
// accepts a VERIFY posted as a comment, so a description-only read wrongly
// skips those cards. Without issue.comments this is the description alone.
function verifyCommand(issue) {
  if (!issue) return null;
  const { sortedCommentBodies } = require('./linear-dispatch.js');
  return evaluateVerifiability(issue.description || '', sortedCommentBodies(issue)).cmd || null;
}

function hasSafeVerifyCommand(issue) {
  return !!verifyCommand(issue);
}

// Session-parked P0/P1 cards (BRO-4535, owner-approved): a session wrote
// "PARKED: <reason>" and nothing ever unparked it. Only cards whose every park
// reason is technical (needs a review, a worktree, a monitor window) qualify;
// isDrainableSessionParked holds the owner-hold deny list. This Mac drain keeps
// P0/P1 only (the BRO-4535 scope); the cloud worker picker passes `priorities`
// to take P2/P3 technical parks too, under a stricter reason filter, since the
// owner wants every card handled (2026-10-11) and asked on 2026-10-14 why so
// many cards were never worked (BRO-5369).
const SESSION_PARKED_PRIORITIES = new Set([1, 2]);

// Also requires every OTHER headless blocker (visual-qa, async wait, owner
// decision) to be absent: linear-next.js --allow-session-parked waives only
// the PARKED sentinel, so a card failing those would just be refused inside
// the detached child and burn a drain slot.
// Lazy: headless-dispatchability.js requires this module for AUTO_FILED_MARKER.
// `priorities` widens the tier for the cloud worker picker, which takes P2/P3
// technical parks too (BRO-5369); the Mac drain keeps the P0/P1 default.
function isSessionParkedDrainable(issue, { priorities = SESSION_PARKED_PRIORITIES } = {}) {
  if (!issue || !issue.state || !PARKED_STATE_TYPES.has(issue.state.type)) return false;
  if (!priorities.has(Number(issue.priority))) return false;
  const hd = require('./headless-dispatchability.js');
  if (!hd.isDrainableSessionParked(issue.description || '')) return false;
  const { blockers } = hd.classifyHeadlessDispatchability(
    { subject: issue.title, notes: issue.description || '', comments: require('./linear-dispatch.js').sortedCommentBodies(issue) }, { verifyCmd: verifyCommand(issue) });
  return blockers.every((b) => b.code === hd.BLOCKERS.PARKED_SENTINEL);
}

// BRO-6080: a Todo card filed for the Mac (cloud sessions file these with
// linear-brain.js create --mac-only; the cloud picker skips them). Any triaged
// priority (P0-P3; never untriaged 0, same as the cloud picker), no PARKED line
// or other headless blocker, no NO-DISPATCH marker, no awaiting-owner label.
// Needs the MAC-ONLY line, not the label alone: the label's older meaning
// includes GUI and keychain work a person does at the Mac, which an unattended
// session would stall on; the line is what --mac-only writes for work a Mac
// session can finish by itself. Dispatched headless on this Mac
// (--mac-headless), so the drain's reconcile and caps see the job.
const MAC_ONLY_PRIORITIES = new Set([1, 2, 3, 4]);
function isMacOnlyCandidate(issue) {
  return !!(issue && issue.state && issue.state.type === 'unstarted'
    && MAC_ONLY_PRIORITIES.has(Number(issue.priority))
    && require('./mac-only-marker.js').hasMacOnlyLine(issue.description));
}

function isMacOnlyDrainable(issue) {
  if (!isMacOnlyCandidate(issue)) return false;
  if (require('./no-dispatch-marker.js').hasNoDispatchMarker(issue.description)) return false;
  if (require('./owner-approval-channel.js').isAwaitingOwner(issue)) return false;
  const cmd = verifyCommand(issue);
  if (!cmd) return false;
  const hd = require('./headless-dispatchability.js');
  const { blockers } = hd.classifyHeadlessDispatchability(
    { subject: issue.title, notes: issue.description || '', comments: require('./linear-dispatch.js').sortedCommentBodies(issue) }, { verifyCmd: cmd });
  return blockers.length === 0;
}

// Everything this drain may pick up: alert-router trackers (any priority, as
// before), technically-parked P0/P1 session cards and mac-only Todo cards, each
// with a safe VERIFY.
function isDrainEligible(issue) {
  if (!issue || !hasSafeVerifyCommand(issue)) return false;
  return isAutoFiledParked(issue) || isSessionParkedDrainable(issue) || isMacOnlyDrainable(issue);
}

/** Which waiver set linear-next needs for this drain candidate (the predicate that made it eligible). */
// A MAC-ONLY line adds --mac-headless to whichever waiver set applies, so a
// labeled card never falls back to a tab (no job-* rows for reconcile to see).
function drainDispatchOpts(issue) {
  const mac = require('./mac-only-marker.js').hasMacOnlyLine(issue && issue.description) ? { macHeadless: true } : {};
  if (isSessionParkedDrainable(issue)) return { allowSessionParked: true, ...mac };
  if (isAutoFiledParked(issue)) return { allowAutofixFiled: true, allowAutomationParked: true, ...mac };
  return { macHeadless: true };
}

// Shortlist before fetching: never read comments for active issues, owner
// holds or recently attempted cards. Verify and all remaining guards run on
// the fresh payload through selectDrainCandidates after this read.
async function fetchDrainIssuesWithComments(issues, opts = {}) {
  const { alreadyAttempted = new Set() } = opts;
  const hd = require('./headless-dispatchability.js');
  const shortlist = (Array.isArray(issues) ? issues : []).filter((issue) =>
    issue && issue.identifier && !alreadyAttempted.has(issue.identifier)
    && issue.state && PARKED_STATE_TYPES.has(issue.state.type)
    && (isAutoFiledParked(issue)
      || isMacOnlyCandidate(issue)
      || (SESSION_PARKED_PRIORITIES.has(Number(issue.priority))
        && hd.isDrainableSessionParked(issue.description || ''))));
  return require('./linear-issue-verifiability.js').fetchIssuesWithComments(shortlist, opts);
}

/**
 * Pure selection: drain-eligible issues, most urgent Linear priority first,
 * then oldest (lowest issue number), excluding anything the caller already
 * attempted recently, capped at `limit`.
 * @param {Array<object>} issues - Linear issues ({identifier, description, priority, state})
 * @param {object} [opts]
 * @param {number} [opts.limit] - defaults to 6, the CLI's DISPATCH_CAP
 * @param {Set<string>} [opts.alreadyAttempted] - identifiers to skip
 */
function selectDrainCandidates(issues, { limit = 6, alreadyAttempted = new Set() } = {}) {
  const { priorityRank } = require('./linear-dispatch.js');
  return (Array.isArray(issues) ? issues : [])
    .filter((iss) => iss && isDrainEligible(iss) && !alreadyAttempted.has(iss.identifier))
    .sort((a, b) => (priorityRank(a) - priorityRank(b)) || (issueNumber(a.identifier) - issueNumber(b.identifier)))
    .slice(0, Math.max(0, limit));
}

// BRO-5626: the cloud replacement for this drain's dead Mac dispatch. A
// session park whose every reason is worker-takeable (no owner hold, nothing
// only the owner can supply, no real block; headless-dispatchability.js
// isWorkerTakeableParkReason) and whose card a cloud worker could finish
// (safe VERIFY, no other headless blocker: cloud-worker-pick.js
// headlessUnfitReason) moves to Todo with its PARKED lines rewritten, so the
// picker's own default-deny rule sees an ordinary Todo card.
const UNPARK_PRIORITIES = new Set([1, 2, 3, 4]);

/** Why the unpark drain leaves this card parked, or null when it may move it to Todo. */
const UNPARKED_BY_DRAIN_RE = /^\s*UNPARKED \(BRO-5626\b/im;
// Owner wording anywhere in the card, not only in the park reason (ported from the retired linear-promote-parked.js).
const OWNER_TEXT_RE = /\bDECISION NEEDED\b|\bowner(?:'s)?\s+(?:decision|approval|sign[- ]?off|go[- ]ahead|call)\b|\b(?:waiting|wait|pending|blocked)\s+(?:on|for)\s+(?:the\s+|an?\s+)?(?:owner|thomas)\b/i;

function unparkSkipReason(issue) {
  if (!issue || !issue.identifier) return 'malformed';
  if (!issue.state || !PARKED_STATE_TYPES.has(issue.state.type)) return 'not-parked-state';
  if (!UNPARK_PRIORITIES.has(Number(issue.priority))) return 'untriaged-priority';
  const hd = require('./headless-dispatchability.js');
  const notes = issue.description || '';
  if (!hd.PARKED_SENTINEL_RE.test(notes)) return 'no-park-line';
  // Labels come only with the full read; the list read passes and is re-checked.
  if (require('./owner-approval-channel.js').isAwaitingOwner(issue)) return 'awaiting-owner';
  // Unparked once and parked again: a person or session put it back on purpose.
  if (UNPARKED_BY_DRAIN_RE.test(notes)) return 're-parked';
  if (hd.isAutomationParked(notes)) return 'machine-park';
  if (!hd.hasOnlyWorkerTakeableParks(notes)) return 'real-park-reason';
  if (OWNER_TEXT_RE.test(notes)) return 'owner-text';
  const unfit = require('./cloud-worker-pick.js').headlessUnfitReason(issue, { allowParkedSentinel: true });
  return unfit || null;
}

const PARK_LINE_PREFIX_RE = /^(\s*)PARKED\s*:/gim;

/** The description with every PARKED line marked UNPARKED by `tag`, reason kept. */
function unparkDescription(description, tag) {
  return String(description || '').replace(PARK_LINE_PREFIX_RE, (_m, lead) => `${lead}UNPARKED (${tag}):`);
}

module.exports = {
  UNPARK_PRIORITIES,
  unparkSkipReason,
  unparkDescription,
  AUTO_FILED_MARKER,
  DISPATCH_AT_FILING_MARKER,
  PARKED_STATE_TYPES,
  issueNumber,
  isAutoFiledParked,
  verifyCommand,
  hasSafeVerifyCommand,
  isSessionParkedDrainable,
  MAC_ONLY_PRIORITIES,
  isMacOnlyDrainable,
  drainDispatchOpts,
  isDrainEligible,
  selectDrainCandidates,
  fetchDrainIssuesWithComments,
};
