/**
 * recheck-stamp.js — the RECHECK-AFTER stamp parser, shared by the nightly
 * acceptance recheck (autonomous-recheck-core.js) and the daily stuck-work
 * check (stuck-work.js).
 *
 * Deliberately a zero-dependency leaf: stuck-work.js runs inside the daily
 * health digest, and requiring autonomous-recheck-core.js from there would
 * drag in verify-gate.js → autonomous-verify-cmd.js / autonomous-triage-core.js,
 * which reads and JSON-parses a schema file from disk at module load — a
 * load-time failure in that chain would silently degrade the digest's
 * stuck-work section.
 */

'use strict';

// `RECHECK-AFTER: 2026-08-08` — case-insensitive, date-only (parsed as
// midnight UTC, i.e. the START of that day: the recheck becomes due the
// instant that UTC day begins, not at its end — a deferred-effect claim like
// "7-day spend streak" names the day its OWN window already closes on).
const RECHECK_AFTER_RE = /RECHECK-AFTER:\s*(\d{4}-\d{2}-\d{2})/i;

function parseRecheckAfter(text) {
  const m = RECHECK_AFTER_RE.exec(String(text || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Stamp for a whole card, scanning fields in precedence order:
 * notes → outcome → name. Notes wins because it is the author-controlled
 * acceptance-criteria field the recheck reads; Outcome is prepend-ordered at
 * wrap-up so its FIRST match is the newest stamp; the title is a cheap
 * last-resort some cards use. The first match in the highest-precedence field
 * that has one decides — a two-stamp disagreement resolves to notes.
 * @param {{notes?:string,outcome?:string,name?:string}|null} card
 * @returns {number|null} ms since epoch (midnight UTC of the stamped day), or null
 */
function parseRecheckAfterFromCard(card) {
  if (!card) return null;
  for (const field of [card.notes, card.outcome, card.name]) {
    const t = parseRecheckAfter(field);
    if (t != null) return t;
  }
  return null;
}

module.exports = { RECHECK_AFTER_RE, parseRecheckAfter, parseRecheckAfterFromCard };
