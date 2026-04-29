/**
 * date-source-confidence.js
 *
 * Single rule: "is this show's openingDate from a source we can trust?"
 *
 * Different markets have different authoritative sources:
 *   - Broadway: IBDB is authoritative (preview-vs-opening distinction is correct).
 *   - Off-Broadway: IBDB historically conflates first-preview with opening.
 *     KENREX 2026-04-28 root cause: shows.json had openingDate=2026-04-15 from
 *     IBDB but the real press night was 2026-04-26. Treat IBDB as unconfirmed
 *     for OB.
 *   - West End / Off-West End: Theatremonkey + Playbill London schedule are
 *     authoritative; todaytix/showscore/unknown/null/undefined are unconfirmed.
 *
 * Why this lives in lib/ rather than each enrich script's local scope:
 * the rule has to be the same in every script that decides whether to overwrite
 * a show's openingDate. Per-script copies would drift, and the OB-vs-Broadway
 * IBDB exception is exactly the kind of subtle nuance a reader needs spelled
 * out in one place. (Reviewer feedback: "encoding policy in the wrong place".)
 *
 * Usage:
 *   const { isUnconfirmedDateSource } = require('./lib/date-source-confidence');
 *   if (isUnconfirmedDateSource(show)) { ... }
 */

'use strict';

// Sources that are unconfirmed regardless of market.
const ALWAYS_UNCONFIRMED = new Set([
  'todaytix',
  'showscore',
  'unknown',
  null,
  undefined,
  '',
]);

// Sources that are unconfirmed ONLY for off-Broadway shows.
// IBDB conflates first-preview and opening for OB but is correct for Broadway.
const UNCONFIRMED_FOR_OFF_BROADWAY = new Set([
  'ibdb',
]);

/**
 * Returns true when this show's openingDate came from a source that should be
 * considered unconfirmed for the show's market — i.e., a press-night enrich
 * script may overwrite it from a more authoritative source.
 *
 * @param {object} show - show entry from shows.json. Must have at least
 *   `category` and `openingDateSource` fields.
 * @returns {boolean}
 */
function isUnconfirmedDateSource(show) {
  if (!show) return false;
  const src = show.openingDateSource;

  if (ALWAYS_UNCONFIRMED.has(src)) return true;

  if (show.category === 'off-broadway' && UNCONFIRMED_FOR_OFF_BROADWAY.has(src)) {
    return true;
  }

  return false;
}

module.exports = {
  isUnconfirmedDateSource,
  // Exported for tests / debug only — call sites should use the predicate.
  ALWAYS_UNCONFIRMED,
  UNCONFIRMED_FOR_OFF_BROADWAY,
};
