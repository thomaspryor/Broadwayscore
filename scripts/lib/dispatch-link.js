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

/**
 * Attach a signed Fix-this URL to every ERROR row of a health-digest
 * snapshot, in place. Shared by BOTH email senders on purpose: this used to
 * be an inline loop in autonomous-email.js only, and when the autonomous
 * loop was paused (task #599) the buttons silently stopped reaching any
 * delivered email — send-morning-digest.js, the owner's ONE daily send,
 * rendered "Fix needed: …" rows with nothing to tap. One function, both
 * callers, so a future sender can't drift out of the feature again.
 *
 * conditionKey convention (`health-check:${name}`) matches health-check.js's
 * own routeAlert() call, so a tap on an issue that already auto-dispatched
 * lands on the SAME open card instead of filing a duplicate (see
 * handleDispatch's Notion dedup query in api/autonomous-action/route.ts).
 *
 * Returns the number of rows given a URL. Missing secret/baseUrl returns 0
 * and attaches nothing rather than throwing: the morning digest must still
 * send (buttonless) if the secret is absent — a missing env var must never
 * cost the owner the whole email.
 */
function attachHealthFixUrls({ health, exp, secret, baseUrl }) {
  if (!health || !Array.isArray(health.errors)) return 0;
  if (!secret || !baseUrl) return 0;
  let attached = 0;
  for (const e of health.errors) {
    if (!e || !e.name) continue;
    e.fixUrl = buildDispatchUrl({
      conditionKey: `health-check:${e.name}`,
      title: `BSC Daily: ${e.name}`,
      description: e.message || '',
      exp,
      secret,
      baseUrl,
    });
    attached++;
  }
  return attached;
}

module.exports = {
  buildDispatchSignature,
  buildDispatchUrl,
  verifyDispatchSignature,
  selectOpenDispatchCard,
  attachHealthFixUrls,
  OPEN_STATUSES,
};
