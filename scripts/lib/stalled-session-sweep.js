'use strict';
/**
 * Stalled-session sweep (BRO-7183). The durable backstop for sessions that promised later work
 * and then went quiet: a cloud session can't schedule its own wake (send_later always prompts),
 * and a background waiter dies with its container (BRO-6947), so something outside the stalled
 * session has to notice. The board-workers routine runs this every firing (docs/cloud-routines/board-workers.md).
 *
 * Shape: `linear-reclaim-abandoned.js --stalled-sessions` lists In Progress cards idle STALL_IDLE_MS+
 * whose newest "Claimed by https://claude.ai/code/session_..." comment names a cloud session (the
 * reclaim exclusions apply: owner cards, NO-RECLAIM, blocked report, live land ref). The routine
 * reads each session with get_session (an MCP tool, so only a Claude session can), then
 * `--stall-act --from-json` decides per card with stalledSessionAction():
 *   working (child-idle-watch says rearm)       -> skip
 *   blocked on a prompt                         -> skip (a message cannot answer a permission prompt)
 *   archived, or get_session says not found     -> requeue to Todo (the session is gone)
 *   idle / finished / failed, < MAX_NUDGES      -> nudge (send_message), at most one per NUDGE_GAP_MS
 *   idle after MAX_NUDGES nudges NUDGE_GAP_MS+ ago -> requeue (it ignored two nudges)
 * Nudges are recorded as STALL_NUDGE_MARKER comments, which is also the per-card ledger. A nudge comment
 * counts as card activity, so it pushes the 48h reclaim back; the sweep's own requeue after MAX_NUDGES
 * ignored nudges (NUDGE_GAP_MS apart) is what ends that.
 * The hourly reclaim (48h -> Todo) stays the backstop that needs no Claude.
 */
const { decide } = require('./child-idle-watch.js');
const { reclaimDecision, RECLAIM_MARKER } = require('./linear-reclaim-abandoned.js');

const HOUR_MS = 60 * 60 * 1000;
const STALL_IDLE_MS = 12 * HOUR_MS;
const NUDGE_GAP_MS = 24 * HOUR_MS;
const MAX_NUDGES = 2;
const MAX_NUDGES_PER_RUN = 5;
const MAX_REQUEUES_PER_RUN = 5;
const STALL_NUDGE_MARKER = 'STALL-NUDGE:';
const CLOUD_CLAIM_RE = /^Claimed by https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/;
const ANY_CLAIM_RE = /^Claimed by /;
// Only a get_session answer that names the session as missing. A bare "not found" or 404 can come from
// a proxy or a wrong tool name, and requeueing a live card on that would hand its work to a second worker.
const NOT_FOUND_RE = /\bsession\b[^.\n]{0,40}\b(?:not found|does not exist)\b|\bno such session\b/i;

const ms = (c) => Date.parse(c && c.createdAt);
const byNewest = (a, b) => ms(b) - ms(a);

/**
 * One listed card -> a sweep entry, or a skip.
 * @param {{issue:object, comments:Array<{body:string,createdAt:string}>, landRefs:Array, nowMs:number, idleMs?:number}} p
 * @returns {{action:'skip', reason:string} | {action:'check', card:string, title:string, sessionId:string, idleHours:number, nudges:number, lastNudgeAt:?string}}
 */
function stalledSessionEntry({ issue, comments, landRefs, nowMs, idleMs = STALL_IDLE_MS }) {
  if (!issue || !issue.state || issue.state.name !== 'In Progress') return { action: 'skip', reason: 'not-in-progress' };
  const list = Array.isArray(comments) ? comments.filter((c) => c && c.body != null) : [];
  const d = reclaimDecision({ issue, comments: list, landRefs, nowMs, idleMs });
  if (d.action === 'skip') return d;
  const claim = list.filter((c) => ANY_CLAIM_RE.test(String(c.body))).sort(byNewest)[0];
  if (!claim) return { action: 'skip', reason: 'no-claim' };
  const m = String(claim.body).match(CLOUD_CLAIM_RE);
  if (!m) return { action: 'skip', reason: 'not-a-cloud-session' };
  // Nudges only count against this claim: a new claim or a reclaim starts a fresh ledger.
  const since = Math.max(ms(claim), ...list.filter((c) => String(c.body).startsWith(RECLAIM_MARKER)).map(ms).filter(Number.isFinite));
  const nudges = list.filter((c) => String(c.body).startsWith(STALL_NUDGE_MARKER) && ms(c) >= since).sort(byNewest);
  return {
    action: 'check', card: issue.identifier, title: String(issue.title || '').slice(0, 100), sessionId: m[1],
    idleHours: d.idleHours, nudges: nudges.length, lastNudgeAt: nudges[0] ? nudges[0].createdAt : null,
    requeueTo: d.action === 'backlog' ? 'Backlog' : 'Todo', reclaims: d.reclaims,
  };
}

