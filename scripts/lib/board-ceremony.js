'use strict';
/**
 * board-ceremony.js: which cards are bookkeeping rather than work (BRO-7595).
 *
 * Leaf module so board-summary.js (the digest headline) and board-numbers.js
 * (the technical table) share one rule without board-summary loading the
 * heavy board-numbers module. Keep this narrow: a repair ABOUT a routine is
 * work, not the routine's daily log.
 *
 * Kinds:
 *   canary          [E2E Canary] alarms and sessions' own "TEST (BRO-N): ... safe to ignore" cards
 *   duplicate       closed as a Duplicate of another card (BRO-6130)
 *   routineLog      Opening-night watch/audit, CANARY: touch, Week in Review
 *   sessionTracking a session-filed card closed within 6h of being opened
 */
const cardDedupe = require('./card-dedupe.js');

const SESSION_TRACKING_MAX_MS = 6 * 3600_000;

function ceremonyKind(card, nowMs) {
  const title = String(card.title || '').trim();
  if (/^\[E2E Canary\]/i.test(title)) return 'canary';
  // BRO-6338: sessions' own end-to-end test cards ("TEST (BRO-6235): ... safe to ignore") close themselves.
  if (/^TEST \(BRO-\d+\):.*\bsafe to ignore\b/i.test(title)) return 'canary';
  // BRO-6130: a card closed as a Duplicate of another is the same work counted twice.
  if (String(card.state && card.state.name || '').trim().toLowerCase() === 'duplicate') return 'duplicate';
  if (/^Opening-night (?:watch|audit) \d{4}-\d{2}-\d{2}$/i.test(title)
    || /^CANARY: touch\b/i.test(title)
    || /^Week in Review(?:\s*[,—:-]\s*|\s+)\d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?$/i.test(title)) return 'routineLog';
  const created = Date.parse(card.createdAt);
  const closed = Date.parse(card.completedAt || card.canceledAt);
  // A quick automated repair or an unmarked card is still real work. Only
  // explicitly session-filed cards qualify; never guess from updatedAt.
  if (cardDedupe.inferCardSource(card) === 'session' && closed <= nowMs
    && closed >= created && closed - created <= SESSION_TRACKING_MAX_MS) return 'sessionTracking';
  return null;
}

module.exports = { ceremonyKind, SESSION_TRACKING_MAX_MS };
