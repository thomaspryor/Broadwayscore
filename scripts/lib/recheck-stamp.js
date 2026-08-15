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

// park-marker.js is also a zero-dependency leaf (no requires of its own), so
// this stays cheap to load from the digest's path.
const { PARK_MARKER_RE } = require('./park-marker');

// `RECHECK-AFTER: 2026-08-08` — case-insensitive, date-only (parsed as
// midnight UTC, i.e. the START of that day: the recheck becomes due the
// instant that UTC day begins, not at its end — a deferred-effect claim like
// "7-day spend streak" names the day its OWN window already closes on).
//
// The colon is OPTIONAL (fixed 2026-08-14). Live cards are stamped
// `RECHECK-AFTER 2026-08-24` without one — sessions type the stamp by hand at
// wrap-up — and those failed the match outright, which is the silent-drop
// failure this whole file exists to prevent: a card that plainly carries a
// stamp was treated as carrying none.
//
// Widened DELIBERATELY narrowly, not to "anything near the word". What
// follows the keyword must be a colon and/or blanks and then, immediately, a
// full ISO date: no other token may intervene. That is what keeps prose about
// the mechanism from matching — "RECHECK-AFTER stamps landed 2026-08-24" has
// a word between the keyword and the date and is NOT a stamp, while
// "RECHECK-AFTER 2026-08-24" is. The colon-less branch allows blanks only
// (`[ \t]+`), never `\s`: `\s` crosses newlines, so a card ending in a bare
// "RECHECK-AFTER" heading would swallow an unrelated date from the next line.
// The colon branch keeps the original `\s*` verbatim, so this is a strict
// superset of what matched before — no previously-matching card can stop
// matching.
//
// Writes stay canonical regardless: hoistRecheckAfterStamp (below) re-emits
// every stamp it finds in the canonical `RECHECK-AFTER: <date>` form at the
// head of the text, so a colon-less stamp normalises the next time the card
// is written through notion-brain.
const RECHECK_AFTER_RE = /RECHECK-AFTER(?::\s*|[ \t]+)(\d{4}-\d{2}-\d{2})/i;

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

/**
 * Ensure a RECHECK-AFTER stamp present anywhere in `text` also appears at
 * the very front. notion-brain's Outcome property is truncated to a preview
 * (see notion-brain.js PROP_CHUNK) before it's stored — content past that
 * cut lives only in the page body, which stuck-work.js's classifier never
 * reads. A stamp written mid-paragraph or at the tail of a long wrap-up
 * outcome silently falls past that cut, so the daily digest can never see
 * it even though the card plainly has one (task #802: 5 of 6 stuck P0/P1
 * cards had exactly this bug). Call this on the final text right before
 * building the property value. Duplicating the stamp at the head is
 * harmless — a preview convenience; the original text is preserved after.
 *
 * Never hoists past an existing head `## Parked <date>` marker (park-marker.js):
 * that marker's whole contract is being the literal first bytes of Outcome —
 * classifyStuckCards checks it before ever looking for a stamp, and a stamp
 * pushed in front of it would silently break the Parked exemption (a card
 * parked via tab-close would misclassify as awaiting-recheck or critical
 * instead of parked). A parked card's own Outcome is always short (see
 * formatParkOutcome), so there's no legitimate need to hoist a stamp onto it.
 * @param {string} text
 * @returns {string}
 */
function hoistRecheckAfterStamp(text) {
  const s = String(text || '');
  if (PARK_MARKER_RE.test(s)) return s;
  const m = RECHECK_AFTER_RE.exec(s);
  if (!m) return s;
  // "already at the head" means already at the head IN CANONICAL FORM. A
  // colon-less head stamp (`RECHECK-AFTER 2026-08-24`, which live cards do
  // carry) is parseable but not canonical, so it still gets a canonical copy
  // prepended — that is how the colon-less form self-heals on the next write
  // instead of persisting forever. Idempotent: the next call sees the
  // canonical head and returns unchanged.
  const canonicalHead = `RECHECK-AFTER: ${m[1]}`;
  if (m.index === 0 && s.startsWith(canonicalHead)) return s;
  return `${canonicalHead}\n\n${s}`;
}

module.exports = { RECHECK_AFTER_RE, parseRecheckAfter, parseRecheckAfterFromCard, hoistRecheckAfterStamp };
