'use strict';
// BRO-6262 item 5: the Mac dispatcher (linear-next.js) auto-claimed BRO-6276 about a minute after a
// cloud session had posted "Claimed by <session>" on it, so two sessions worked one card. This is the
// pure check: a card whose newest "Claimed by" comment is recent, and not followed by anything that
// releases the claim, is held by a live session and must not be dispatched again.

const CLAIM_RE = /^Claimed by /;
// Comments a session or sweep posts when it lets go of a card (Codex bounces, watchdog parks, reports).
// The watchdog re-dispatches a dead job whose own claim has no release, so it passes --allow-fresh-claim.
const RELEASE_RE = /^(?:\*\*Session report\b|RECLAIMED-ABANDONED:|Auto-reset |Auto-corrected |Headless worker ended without|Watchdog safety net:|PR-EVIDENCE:|<!-- codex-runner|## Codex runner\b)/;
const FRESH_CLAIM_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Newest still-live claim on a card, or null.
 * @param {{body:string, createdAt:string}[]} comments
 * @param {number} nowMs
 * @param {{maxAgeMs?:number, selfRef?:string}} [opts] selfRef: this process's own session ref (never blocks itself)
 */
function findFreshClaim(comments, nowMs, { maxAgeMs = FRESH_CLAIM_MAX_MS, selfRef = '' } = {}) {
  const sorted = (comments || [])
    .map(c => ({ body: String((c && c.body) || '').trim(), ts: Date.parse(c && c.createdAt) }))
    .filter(c => Number.isFinite(c.ts))
    .sort((a, b) => a.ts - b.ts);
  let claim = null;
  for (const c of sorted) {
    if (CLAIM_RE.test(c.body)) claim = c;
    else if (claim && RELEASE_RE.test(c.body)) claim = null;
  }
  if (!claim) return null;
  if (nowMs - claim.ts >= maxAgeMs) return null;
  if (selfRef && claim.body.includes(selfRef)) return null;
  return { body: claim.body, ageMs: nowMs - claim.ts, holder: (claim.body.match(/^Claimed by (.+?) at /) || [])[1] || 'another session' };
}

/** Refusal text for the dispatcher, or null. Bypassed by --force / --allow-fresh-claim / previews. */
function freshClaimGuard(identifier, comments, nowMs, opts = {}) {
  if (opts.force || opts['allow-fresh-claim'] || opts['dry-run'] || opts['print-prompt']) return null;
  const hit = findFreshClaim(comments, nowMs, { selfRef: opts.selfRef });
  if (!hit) return null;
  return `REFUSING to dispatch ${identifier}: ${hit.holder} claimed it ${Math.round(hit.ageMs / 60000)} min ago and has not ` +
    `reported or released it. A second session would double-work the card. Wait for that session's report, or ` +
    `re-run with --allow-fresh-claim if you know it is dead.`;
}

module.exports = { findFreshClaim, freshClaimGuard, FRESH_CLAIM_MAX_MS, CLAIM_RE, RELEASE_RE };
