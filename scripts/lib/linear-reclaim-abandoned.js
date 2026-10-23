/**
 * linear-reclaim-abandoned — decide which started Linear cards a dead session
 * left behind, so the hourly sweep can hand them back to the board (BRO-5100).
 *
 * WHY: a worker claims a card (linear-session.js claim moves it to In
 * Progress) before working it. When that session dies (container reclaimed,
 * session killed, Codex run aborted) nothing moves the card again, and every
 * picker skips started cards (cloud-worker-pick.js takes Todo only, plus the
 * land-ref resume). The Mac's started-zombie sweep (linear-started-zombie-sweep.js)
 * reads the Mac dispatch ledger, so it never sees cloud or Codex claims. On
 * 2026-10-11, 27 cards sat In Progress 1-52 days this way and were reset by
 * hand.
 *
 * RULES (a card is reclaimed only when all hold):
 *   - started state. In Review cards are reclaimed only in the narrow case
 *     below (BRO-6085); every other In Review card belongs to the stuck-card closer.
 *   - no Linear activity for RECLAIM_IDLE_MS: neither updatedAt nor the newest
 *     comment (in case a comment does not bump updatedAt). Machine edits also
 *     bump updatedAt, which can only delay a reclaim, never cause a wrong one.
 *     48h, not 24h: an owner's Mac tab can sit on its own card for a day, and
 *     the stuck set ran 1-52 days, so little is lost.
 *   - not an owner card (👑 / OWNER title) and no NO-RECLAIM: line in the
 *     description (the opt-out for trackers and long-lived holders).
 *   - In Review cards (BRO-6085): a Mac headless worker that ends without a
 *     session report leaves the card In Review with only its "Dispatched ..."
 *     comment, and nothing else looks at it (the closer needs a passing VERIFY).
 *     Such a card goes back to Todo when ALL hold: every comment is a machine
 *     comment (dispatch, claim, earlier reclaim), there is no session report,
 *     no owner marker (hasOwnerMarker, same test as the closer), and no gate
 *     evidence (PR-EVIDENCE line or runnable VERIFY: the closer's try-close
 *     owns those cards). Any human comment means someone engaged: keep.
 *   - its latest session report is not `blocked`: that report deliberately
 *     leaves the card In Progress (linear-session-reporting.js), and putting
 *     it back in Todo would make a worker hit the same blocker every ~2 days.
 *   - no LIVE land/ ref names it. A ref whose last Land run (or tip, with no
 *     run) is younger than ABANDONED_AFTER_DAYS belongs to the stranded pass
 *     and the cloud resume path (land-stranded-refs.js reopens those cards
 *     itself after HELD_CARD_DAYS). An older ref is abandoned and never routed
 *     by anything, so it does not block a reclaim; the comment names it.
 *     A ref whose age is unknown counts as live (fail safe). The caller dates a
 *     ref by the later of its last Land run and its tip commit, the same way
 *     land-stranded-refs.js decideStrandedRef dates a ref pushed after its run.
 *   - the comment thread is complete: with COMMENT_CAP comments returned the
 *     blocked report or the reclaim count might be cut off, so skip.
 *
 * Repeat reclaims: each reclaim comment carries RECLAIM_MARKER. A card already
 * reclaimed MAX_RECLAIMS times goes to Backlog with a note instead of Todo, so
 * a card that kills every session that takes it stops cycling.
 *
 * The cap (MAX_PER_RUN) limits moves, not reads: cards kept for a blocked
 * report or a live ref stay idle forever and would otherwise fill every slot.
 *
 * Pure functions only. The CLI is scripts/linear-reclaim-abandoned.js.
 */

'use strict';

const { ABANDONED_AFTER_DAYS } = require('./land-stranded-refs.js');
const { isRealInReview, hasOwnerMarker } = require('./in-review-backlog.js');

