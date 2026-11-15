'use strict';
// BRO-7141. `linear-session.js claim` on a card that is already started used to print the last holder and
// exit 0, so a cloud worker claimed BRO-7133 while a Mac session held it (and had landed the work) and
// rebuilt the same change for ~2 hours. This is the pure decision: another LIVE holder means refuse.
//
// BRO-7553: "live" means the HOLDER shows life: its claim, comments carrying its session marker, its pushes
// and ledger rows (holderLiveness). Another session's comment (a parent's takeover note, a stall nudge) never
// counts. A holder is also dead when its headless job ended, its Land run failed, or it reported blocked, with
// nothing from it since. Land refs are read only by the caller, and only when a refusal is about to happen.

const { latestSessionReportStatus, RECLAIM_IDLE_MS, COMMENT_CAP } = require('./linear-reclaim-abandoned.js');
const { HOLDER_COMMENT_RE, isSessionSpecificRef, sessionMarkerRefs } = require('./linear-session-reporting.js');

// Machine claims only (buildClaimComment refs); a person's "Claimed by me" comment is not a session claim.
const CLAIM_RE = /^Claimed by (?:https:\/\/claude\.ai\/code\/|local session |a session on )/;
const DISPATCH_RE = /^Dispatched\b/;
// A parent's --child handoff only covers the child for this long; after that the parent's claim is just a claim.
const CHILD_HANDOFF_MAX_MS = 2 * 60 * 60 * 1000;
// linear-brain.js create --child appends this to the parent's claim: the parent hands the card to a
// create_session child that will run `claim` itself (CLOUD.md "Starting a worker session").
const CHILD_HANDOFF_RE = /Child session starting on this card now:/;

// BRO-7553: a failed Land run with no new push for this long means the holder stopped without landing.
const LANDING_FAILED_QUIET_MS = 60 * 60 * 1000;

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
function claimHolderDecision({ issue, selfRef, nowMs = Date.now(), force = false, evidence = null }) {
  const comments = commentsOf(issue);
  const claim = latestClaimComment(comments);
  if (!claim) return { action: 'unknown-holder', reason: 'started with no claim comment' };
  const body = String(claim.body);
  const holder = (body.match(/^Claimed by (.+?) at /) || [])[1] || 'another session';
  const claimedAt = claim.createdAt;
  // The host-only ref is shared by every session on a machine, so it can never prove "this is me".
  if (selfRef && isSessionSpecificRef(selfRef) && body.includes(selfRef)) return { action: 'own', holder, claimedAt, reason: 'this session holds it' };
  if (force) return { action: 'takeover', holder, claimedAt, reason: 'forced' };
  const verdict = holderLiveness({ comments, claim, holder, evidence, nowMs });
  if (!verdict.live) return { action: 'takeover', holder, claimedAt, reason: verdict.reason };
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

/**
 * BRO-7553: is the claim holder alive? Only the holder's own evidence counts: its claim, comments carrying its
 * session marker, and (when the caller supplies them) its pushes and ledger rows. A parent's takeover note, a
 * stall nudge, a forced-takeover note or any other session's comment never proves the holder is alive.
 * @param {{comments:object[], claim:object, holder:string, nowMs:number,
 *   evidence?:?{lastPushMs?:?number, lastLedgerMs?:?number, jobEndedMs?:?number, landing?:?{conclusion:string, atMs:number}}}} p
 * @returns {{live:boolean, reason:string}}
 */
function holderLiveness({ comments, claim, holder, evidence, nowMs }) {
  // Past the cap the newest comments are not in hand: unknowable, so live (the old comments-truncated rule).
  if (comments.length >= COMMENT_CAP) return { live: true, reason: 'comments-truncated' };
  const ev = evidence || {};
  const ownComment = comments.filter((c) => sessionMarkerRefs(c.body).includes(holder)).map((c) => Date.parse(c.createdAt));
  const times = [Date.parse(claim.createdAt), ...ownComment, ev.lastPushMs, ev.lastLedgerMs].filter(Number.isFinite);
  const lastOwnMs = Math.max(...times);
  if (!Number.isFinite(lastOwnMs)) return { live: true, reason: 'no-holder-timestamp' };
  const idleMs = nowMs - lastOwnMs;
  if (idleMs >= RECLAIM_IDLE_MS) return { live: false, reason: `holder idle ${Math.floor(idleMs / 3600e3)}h with no activity of its own` };
  // A blocked report newer than anything the holder did: it said it cannot continue (dispatch-time blocks excluded).
  const claimMs = Date.parse(claim.createdAt);
  const after = comments.filter((c) => Date.parse(c.createdAt) >= claimMs);
  // A report carrying another session's marker is not the holder's word (unmarked older reports are assumed the holder's).
  const holderVoice = after.filter((c) => { const m = sessionMarkerRefs(c.body); return !m.length || m.includes(holder); });
  if (latestSessionReportStatus(holderVoice) === 'blocked') {
    const reportMs = Math.max(...holderVoice.filter((c) => /^\*\*Session report \(blocked\)/.test(String(c.body).trim())).map((c) => Date.parse(c.createdAt)));
    if (Number.isFinite(reportMs) && lastOwnMs <= reportMs + 60e3) return { live: false, reason: 'holder reported blocked and has done nothing since' };
  }
  // The holder's headless job finished (dispatch ledger) with the card still In Progress and nothing from the
  // holder since: no process is left to work it (BRO-7527: job-done 15:42Z, card still held at 21:37Z).
  if (Number.isFinite(ev.jobEndedMs) && lastOwnMs <= ev.jobEndedMs + 60e3 && nowMs - ev.jobEndedMs >= LANDING_FAILED_QUIET_MS) {
    return { live: false, reason: `holder's job ended ${Math.floor((nowMs - ev.jobEndedMs) / 60e3)}m ago and it has not pushed or commented since` };
  }
  const landing = ev.landing;
  if (landing && /^(failure|timed_out|startup_failure)$/.test(String(landing.conclusion)) && Number.isFinite(landing.atMs)) {
    const lastMs = Math.max(landing.atMs, lastOwnMs);
    // lastOwnMs includes the claim, so require the holder be silent since the failed run.
    if (lastOwnMs <= landing.atMs + 60e3 && nowMs - lastMs >= LANDING_FAILED_QUIET_MS) {
      return { live: false, reason: `landing failed ${Math.floor((nowMs - landing.atMs) / 60e3)}m ago and the holder has not pushed or commented since` };
    }
  }
  return { live: true, reason: 'holder active' };
}

/** Refusal text, naming the holder. */
function refusalMessage(identifier, d) {
  return `REFUSED: ${identifier} is already held by ${d.holder} (claimed ${d.claimedAt}) and shows recent activity of its own, so a second session would double-work it.\n` +
    `  Read the card and wait for that session's report (or ask it to release). A holder with no activity for 48h counts as dead and is claimable.\n` +
    `  Only if you know that session is dead: re-run with --force="<reason, at least 10 characters>".`;
}

module.exports = { claimHolderDecision, holderLiveness, LANDING_FAILED_QUIET_MS, refusalMessage, latestClaimComment, CHILD_HANDOFF_RE, HOLDER_COMMENT_RE };
