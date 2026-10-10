/**
 * press-night-trust.js
 *
 * Single rule: "is this show's openingDate press-night-grade — safe to treat
 * as a real press night BEFORE the show is confirmed open?"
 *
 * Used by the opening-night orchestrator selector
 * (.github/workflows/opening-night-orchestrator.yml) to decide whether a
 * pre-open West End show may enter the previews-anticipation polling window.
 * Once a show's status is 'open', discovery runs regardless of source —
 * reviews are real no matter how we learned the date (see the selector).
 *
 * This is a WHITELIST — deliberately the inverse shape of
 * date-source-confidence.js's isUnconfirmedDateSource() blocklist:
 *   - isUnconfirmedDateSource answers "may an enrich script OVERWRITE this
 *     date?" — unlisted sources default to confirmed (don't overwrite).
 *   - isTrustedPressNightSource answers "may we poll for reviews before the
 *     show is open?" — unlisted sources default to UNTRUSTED, so estimated:*,
 *     review-open-signal, todaytix, showscore, and freeform descriptive
 *     strings never trigger pre-open polling on what may be a preview date
 *     rather than a press night (KENREX class).
 * Do NOT replace one predicate with the other — the defaults are opposite
 * on purpose (ship-check blocker, 2026-07-22).
 */

'use strict';

// Exact source strings whose dates are press-night-grade.
const TRUSTED_EXACT = new Set([
  'theatremonkey',            // WE authoritative press-night listing
  'playbill',                 // Playbill London schedule
  'playbill-production-page', // Playbill per-production page
  'playbill-article',         // date parsed from a Playbill review-roundup
                              // article (backfill-dates-from-roundups.js) —
                              // Playbill states the official opening in its
                              // roundup lede; without this the backfilled
                              // field would fill but leave the WE trust gate
                              // closed (QA ship-check finding)
  'ibdb',                     // authoritative for Broadway press nights
  'manual',                   // human-entered
  'inferred-from-reviews',    // derived from actual review publication cluster
  'review-derived-press-night',
  'press-release',            // official production announcement
]);

// Prefixes for dated/annotated variants of trusted sources, e.g.
// 'manual:stuart-king-email-2026-04-27 (...)', 'manual-original-run',
// 'press-night-correction-2026-06-29'.
const TRUSTED_PREFIXES = [
  'manual:',
  'manual-',
  'press-night-correction-',
];

/**
 * Returns true when an openingDateSource string is trustworthy enough to
 * treat the show's openingDate as a real press night before the show is
 * confirmed open.
 *
 * @param {string|null|undefined} source - show.openingDateSource
 * @returns {boolean}
 */
function isTrustedPressNightSource(source) {
  if (typeof source !== 'string' || source === '') return false;
  if (TRUSTED_EXACT.has(source)) return true;
  return TRUSTED_PREFIXES.some((p) => source.startsWith(p));
}

module.exports = {
  isTrustedPressNightSource,
  // Exported for tests / debug only — call sites should use the predicate.
  TRUSTED_EXACT,
  TRUSTED_PREFIXES,
};
