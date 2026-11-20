'use strict';
/**
 * card-not-before.js — the prompt-free "check this again later" hold (BRO-7880).
 *
 * send_later / create_trigger put an approval prompt on the owner's phone on
 * every call (BRO-4236), so a session that wants a re-check tomorrow files an
 * ordinary Todo card with a `NOT-BEFORE: <ISO time>` line instead:
 *
 *   node scripts/linear-brain.js create "<title>" --dispatch --not-before 2026-11-21T01:40:00Z --notes "..."
 *
 * Every board picker asks notBeforeHoldReason() and leaves the card alone until
 * that time; after it the card is ordinary worker work. Pickers that honor it:
 * cloud-worker-pick.js skipReason (the cloud board worker, the Codex runner's
 * list and its claim-time re-check), linear-drain-parked.js
 * selectDrainCandidates (the Mac drain) and linear-next.js (refuses without
 * --force).
 *
 * The newest valid NOT-BEFORE line wins (an edit that pushes the check later
 * appends a line). A line whose value does not parse is ignored, so a typo can
 * never hold a card forever; linear-brain.js validates the value it writes.
 */

// Tolerates bold markers and Linear's markdown escaping ("NOT\-BEFORE").
const NOT_BEFORE_RE = /^[ \t>*_]*NOT\\?-BEFORE[*_]*\s*:[*_\s]*([0-9][^\s*_|]*)/gim;
// Date-only, or a date-time with an explicit zone (Z or +hh:mm). A zone-less
// date-time would be read in the machine's local zone, which differs between
// the Mac and CI, so it is refused at filing time.
const ACCEPTED_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;

function parseValue(raw) {
  const v = String(raw || '').trim();
  if (!ACCEPTED_RE.test(v)) return NaN;
  return Date.parse(v);
}

/** The card's hold time in ms (latest valid NOT-BEFORE line), or null when it has none. */
function parseNotBeforeMs(description) {
  let best = null;
  for (const m of String(description || '').matchAll(NOT_BEFORE_RE)) {
    const t = parseValue(m[1]);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/** 'not-before' while the card's NOT-BEFORE time is still ahead, else null. */
function notBeforeHoldReason(issue, nowMs = Date.now()) {
  const t = parseNotBeforeMs(issue && issue.description);
  return t !== null && nowMs < t ? 'not-before' : null;
}

/** Normalize a --not-before argument to an ISO-8601 UTC string; throws on anything ambiguous. */
function normalizeNotBefore(arg) {
  const t = parseValue(arg);
  if (!Number.isFinite(t)) {
    throw new Error(`--not-before needs a date (2026-11-21) or a date-time with a zone (2026-11-21T01:40:00Z or ...-05:00); got "${arg}"`);
  }
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

/** The description line linear-brain.js writes. */
function notBeforeLine(iso) {
  return `NOT-BEFORE: ${iso}`;
}

module.exports = { parseNotBeforeMs, notBeforeHoldReason, normalizeNotBefore, notBeforeLine, NOT_BEFORE_RE };
