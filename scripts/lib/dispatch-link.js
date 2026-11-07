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
 * the eventual Linear issue bounded.
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

// The "is this condition already being worked?" dedupe now lives with the
// route: src/lib/linear-dispatch-issue.js pickCanonicalIssue (BRO-4718). The
// Notion-card selectOpenDispatchCard that used to sit here was removed with
// the Notion dispatch path.

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
 * handleDispatch's Linear dedup query in api/autonomous-action/route.ts).
 *
 * Returns the number of rows given a URL. Missing secret/baseUrl returns 0
 * and attaches nothing rather than throwing: the morning digest must still
 * send (buttonless) if the secret is absent — a missing env var must never
 * cost the owner the whole email.
 */
function attachHealthFixUrls({ health, exp, secret, baseUrl }) {
  if (!health) return 0;
  if (!secret || !baseUrl) return 0;
  let attached = 0;
  // Owner escalation 2026-08-01: WARNINGS get buttons too. Errors-only meant
  // the 2026-08-01 digest carried 1 tappable row and 13 dead ones — "a bunch
  // of other shit with no actions to take". A warning the owner can't act on
  // is either noise (and should not be in the email) or work (and needs a
  // button); there is no third category, so every named row gets one.
  const named = [
    ...(Array.isArray(health.errors) ? health.errors : []),
    ...(Array.isArray(health.warnings) ? health.warnings : []),
    ...(Array.isArray(health.warns) ? health.warns : []),
  ];
  for (const e of named) {
    if (!e || !e.name) continue;
    if (e.fixUrl) continue; // health.warnings/health.warns may alias one array
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
  attachHealthFixUrls,
};