/**
 * Decide from an entry plus its get_session result (or the error get_session gave).
 * @returns {{action:'nudge'|'requeue'|'skip', reason:string}}
 */
function stalledSessionAction({ entry, session, error, notFound, nowMs }) {
  if (!entry || entry.action !== 'check') return { action: 'skip', reason: 'not-a-check-entry' };
  if (error != null || session == null) {
    const msg = String(error || 'no get_session result');
    return (notFound === true || NOT_FOUND_RE.test(msg)) ? { action: 'requeue', reason: `session not found (${msg.slice(0, 80)})` }
      : { action: 'skip', reason: `get_session failed, retry next firing (${msg.slice(0, 80)})` };
  }
  const v = decide({ session, now: nowMs, idleMinutes: 60 });
  const archived = /archived/i.test(String(v.reason)) || session.archived === true;
  if (archived) return { action: 'requeue', reason: 'session archived with the card still In Progress' };
  if (v.action === 'rearm') return { action: 'skip', reason: `session working (${v.reason})` };
  if (v.action === 'unblock') return { action: 'skip', reason: `session waiting on a prompt (${v.reason}); a message cannot answer it` };
  const lastNudgeMs = Date.parse(entry.lastNudgeAt);
  if (Number.isFinite(lastNudgeMs) && nowMs - lastNudgeMs < NUDGE_GAP_MS) return { action: 'skip', reason: 'nudged under 24h ago' };
  if (entry.nudges >= MAX_NUDGES) return { action: 'requeue', reason: `ignored ${entry.nudges} nudges` };
  return { action: 'nudge', reason: v.reason };
}

/** The send_message text. Told not to reply, so a nudge never starts a conversation loop. */
function buildStallNudgeMessage(entry) {
  return `Automated stall check (BRO-7183): your card ${entry.card} has been idle ${entry.idleHours}h with no report. `
    + 'Read the card state before redoing anything. If the work is done, close the card; if it is blocked, report it with '
    + '`node scripts/linear-session.js report --status=paused` or move it to Paused. Do not reply to this message.';
}

function buildStallNudgeComment(entry, nowMs) {
  return `${STALL_NUDGE_MARKER} ${new Date(nowMs).toISOString()} nudged ${entry.sessionId} (idle ${entry.idleHours}h, nudge ${entry.nudges + 1} of ${MAX_NUDGES}). `
    + `After ${MAX_NUDGES} ignored nudges the stalled-session sweep moves the card back to Todo.`;
}

/** Carries RECLAIM_MARKER so the reclaim count (MAX_RECLAIMS -> Backlog) sees stall requeues too. */
function buildStallRequeueComment(entry, reason, nowMs) {
  return [
    `${RECLAIM_MARKER} ${new Date(nowMs).toISOString().slice(0, 10)} (BRO-7183 stalled-session sweep)`,
    '',
    `This card sat In Progress for ${entry.idleHours}h and the session that claimed it (${entry.sessionId}) is not coming back: ${reason}.`,
    entry.requeueTo === 'Backlog'
      ? `It has been reclaimed ${entry.reclaims} times already, so it goes to Backlog instead of Todo: someone should read the history before it is retried.`
      : 'Moved back to Todo so the board workers can take it again. Read the comments above before redoing anything: part of the work may have landed.',
    '',
    'To keep a card In Progress while nobody touches it, add a `NO-RECLAIM: <reason>` line to its description.',
  ].join('\n');
}

module.exports = {
  STALL_IDLE_MS, NUDGE_GAP_MS, MAX_NUDGES, MAX_NUDGES_PER_RUN, MAX_REQUEUES_PER_RUN, STALL_NUDGE_MARKER,
  stalledSessionEntry, stalledSessionAction, buildStallNudgeMessage, buildStallNudgeComment, buildStallRequeueComment,
};
