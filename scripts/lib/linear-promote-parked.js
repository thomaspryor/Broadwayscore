/**
 * linear-promote-parked.js — pure selection for the cloud-hosted unpark pass (BRO-5626).
 *
 * The Mac drain (linear-drain-parked.js) was the only thing that moved a parked
 * technical card out of Backlog; with it gone, cloud-worker-pick.js skipped 183
 * Backlog cards as 'parked-or-backlog' forever. This decides which of them are
 * safe to move to Todo, where the picker (and Codex) take them like any other card.
 * Moving to Todo is the whole action: the picker's own guards (verify, headless
 * blockers, pause history, owner-wait) still run on every pick.
 *
 * A Backlog card is promoted only when ALL hold:
 *   - it carries a PARKED line (a paused-by-worker Backlog card is the picker's already)
 *   - it has a safe-form, cloud-runnable VERIFY and no other headless blocker
 *     (headlessUnfitReason with the PARKED sentinel waived)
 *   - no PARKED reason names something only the owner can supply (OWNER_ONLY_PARK_RE:
 *     money, login, Mac, taste, bulk change, ...) or a date/event to wait for
 *   - it is not labelled awaiting-owner and its text does not ask for an owner decision
 * Machine-filed parks (digest-autofix, alert router) are left to the picker's
 * stale-automation rule. Cards that fail only on "no safe VERIFY" are reported
 * separately so the arming pass can write one (never mass-closed).
 */
'use strict';

const PARK_LINE_RE = /^\s*PARKED\s*:(.*)$/gim;
// A park that waits on a calendar date or another event, not on a person.
const WAIT_PARK_RE = /\b(?:until|waiting (?:on|for)|wait (?:for|until)|once\b|after (?:the |a |\d)|in \d+ (?:days?|weeks?)|\d{4}-\d{2}-\d{2}|reset)\b/i;
const OWNER_TEXT_RE = /\bDECISION NEEDED\b|\bowner(?:'s)?\s+(?:decision|approval|sign[- ]?off|go[- ]ahead|call)\b|\b(?:waiting|wait|pending|blocked)\s+(?:on|for)\s+(?:the\s+|an?\s+)?(?:owner|thomas)\b/i;

function parkReasons(description) {
  return [...String(description || '').matchAll(PARK_LINE_RE)].map((m) => m[1].trim());
}

/**
 * -> { promote: boolean, reason: string } where reason is why not (or 'ok').
 * Reasons: not-backlog, no-priority, no-park-line, machine-filed, owner-only-park, wait-park,
 * awaiting-owner, owner-text, no-safe-verify, owner-judgment, blocker-*, ios-app-repo, ...
 */
function promotionDecision(issue) {
  const hd = require('./headless-dispatchability.js');
  const { headlessUnfitReason } = require('./cloud-worker-pick.js');
  const { isAwaitingOwner } = require('./owner-approval-channel.js');
  if (!issue || !issue.state || issue.state.type !== 'backlog') return { promote: false, reason: 'not-backlog' };
  if (![1, 2, 3, 4].includes(Number(issue.priority))) return { promote: false, reason: 'no-priority' };
  const description = issue.description || '';
  const reasons = parkReasons(description);
  if (!reasons.length) return { promote: false, reason: 'no-park-line' };
  if (hd.isAutomationParked(description)) return { promote: false, reason: 'machine-filed' };
  if (reasons.some((r) => hd.OWNER_ONLY_PARK_RE.test(r))) return { promote: false, reason: 'owner-only-park' };
  if (OWNER_TEXT_RE.test(reasons.join('\n'))) return { promote: false, reason: 'owner-text' };
  if (reasons.some((r) => WAIT_PARK_RE.test(r))) return { promote: false, reason: 'wait-park' };
  if (isAwaitingOwner(issue)) return { promote: false, reason: 'awaiting-owner' };
  const unfit = headlessUnfitReason(issue, { allowParkedSentinel: true });
  if (unfit) return { promote: false, reason: unfit };
  return { promote: true, reason: 'ok' };
}

/** Tally of decision reasons over a card list, plus the promotable cards (most urgent, then oldest, first). */
function planPromotion(issues, { limit = Infinity } = {}) {
  const { priorityRank } = require('./linear-dispatch.js');
  const { issueNumber } = require('./linear-drain-parked.js');
  const tally = {};
  const promote = [];
  for (const iss of Array.isArray(issues) ? issues : []) {
    const d = promotionDecision(iss);
    tally[d.reason] = (tally[d.reason] || 0) + 1;
    if (d.promote) promote.push(iss);
  }
  promote.sort((a, b) => (priorityRank(a) - priorityRank(b)) || (issueNumber(a.identifier) - issueNumber(b.identifier)));
  return { promote: promote.slice(0, Math.max(0, limit)), eligible: promote.length, tally };
}

// The picker treats a PARKED line as a headless blocker unless the park reason is
// itself drainable, so a card moved to Todo must stop carrying the sentinel.
const UNPARKED_PREFIX = 'Was parked (technical reason, safe VERIFY; moved to Todo by BRO-5626):';
function unparkDescription(description) {
  return String(description || '').replace(/^(\s*)PARKED\s*:/gim, `$1${UNPARKED_PREFIX}`);
}

const PROMOTE_COMMENT_MARKER = 'UNPARKED-BY-CLOUD-DRAIN:';
function buildPromoteComment(issue) {
  return `${PROMOTE_COMMENT_MARKER} moved from Backlog to Todo (BRO-5626). The park reason is technical and the card has a safe VERIFY, so a worker can take it. `
    + 'Park reason(s): ' + (parkReasons(issue.description).join(' | ').slice(0, 300) || 'n/a');
}

module.exports = { unparkDescription, UNPARKED_PREFIX, promotionDecision, planPromotion, parkReasons, buildPromoteComment, PROMOTE_COMMENT_MARKER, WAIT_PARK_RE, OWNER_TEXT_RE };