const HOUR_MS = 60 * 60 * 1000;
const RECLAIM_IDLE_MS = 48 * HOUR_MS;
const LIVE_LAND_REF_MS = ABANDONED_AFTER_DAYS * 24 * HOUR_MS;
const MAX_RECLAIMS = 2;
const MAX_PER_RUN = 40;
const COMMENT_CAP = 250;
const RECLAIM_MARKER = 'RECLAIMED-ABANDONED:';
// A "blocked" report this close to a Dispatched comment is not a verdict on the
// card (BRO-6085: BRO-5076/5150/5249 carry one in the same minute as the dispatch),
// so it must not pin the card against reclaim. MAX_RECLAIMS still caps the cycling
// if the blocker is real.
const DISPATCH_BLOCKED_WINDOW_MS = 5 * 60 * 1000;
const DISPATCH_COMMENT_RE = /^Dispatched\b/;
const NO_RECLAIM_RE = /^\s*NO-RECLAIM\s*:/im;
// Case-sensitive on purpose: owner cards are titled "👑 OWNER — ..."; a
// case-insensitive match would also catch "Owner-alert router ..." bugs.
const OWNER_CARD_RE = /\u{1F451}|^\W*OWNER\b/u;

/** Skip reason from the list fields alone (state, updatedAt, title, description), or null. */
function reclaimListSkipReason(issue, nowMs) {
  if (!issue || !issue.state || issue.state.type !== 'started') return 'not-started';
  if (/review/i.test(issue.state.name || '') && !isRealInReview(issue)) return 'in-review';
  const ms = Date.parse(issue.updatedAt);
  if (!Number.isFinite(ms)) return 'no-updated-at';
  if (nowMs - ms < RECLAIM_IDLE_MS) return 'recent';
  if (OWNER_CARD_RE.test(issue.title || '')) return 'owner-card';
  if (NO_RECLAIM_RE.test(issue.description || '')) return 'opted-out';
  return null;
}

