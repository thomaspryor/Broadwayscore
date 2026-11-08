'use strict';
// BRO-7141. `linear-session.js claim` on a card that is already started used to print the last holder and
// exit 0, so a cloud worker claimed BRO-7133 while a Mac session held it (and had landed the work) and
// rebuilt the same change for ~2 hours. This is the pure decision: another LIVE holder means refuse.
//
// "Live" is not a second rule: it is the inverse of linear-reclaim-abandoned.js reclaimDecision (the
// hourly sweep's abandonment rule: 48h with no card or comment activity, no blocked report, no owner
// card, not opted out, no live land/ ref). A card that sweep would hand back to the board is claimable.
// Land refs are not queried from here (a claim must stay one cheap read), so landRefs is [].

const { reclaimDecision } = require('./linear-reclaim-abandoned.js');
const { HOLDER_COMMENT_RE, isSessionSpecificRef } = require('./linear-session-reporting.js');

// Machine claims only (buildClaimComment refs); a person's "Claimed by me" comment is not a session claim.
const CLAIM_RE = /^Claimed by (?:https:\/\/claude\.ai\/code\/|local session |a session on )/;
const DISPATCH_RE = /^Dispatched\b/;
// A parent's --child handoff only covers the child for this long; after that the parent's claim is just a claim.
const CHILD_HANDOFF_MAX_MS = 2 * 60 * 60 * 1000;
// Reclaim-rule skip reasons that mean the holder is still active (or unknowable). Every other skip reason
// (blocked report, owner card, NO-RECLAIM, reported In Review) is only reached after 48h idle: a stopped holder.
const LIVE_REASONS = new Set(['recent', 'recent-comment', 'live-land-ref', 'no-updated-at', 'comments-truncated']);
// linear-brain.js create --child appends this to the parent's claim: the parent hands the card to a
// create_session child that will run `claim` itself (CLOUD.md "Starting a worker session").
const CHILD_HANDOFF_RE = /Child session starting on this card now:/;

function commentsOf(issue) {
  const nodes = (issue && issue.comments && (issue.comments.nodes || issue.comments)) || [];
  return Array.isArray(nodes) ? nodes.filter((c) => c && c.body != null) : [];
}

/** Newest "Claimed by ..." comment, or null. Dispatch receipts are not claims. */
function latestClaimComment(comments) {
  const claims = comments.filter((c) => CLAIM_RE.test(String(c.body)));
  claims.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return claims[0] || null;
}

/**
 * @param {{issue:object, selfRef:string, nowMs?:number, force?:boolean}} p  issue is a started card with comments
 * @returns {{action:'proceed'|'own'|'handoff'|'takeover'|'unknown-holder'|'refuse', holder?:string, claimedAt?:string, reason:string}}
 *   proceed: nothing holds it. own: this session's claim. handoff: a parent's --child claim, repost as ours.
 *   takeover: the holder looks dead (reclaim rule). unknown-holder: started, no claim comment (warn only).
 */
function claimHolderDecision({ issue, selfRef, nowMs = Date.now(), force = false }) {
  const comments = commentsOf(issue);
  const claim = latestClaimComment(comments);
  if (!claim) return { action: 'unknown-holder', reason: 'started with no claim comment' };
  const body = String(claim.body);
  const holder = (body.match(/^Claimed by (.+?) at /) || [])[1] || 'another session';
  const claimedAt = claim.createdAt;
  // The host-only ref is shared by every session on a machine, so it can never prove "this is me".
  if (selfRef && isSessionSpecificRef(selfRef) && body.includes(selfRef)) return { action: 'own', holder, claimedAt, reason: 'this session holds it' };
  if (force) return { action: 'takeover', holder, claimedAt, reason: 'forced' };
  // The In Review rules belong to the sweep's own purposes; for a claim only "any activity in 48h" matters.
  const asStarted = { ...issue, state: { name: 'In Progress', type: 'started' } };
  const verdict = reclaimDecision({ issue: asStarted, comments, landRefs: [], nowMs });
  if (verdict.action !== 'skip' || !LIVE_REASONS.has(verdict.reason)) {
    return { action: 'takeover', holder, claimedAt, reason: verdict.action === 'skip' ? `holder idle 48h+ (${verdict.reason})` : `holder idle ${verdict.idleHours}h (reclaim rule)` };
  }
  const claimMs = Date.parse(claimedAt);
  if (CHILD_HANDOFF_RE.test(body) && nowMs - claimMs < CHILD_HANDOFF_MAX_MS) return { action: 'handoff', holder, claimedAt, reason: 'parent handed the card to a child session' };
  // A dispatch receipt newer than the claim is the dispatcher handing the card to its worker. A Mac "(headless)"
  // job runs in a local session; a cloud session is never that job (BRO-7133: a cloud worker took a Mac-held card).
  const cloudSelf = /^https:\/\/claude\.ai\//.test(selfRef || '');
  const dispatch = comments.filter((c) => DISPATCH_RE.test(String(c.body).trim()) && Date.parse(c.createdAt) > claimMs)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (dispatch && !(cloudSelf && /\(headless\)/.test(String(dispatch.body)))) return { action: 'handoff', holder, claimedAt, reason: 'the dispatcher handed the card to this worker' };
  return { action: 'refuse', holder, claimedAt, reason: `live (${verdict.reason})` };
}

/** Refusal text, naming the holder. */
function refusalMessage(identifier, d) {
  return `REFUSED: ${identifier} is already held by ${d.holder} (claimed ${d.claimedAt}) and shows recent activity, so a second session would double-work it.\n` +
    `  Read the card and wait for that session's report (or ask it to release). A holder with no activity for 48h counts as dead and is claimable.\n` +
    `  Only if you know that session is dead: re-run with --force="<reason, at least 10 characters>".`;
}

module.exports = { claimHolderDecision, refusalMessage, latestClaimComment, CHILD_HANDOFF_RE, HOLDER_COMMENT_RE };
