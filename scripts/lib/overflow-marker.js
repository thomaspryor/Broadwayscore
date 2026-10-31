/**
 * overflow-marker.js — the one definition of "this property value is a
 * TRUNCATED PREVIEW; the real text lives in the page body".
 *
 * notion-brain.js caps a rich_text property at PROP_CHUNK (1800) chars, keeps
 * a preview ending in OVERFLOW_NOTE, and writes the full text to the page
 * body (see buildRichTextWithOverflow / readFieldWithOverflow). Anything that
 * reads a card's notes/outcome WITHOUT stitching the body back is therefore
 * reading a preview — and, crucially, a preview that has silently lost
 * whatever sat past the cut. `## Acceptance criteria` is written LAST on this
 * repo's cards, so it is the first thing to fall off.
 *
 * That is not a hypothetical: `notion-brain.js list --include-notes` hands
 * back the raw property, and the nightly acceptance recheck read exactly that
 * — 14 of 18 RECHECK-AFTER-stamped cards on the live board were truncated,
 * and their acceptance criteria were invisible, so the recheck dropped them
 * with a bare `continue`. A card that promises "check back later that this
 * fix held" could never be checked at all.
 *
 * A zero-dependency leaf on purpose (same shape as park-marker.js and
 * owner-judgment-marker.js): notion-brain.js is a CLI that exits at load
 * without NOTION_API_KEY and exports nothing, so no library can require it to
 * learn the marker. Both sides import THIS instead, which is what makes
 * "producer and detector agree" a structural fact rather than a convention.
 */

'use strict';

const OVERFLOW_NOTE = '\n\n[Full content in page body below ↓]';
// Substring, not the whole note: the trailing arrow is decoration and has
// changed before. Matching on the stable prefix keeps detection working for
// cards written under an older arrow/spacing.
const OVERFLOW_MARKER_SUBSTR = '[Full content in page body below';

/** True when `text` is a truncated preview whose full content is in the page body. */
function hasOverflowMarker(text) {
  return String(text || '').includes(OVERFLOW_MARKER_SUBSTR);
}

/**
 * True when ANY of a card's long-text fields is a truncated preview — i.e.
 * this card must be re-read through notion-brain's `get`/loadCard path before
 * its notes or outcome can be trusted to be complete.
 * @param {{notes?:string,outcome?:string,keyFiles?:string}|null} card
 */
function cardHasOverflow(card) {
  if (!card) return false;
  return hasOverflowMarker(card.notes) || hasOverflowMarker(card.outcome) || hasOverflowMarker(card.keyFiles);
}

module.exports = { OVERFLOW_NOTE, OVERFLOW_MARKER_SUBSTR, hasOverflowMarker, cardHasOverflow };