/** Started cards idle past RECLAIM_IDLE_MS that pass the list rules, oldest first (uncapped: the caller caps moves). */
function findReclaimCandidates(issues, { nowMs }) {
  return (Array.isArray(issues) ? issues : [])
    .filter((iss) => reclaimListSkipReason(iss, nowMs) == null)
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

/** True for a `blocked` report within DISPATCH_BLOCKED_WINDOW_MS of any Dispatched comment (either side). */
function isDispatchTimeBlocked(report, comments) {
  const { parseSessionReportStatus } = require('./linear-session-reporting.js');
  if (parseSessionReportStatus(report && report.body) !== 'blocked') return false;
  const at = Date.parse(report.createdAt);
  return comments.some((c) => c && c !== report && DISPATCH_COMMENT_RE.test(String(c.body || '').trim())
    && Math.abs(Date.parse(c.createdAt) - at) <= DISPATCH_BLOCKED_WINDOW_MS);
}

function latestSessionReportStatus(comments) {
  const { parseSessionReportStatus } = require('./linear-session-reporting.js');
  const sorted = comments
    .filter((c) => c && Number.isFinite(Date.parse(c.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const c of sorted) {
    const s = parseSessionReportStatus(c.body);
    if (s != null && !isDispatchTimeBlocked(c, comments)) return s;
  }
  return null;
}

/** Dispatch receipt, claim note or an earlier reclaim note: nobody typed it. */
function isHolderOrReclaimComment(c) {
  const { HOLDER_COMMENT_RE } = require('./linear-session-reporting.js');
  const body = String((c && c.body) || '').trim();
  return HOLDER_COMMENT_RE.test(body) || body.startsWith(RECLAIM_MARKER) || body.startsWith(require('./linear-session-reporting.js').HEADLESS_END_MARKER);
}

/** Skip reason for an In Review card beyond the shared rules, or null (see header, BRO-6085). */
function inReviewSkipReason(issue, comments) {
  const commentText = comments.map((c) => c && c.body).filter(Boolean).join('\n');
  if (hasOwnerMarker({ ...issue, commentText })) return 'owner-marker';
  if (latestSessionReportStatus(comments) != null) return 'in-review-reported';
  if (!comments.every(isHolderOrReclaimComment)) return 'in-review-engaged';
  // A card with no dispatch receipt (hand-moved, or a session that never commented) is not the headless shape.
  if (!comments.some((c) => DISPATCH_COMMENT_RE.test(String((c && c.body) || '').trim()))) return 'in-review-no-dispatch';
  const { hasGateEvidence } = require('./stuck-card-closer.js');
  if (hasGateEvidence({ ...issue, comments })) return 'closer-owns';
  return null;
}

function reclaimCount(comments) {
  return comments.filter((c) => c && String(c.body || '').includes(RECLAIM_MARKER)).length;
}

/**
 * Full decision on a freshly fetched card.
 * @param {object} p
 * @param {object} p.issue - fresh card: state, updatedAt, title, description
 * @param {Array<{body:string, createdAt:string}>} p.comments - the card's comments (up to COMMENT_CAP)
 * @param {Array<{ref:string, lastActivityAt:?string}>} p.landRefs - land/ refs naming this card;
 *   lastActivityAt is the latest Land run's update time, or the tip's commit date with no run, null if unknown
 * @param {number} p.nowMs
 * @returns {{action:'skip', reason:string} | {action:'todo'|'backlog', reclaims:number, staleRefs:string[], idleHours:number}}
 */
function reclaimDecision({ issue, comments, landRefs, nowMs }) {
  const listReason = reclaimListSkipReason(issue, nowMs);
  if (listReason) return { action: 'skip', reason: listReason };
  const list = Array.isArray(comments) ? comments : [];
  if (list.length >= COMMENT_CAP) return { action: 'skip', reason: 'comments-truncated' };
  const newestComment = Math.max(-Infinity, ...list.map((c) => Date.parse(c && c.createdAt)).filter(Number.isFinite));
  const lastActivityMs = Math.max(Date.parse(issue.updatedAt), newestComment);
  if (nowMs - lastActivityMs < RECLAIM_IDLE_MS) return { action: 'skip', reason: 'recent-comment' };
  const isInReview = /review/i.test(issue.state.name || '');
  if (isInReview) {
    const why = inReviewSkipReason(issue, list);
    if (why) return { action: 'skip', reason: why };
  }
  if (latestSessionReportStatus(list) === 'blocked') return { action: 'skip', reason: 'blocked-report' };
  const refs = Array.isArray(landRefs) ? landRefs : [];
  const live = refs.filter((r) => {
    const ms = Date.parse(r && r.lastActivityAt);
    return !Number.isFinite(ms) || nowMs - ms < LIVE_LAND_REF_MS;
  });
  if (live.length) return { action: 'skip', reason: 'live-land-ref' };
  const reclaims = reclaimCount(list);
  return {
    action: reclaims >= MAX_RECLAIMS ? 'backlog' : 'todo',
    reclaims,
    staleRefs: refs.map((r) => r.ref),
    idleHours: Math.floor((nowMs - lastActivityMs) / HOUR_MS),
    priorState: issue.state.name,
  };
}

/** The comment posted with a reclaim. Carries RECLAIM_MARKER, which reclaimCount counts. */
function buildReclaimComment({ action, reclaims, staleRefs, idleHours, priorState }, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const lines = [
    `${RECLAIM_MARKER} ${day} (BRO-5100 hourly sweep)`,
    '',
    `This card sat ${priorState || 'In Progress'} with no Linear activity for ${idleHours}h and no live land/ branch, so the session that claimed it is presumed dead.`,
  ];
  if (staleRefs && staleRefs.length) {
    lines.push(`Land branches older than ${ABANDONED_AFTER_DAYS} days still name it (not landed, nothing retries them): ${staleRefs.join(', ')}.`);
  }
  if (action === 'backlog') {
    lines.push(`It has been reclaimed ${reclaims} times already, so it goes to Backlog instead of Todo: the sessions that take it keep dying. Someone should read the history before it is retried.`);
  } else {
    lines.push('Moved back to Todo so the board workers can take it again.');
  }
  lines.push('', 'To keep a card In Progress while nobody touches it (a tracker, a long hold), add a `NO-RECLAIM: <reason>` line to its description.');
  return lines.join('\n');
}

module.exports = {
  RECLAIM_IDLE_MS, LIVE_LAND_REF_MS, MAX_RECLAIMS, MAX_PER_RUN, COMMENT_CAP, RECLAIM_MARKER,
  DISPATCH_BLOCKED_WINDOW_MS, OWNER_CARD_RE, NO_RECLAIM_RE, isDispatchTimeBlocked,
  reclaimListSkipReason, findReclaimCandidates, reclaimDecision, buildReclaimComment,
};
