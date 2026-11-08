'use strict';
/**
 * red-escalation.js — BRO-7102: when one main-red signature stays red, put its
 * EXISTING card in front of a worker instead of raising a new alert.
 *
 * Before: route-main-streak-signatures.js raised 'test-yml:main-streak-escalation'
 * at streak >= 4 with disposition 'human'. 'human' is page-gated (BRO-4141), so it
 * was downgraded to the digest every time and never dispatched anything (218
 * notifications, BRO-7048 parked). Meanwhile the per-signature card that could
 * fix it sat where it fell: Medium Todo (the cloud worker takes P0/P1 only),
 * Paused, or waiting on the Mac-only red-first pass while the Mac was off.
 *
 * Now: each still-failing signature whose ledger incident is ESCALATION_HOURS
 * old gets its own card bumped to High, moved to Todo when a worker paused it,
 * and stamped with a fresh START-NOW line plus a START-NOW-SINCE stamp, which
 * the cloud board worker (cloud-worker-pick.js isStartNow) takes on its next
 * firing. The Mac lane had the first ESCALATION_HOURS; after that both lanes
 * may take it, and both only take an unstarted card, so a claim by one moves
 * it out of the other's reach. Never a new card, never a new condition key.
 *
 * Kill switch: RED_ESCALATION_DISABLED=true.
 */

const ESCALATION_HOURS = 6;
// Re-stamp at most this often per signature (a card a worker took and paused
// again is put back in front once a day, not on every red push).
const RESTAMP_HOURS = 24;
// A started card touched this recently is being worked: leave it alone.
const ACTIVE_WORK_HOURS = 6;
const HOUR_MS = 60 * 60 * 1000;
const HIGH_PRIORITY = 2;
const START_NOW_LINE_RE = /^\s*START-NOW\s*:.*$/gim;
const START_NOW_SINCE_RE = /^\s*START-NOW-SINCE\s*:.*$/gim;
const PARKED_LINE_RE = /^\s*PARKED\s*:/im;
const NO_DISPATCH_RE = /^\s*NO-DISPATCH\s*:/im;
const TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);
const HOLD_HISTORY_REASONS = new Set(['awaiting-owner', 'recheck-pending', 'reclaimed-to-backlog', 'backlog-unexplained']);
// Holds that keep the priority bump but get no START-NOW: another cloud attempt
// would hit the same wall the last one reported.
const NO_STAMP_HISTORY_REASONS = new Set(['paused-repeatedly', 'lane-unworkable']);

/**
 * PURE. Should this open red-signature condition put its card in front now?
 * @param {{condition: object, card: (object|null), nowMs: number, env?: object}} p
 *   condition: the alert-ledger entry (incidentOpenedAt, linearIdentifier, escalatedAt)
 *   card: { identifier, priority, description, updatedAt, state: { type, name } } or null
 *   historyReason: cloud-worker-pick historySkipReason() for the card's comments, if read
 * @returns {{escalate: boolean, reason: string, ageHours: (number|null)}}
 */
