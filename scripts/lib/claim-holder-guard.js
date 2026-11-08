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

const CLAIM_RE = /^Claimed by /;
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
  const abandoned = reclaimDecision({ issue, comments, landRefs: [], nowMs });
  if (abandoned.action !== 'skip') return { action: 'takeover', holder, claimedAt, reason: `holder idle ${abandoned.idleHours}h (reclaim rule)` };
  if (CHILD_HANDOFF_RE.test(body)) return { action: 'handoff', holder, claimedAt, reason: 'parent handed the card to a child session' };
  return { action: 'refuse', holder, claimedAt, reason: `live (${abandoned.reason})` };
}

/** Refusal text, naming the holder. */
function refusalMessage(identifier, d) {
  return `REFUSED: ${identifier} is already held by ${d.holder} (claimed ${d.claimedAt}) and shows recent activity, so a second session would double-work it.\n` +
    `  Read the card and wait for that session's report (or ask it to release). A holder with no activity for 48h counts as dead and is claimable.\n` +
    `  Only if you know that session is dead: re-run with --force="<reason, at least 10 characters>".`;
}

module.exports = { claimHolderDecision, refusalMessage, latestClaimComment, CHILD_HANDOFF_RE, HOLDER_COMMENT_RE };
