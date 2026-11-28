#!/usr/bin/env node
'use strict';
/**
 * BRO-7686/7689: which past-date Paused cards are NOT owed a check, by the nightly recheck's own
 * hand-off rules (recheck-handoff.js decideHandoff). Kept in its own light module: the morning
 * digest (board-summary.js, board-categories.js) must load only built-ins and repo files
 * (tests/unit/morning-digest-action.test.mjs), and recheck-handoff.js pulls in the scraper chain.
 */
const { RECHECK_HANDOFF_MARKER, parseRecheckAfter } = require('./autonomous-recheck-core.js');

function lastStampIndex(comments) {
  for (let i = comments.length - 1; i >= 0; i--) if (parseRecheckAfter(comments[i]) != null) return i;
  return -1;
}

// BRO-7686/7689: how long a hand-off keeps a past-date card off the "owed a check" count.
// A worker who re-paused it without a fresh stamp left it where the recheck never acts again.
const HANDOFF_GRACE_DAYS = 7;

/** Held on purpose (a held PARKED line or a DECISION NEEDED in the notes): the recheck never hands it to a worker. */
function isHeldForHandoff(notes) {
  return require('./headless-dispatchability.js').hasHeldParkLine(notes) || /DECISION NEEDED/.test(String(notes || ''));
}

/**
 * PURE. Why a card past its RECHECK-AFTER date is NOT owed a check, using decideHandoff's own
 * skip rules. card = mapIssueToCard shape (notes, comments oldest-first, commentRecords).
 * -> 'parked' | 'handed-off' (within HANDOFF_GRACE_DAYS) | null (owed a check)
 * Shared by the digest headline (board-summary.js) and the board table (board-categories.js).
 */
function pastDateHold(card, nowMs) {
  if (!card) return null;
  if (isHeldForHandoff(card.notes)) return 'parked';
  const comments = Array.isArray(card.comments) ? card.comments : [];
  const records = Array.isArray(card.commentRecords) ? card.commentRecords : [];
  let handoffAt = null;
  for (let i = lastStampIndex(comments) + 1; i < comments.length; i++) {
    if (String(comments[i] || '').trimStart().startsWith(RECHECK_HANDOFF_MARKER)) handoffAt = Date.parse((records[i] && records[i].createdAt) || '') || 0;
  }
  return handoffAt !== null && nowMs - handoffAt < HANDOFF_GRACE_DAYS * 86_400_000 ? 'handed-off' : null;
}

module.exports = { HANDOFF_GRACE_DAYS, isHeldForHandoff, pastDateHold, lastStampIndex };
