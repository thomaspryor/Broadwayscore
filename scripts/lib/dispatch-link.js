// Signed "Fix this" links for the digest emails (card #634 — owner ask
// 2026-07-30: tap a button in the digest, get a session dispatched on the
// issue, no laptop required).
//
// Deliberately separate from scripts/lib/autonomous-links.js's approve/
// reject/revert scheme: those sign against an EXISTING card (cardId +
// branch); a "Fix this" tap has neither — the card doesn't exist yet, it
// gets created on click. Message format here MUST match the verification in
// src/app/api/autonomous-action/route.ts (handleDispatch) — change them
// together, same convention as autonomous-links.js's own header comment.

'use strict';

const crypto = require('crypto');

// description travels in the signed message too (ship-check adversarial
// finding, codex 2026-07-30: a card with only a check NAME and no detail
// lets a dispatched session "fix" the wrong thing, especially once a check
// name outlives several different failure reasons). Defaults to '' so a
// caller that only has a title still gets a stable signature.
function buildDispatchSignature({ conditionKey, title, description = '', exp, secret }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`dispatch:${conditionKey}:${title}:${description}:${exp}`)
    .digest('hex');
}

/**
 * Build a full signed URL for the dispatch action. exp is a unix timestamp
 * in SECONDS (integer). title/description are truncated to keep the URL and
 * the eventual Notion card bounded.
 */
function buildDispatchUrl({ conditionKey, title, description = '', exp, secret, baseUrl }) {
  const clippedTitle = String(title).slice(0, 140);
  const clippedDescription = String(description || '').slice(0, 300);
  const sig = buildDispatchSignature({ conditionKey, title: clippedTitle, description: clippedDescription, exp, secret });
  const params = new URLSearchParams({
    action: 'dispatch',
    conditionKey: String(conditionKey),
    title: clippedTitle,
    exp: String(exp),
    sig,
  });
  if (clippedDescription) params.set('description', clippedDescription);
  return `${baseUrl}/api/autonomous-action?${params.toString()}`;
}

/**
 * Verify a signature. Returns boolean; never throws on junk input (bad hex,
 * wrong length, empty string) — same hardening as autonomous-links.js's
 * verifySignature (a truncated-hex tamper must not silently decode back to
 * the valid signature).
 */
function verifyDispatchSignature({ conditionKey, title, description = '', exp, secret, sig }) {
  if (!sig || typeof sig !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = buildDispatchSignature({ conditionKey, title, description, exp, secret });
  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(sig, 'hex');
  if (sigBuf.length !== expectedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

// Statuses that count as "still open" on their own — a card in either state
// means a session is already working the issue (or about to), so a repeat
// tap is a no-op. 'Done'/'Paused' cards are resolved: a fresh tap should be
// allowed to open a new one (mirrors owner-alert-router's resolveCondition()
// semantics — a recurred condition is a NEW incident).
const OPEN_STATUSES = new Set(['Not started', 'In progress']);

/**
 * Pick the first still-open card from a list of Notion page summaries
 * already filtered (by the caller's Notion query) to ones whose Notes
 * mention this conditionKey. Pure so the "second click is a no-op" decision
 * is unit-testable without a live Notion query.
 *
 * A card is open if EITHER its Status is Not-started/In-progress, OR its
 * Action property is still set — not Status alone. scripts/notion-action-poll.js
 * only ever looks at Action (`Action is-not-empty`, see getActionableCards())
 * and never reads Status at all, so a card manually flipped to Status=Paused
 * while Action=Fix is still set will STILL be picked up and run by the
 * poller's next tick. Treating Paused-with-Action-set as "resolved" here
 * (ship-check adversarial finding, codex 2026-07-30) would let a second tap
 * file a SECOND Fix card for the same condition — now two pipelines running
 * concurrently on one issue. action is cleared by clearAction() exactly when
 * a card's work is actually done (success or 3-strikes give-up), so
 * `action != null` is the more correct "still pending" signal.
 */
function selectOpenDispatchCard(candidates) {
  if (!Array.isArray(candidates)) return null;
  return candidates.find(c => c && (OPEN_STATUSES.has(c.status) || (c.action != null && c.action !== ''))) || null;
}

module.exports = {
  buildDispatchSignature,
  buildDispatchUrl,
  verifyDispatchSignature,
  selectOpenDispatchCard,
  OPEN_STATUSES,
};
