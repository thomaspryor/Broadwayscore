'use strict';
/**
 * owner-decision-quiet-period.js (BRO-6266): when NOT to ask the owner a
 * decision, shared by the per-card emailer, its 3-day roundup and the morning
 * digest so the three cannot disagree.
 *
 * Owner report 2026-10-26: decision emails arrived for cards already answered
 * in a Claude chat (BRO-6250, emailed 14 minutes after a session wrote on the
 * card while still talking to the owner) or in a plain comment (BRO-6111,
 * BRO-6112: "Didn't I do this already?"). Sessions comment under the owner's
 * Linear identity, so authorship says nothing; these rules never guess it.
 *
 *   answered        the card carries this decision's "Owner decision" record
 *   recent-activity a human-or-session comment in the last 90 minutes (our own
 *                   marker comments and dispatcher/watchdog receipts do not count): someone is working the card,
 *                   the email waits until it has been quiet that long, for at
 *                   most 12 hours of unbroken activity
 *   maybe-answered  a short plain comment that reads like a choice ("A", "go
 *                   with B") or like "I already answered this", newer than the
 *                   decision: held and listed in the run log for a look
 *
 * Kill switch: OWNER_DECISION_HOLDS_DISABLED=1 turns off the two new holds
 * (answered stays). Side-effect free.
 */

const link = require('../../src/lib/owner-decision-link.js');