function decideRedEscalation({ condition, card, nowMs, env = process.env, thresholdHours = ESCALATION_HOURS, historyReason = null, comments = null }) {
  if (env && env.RED_ESCALATION_DISABLED === 'true') return { escalate: false, reason: 'kill-switch', ageHours: null };
  if (!condition || condition.status !== 'open') return { escalate: false, reason: 'not-open', ageHours: null };
  const openedMs = Date.parse(condition.incidentOpenedAt || condition.firstSeen || '');
  if (!Number.isFinite(openedMs) || !Number.isFinite(nowMs)) return { escalate: false, reason: 'no-incident-start', ageHours: null };
  const ageHours = Math.max(0, (nowMs - openedMs) / HOUR_MS);
  if (ageHours < thresholdHours) return { escalate: false, reason: 'too-young', ageHours };
  const lastMs = Date.parse(condition.escalatedAt || '');
  if (Number.isFinite(lastMs) && nowMs - lastMs < RESTAMP_HOURS * HOUR_MS) return { escalate: false, reason: 'escalated-recently', ageHours };
  if (!card) return { escalate: false, reason: 'no-card', ageHours };
  // Card-side guard: the ledger escalatedAt only persists when the ledger commit
  // step's push wins, and two main runs on back-to-back pushes read the same
  // ledger. The card's own escalation comment is the state both runs can see.
  const cardLastMs = lastEscalationCommentMs(comments);
  if (cardLastMs != null && nowMs - cardLastMs < RESTAMP_HOURS * HOUR_MS) return { escalate: false, reason: 'escalated-recently-card', ageHours };
  const type = card.state && card.state.type;
  if (TERMINAL_STATE_TYPES.has(type)) return { escalate: false, reason: `card-${type}`, ageHours };
  const desc = String(card.description || '');
  // A person's hold (PARKED line) or a NO-DISPATCH marker is the owner's call; leave it.
  if (PARKED_LINE_RE.test(desc)) return { escalate: false, reason: 'owner-held', ageHours };
  if (NO_DISPATCH_RE.test(desc)) return { escalate: false, reason: 'no-dispatch-marker', ageHours };
  // cloud-worker-pick historySkipReason holds that are someone else's call: the
  // owner (awaiting-owner), a RECHECK-AFTER date (recheck-pending), or a person
  // reading the history after the reclaim sweep sent it to Backlog
  // (reclaimed-to-backlog, backlog-unexplained). Leave those cards alone.
  if (HOLD_HISTORY_REASONS.has(historyReason)) return { escalate: false, reason: historyReason, ageHours };
  if (type === 'started') {
    const touchedMs = Date.parse(card.updatedAt || '');
    if (Number.isFinite(touchedMs) && nowMs - touchedMs < ACTIVE_WORK_HOURS * HOUR_MS) return { escalate: false, reason: 'being-worked', ageHours };
  }
  return { escalate: true, reason: 'red-too-long', ageHours };
}

// A lowercase hyphenated tag, so cloud-worker-pick isMachineComment (MACHINE_TAG_RE)
// reads it as automation: it must never count as a person answering a pause.
const ESCALATION_COMMENT_PREFIX = '[red-escalation]';

/** PURE. Newest createdAt (ms) of an escalation comment this script wrote, or null. */
function lastEscalationCommentMs(comments) {
  let best = null;
  for (const c of comments || []) {
    if (!c || !String(c.body || '').startsWith(ESCALATION_COMMENT_PREFIX)) continue;
    const ms = Date.parse(c.createdAt || '');
    if (Number.isFinite(ms) && (best == null || ms > best)) best = ms;
  }
  return best;
}

/**
 * PURE. The card description with one fresh START-NOW / START-NOW-SINCE pair at
 * the top (older pairs removed, so the stamp the cloud worker reads is this one).
 */
function stampStartNow(description, { ageHours, nowIso }) {
  const body = String(description || '').replace(START_NOW_LINE_RE, '').replace(START_NOW_SINCE_RE, '').replace(/^\n+/, '');
  const hours = Math.floor(Number(ageHours) || 0);
  return `START-NOW: main has been red on this signature for ${hours}h (BRO-7102 escalation)\nSTART-NOW-SINCE: ${nowIso}\n\n${body}`;
}

/**
 * PURE. The Linear issueUpdate input for an escalation, and what it changes.
 * @param {{card: object, ageHours: number, nowIso: string, todoStateId: (string|null), pickable: boolean}} p
 */
function escalationUpdate({ card, ageHours, nowIso, todoStateId, pickable }) {
  const input = {};
  const changes = [];
  const p = Number(card.priority);
  if (!(p >= 1 && p <= HIGH_PRIORITY)) { input.priority = HIGH_PRIORITY; changes.push(`priority ${p || 'none'} -> High`); }
  // Backlog/Paused, or a started card nobody touched for ACTIVE_WORK_HOURS (stuck):
  // the cloud worker only takes unstarted cards, so put it back in Todo.
  if (card.state && (card.state.type === 'backlog' || card.state.type === 'started') && todoStateId) { input.stateId = todoStateId; changes.push(`${card.state.name || 'backlog'} -> Todo`); }
  if (pickable) { input.description = stampStartNow(card.description, { ageHours, nowIso }); changes.push('START-NOW stamped'); }
  return { input, changes };
}

module.exports = {
  ESCALATION_HOURS, RESTAMP_HOURS, ACTIVE_WORK_HOURS, HIGH_PRIORITY,
  ESCALATION_COMMENT_PREFIX, HOLD_HISTORY_REASONS, NO_STAMP_HISTORY_REASONS,
  decideRedEscalation, stampStartNow, escalationUpdate, lastEscalationCommentMs,
};