const QUIET_MS = 90 * 60 * 1000;
// A busy card (bot or session comments every hour) cannot hold its email
// forever: once its run of activity (no 90-minute gap) has lasted this long,
// the quiet period stops applying.
const MAX_QUIET_HOLD_MS = 12 * 60 * 60 * 1000;
const OLD_CARD_MS = 24 * 60 * 60 * 1000;
// More untold decisions than this on old cards go out as the single backlog
// email, never one email each (the first run of the emailer swept four at once).
const MAX_OLD_INDIVIDUAL = 3;
const MAYBE_MAX_CHARS = 600;
const MAYBE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Comments this pipeline writes itself (told markers, recorded answers, visual approvals).
const OWN_MARKER_RE = /Decision (?:email )?ref\s*OD[AE]|Visual approval (?:ref|landed)\s*VQ[AL]|^\s*\**Owner decision\**/im;
// Receipts the dispatcher and watchdog post on a card (BRO-6357). They say a job started or ended, nothing
// about a person or session working the card, so they never count as activity. "Claimed by" is NOT here:
// a session claiming a card is the signal this quiet period exists to honour. A test pins these to the
// real builders (buildDispatchComment, HEADLESS_END_MARKER, WATCHDOG_SAFETY_NET_PREFIX).
// The watchdog and zombie sweep post through cmdReport, which wraps them in a "**Session report (status)**" header.
const MACHINE_RECEIPT_RE = /^\s*(?:\**Session report \([^)]*\)\**\s*)?(?:Dispatched (?:[0-9a-f]+ )?to |Headless worker ended without its own session report|Watchdog safety net:|Auto-reset by bsc-reconcile)/i;
// A bare choice, or words that say the decision was already made.
const CHOICE_RE = /^\s*(?:option\s+)?[A-E][.!)]?\s*$|^\s*(?:option\s+)?[A-E]\b\s*[,.:!-]|^\s*(?:let'?s\s+)?(?:go\s+with|pick|choose|i\s+(?:pick|choose|want|prefer))\s+(?:option\s+)?[A-E]\b|^\s*(?:yes|no|approved?|go ahead|do it|ship it)\b[\s,.!]*(?:(?:please|approved?|do it|go ahead|ship it|it)\b[\s,.!]*)*$/i;
const ALREADY_RE = /\balready (?:answered|decided|approved|said|replied|told|chose|picked|did)\b|\bdid(?:n['’]?t| not)? i (?:already|do this|answer)\b|\banswered (?:this|that|it)\b|\basked (?:this|me) (?:again|before)\b|\btold you\b/i;
// "ANSWER:" typed before any email went out (the sweep only reads replies to an email).
const ANSWER_PREFIX_RE = /^\s*\**ANSWER\**\s*:/i;
// Plain prose in the owner's voice (BRO-6111 answered in a sentence, no letter).
// Session comments carry fingerprints: markdown, code, links, card ids, dates,
// file paths, a "label:" opener or a status verb. Measured 2026-10-26 on the
// 2044 comments of all open cards: 2 matched, both the owner's.
const SESSION_RE = /```|`[^`]+`|^\s*#{1,6}\s|\*\*|^\s*[-*]\s|https?:\/\/|\bBRO-\d+|\b\d{4}-\d{2}-\d{2}\b|\b[\w-]+\/[\w./-]+\.\w{1,5}\b|\b(?:VERIFY|PR-EVIDENCE|RECHECK-AFTER|DONE-GATE|DECISION NEEDED|Claimed by|Session report|Outcome|My recommendation|Why this is your call)\b/im;
const LABEL_START_RE = /^\s*[\w '()-]{1,40}:\s/;
const SESSION_START_RE = /^\s*(?:Landed|Claimed|Raised|Unparked|Parked|Session|Codex|Gmail|Keep-green|closer-sweep|Listed|Emailed|Recorded|Owner chose|Plan reviewed|Progress|Updated|Dispatched|Returned|Reopened|Closing|Closed|Done)\b/i;
// First person only: sessions address the owner ("waiting on you", "can you ...?").
const VOICE_RE = /\b(?:I|I'm|I’m|I've|I’ve|me|my|we|us|our)\b/i;
function ownerVoice(body) {
  return !SESSION_RE.test(body) && !LABEL_START_RE.test(body) && !SESSION_START_RE.test(body) && VOICE_RE.test(body);
}

function holdsDisabled(env = process.env) { return env.OWNER_DECISION_HOLDS_DISABLED === '1' || env.OWNER_DECISION_HOLDS_DISABLED === 'true'; }

function commentsOf(issue) { return ((issue && issue.comments && issue.comments.nodes) || []).filter((c) => c && c.createdAt); }
function bodyOf(c) { return link.unescapeMarkdown(String(c.body || '')); }
function isOwnMarker(c) { return OWN_MARKER_RE.test(bodyOf(c)); }
// Comments that never mean someone is working the card: our own markers and dispatcher/watchdog receipts.
function isNotActivity(c) { const b = bodyOf(c); return OWN_MARKER_RE.test(b) || MACHINE_RECEIPT_RE.test(b); }
function ms(t) { const n = new Date(t).getTime(); return Number.isFinite(n) ? n : null; }

/** Newest comment that is not one of this pipeline's own marker comments, as ms, or null. */
function lastActivityAt(issue) {
  let best = null;
  for (const c of commentsOf(issue)) {
    if (isNotActivity(c)) continue;
    const t = ms(c.createdAt);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

// Oldest comment in the current run of activity: walking back from the newest,
// stop at the first gap of QUIET_MS or more.
function activityStreakStart(issue) {
  const times = commentsOf(issue).filter((c) => !isNotActivity(c)).map((c) => ms(c.createdAt)).filter((t) => t != null).sort((a, b) => b - a);
  let start = times[0];
  for (let i = 1; i < times.length && start - times[i] < QUIET_MS; i++) start = times[i];
  return start;
}

function isQuiet(issue, now = Date.now()) {
  const t = lastActivityAt(issue);
  return t == null || now - t >= QUIET_MS;
}

function refFor(decision, secret) {
  return link.decisionRef(secret, decision.identifier, link.questionHash(decision.question || decision.title));
}

/** True when this exact decision already has its "Owner decision" record on the card. */
function isAlreadyAnswered(issue, decision, secret) {
  if (!secret) return false;
  const marker = link.answerMarker(refFor(decision, secret));
  return commentsOf(issue).some((c) => link.bodyHasMarker(c.body, marker));
}

// The decision's own age: the newest comment that restates it, else the card's creation.
function decisionSince(issue) {
  let since = ms(issue && issue.createdAt) || 0;
  for (const c of commentsOf(issue)) {
    if (/DECISION NEEDED/i.test(bodyOf(c))) { const t = ms(c.createdAt); if (t != null && t > since) since = t; }
  }
  return since;
}

/** Plain comments newer than the decision that read like an answer. Authorship is not guessed. */
function maybeAnswerComments(issue, now = Date.now()) {
  const since = Math.max(decisionSince(issue), now - MAYBE_WINDOW_MS);
  return commentsOf(issue).filter((c) => {
    const t = ms(c.createdAt);
    if (t == null || t <= since || isOwnMarker(c)) return false;
    const body = bodyOf(c).trim();
    if (!body || body.length > MAYBE_MAX_CHARS || SESSION_RE.test(body)) return false;
    return ANSWER_PREFIX_RE.test(body) || CHOICE_RE.test(body) || ALREADY_RE.test(body) || ownerVoice(body);
  });
}

/**
 * Why not to ask the owner this decision right now, or null to ask.
 * @returns {null | {reason: 'answered'|'recent-activity'|'maybe-answered', detail: string}}
 */
function holdReason(issue, decision, { secret, now = Date.now(), env = process.env } = {}) {
  if (isAlreadyAnswered(issue, decision, secret)) return { reason: 'answered', detail: 'the owner decision is already recorded on the card' };
  if (holdsDisabled(env)) return null;
  const maybe = maybeAnswerComments(issue, now);
  if (maybe.length) {
    const c = maybe[maybe.length - 1];
    // No quote: the emailer's log is public and card comments are private.
    return { reason: 'maybe-answered', detail: `a comment on ${String(c.createdAt).slice(0, 16)}Z may already answer it` };
  }
  const last = lastActivityAt(issue);
  if (last != null && now - last < QUIET_MS && now - activityStreakStart(issue) < MAX_QUIET_HOLD_MS) {
    return { reason: 'recent-activity', detail: `the card had a comment ${Math.round((now - last) / 60000)} min ago; waits until it has been quiet ${QUIET_MS / 60000} min` };
  }
  return null;
}

/**
 * 'backlog' (one email listing them all) or 'each' (one email per decision).
 * A pile of untold decisions, or more than MAX_OLD_INDIVIDUAL on cards older
 * than a day, is a catch-up sweep and always goes out as the single email.
 */
function sendMode(fresh, { backlogMin, now = Date.now() } = {}) {
  const list = fresh || [];
  if (list.length >= backlogMin) return 'backlog';
  const old = list.filter((d) => { const t = ms(d.createdAt); return t != null && now - t > OLD_CARD_MS; }).length;
  return old > MAX_OLD_INDIVIDUAL ? 'backlog' : 'each';
}

module.exports = {
  QUIET_MS,
  MAX_QUIET_HOLD_MS,
  MAX_OLD_INDIVIDUAL,
  MACHINE_RECEIPT_RE,
  holdReason,
  holdsDisabled,
  isAlreadyAnswered,
  isQuiet,
  lastActivityAt,
  maybeAnswerComments,
  sendMode,
};
