/**
 * Shared "is this candidate already in shows.json" pool for the historical
 * promotion scripts (promote-ob-historical.js, promote-historical-we.js).
 *
 * Extracted (BRO-243, 2026-08-14) from two near-identical copies of this
 * logic that both used to build a canonicalVenue-keyed Set/Map — the lossy
 * first-word fallback (title-match.js's canonicalVenue()) collapsed
 * unrelated venues sharing a leading word and silently skipped genuinely
 * new candidates as false "duplicate title+venue" (verified live against
 * real shows.json: Prince Edward Theatre / Prince of Wales Theatre).
 *
 * Deliberately uses title-match.js's normalizeTitle(), NOT deduplication.js's
 * own (much more aggressive, subtitle/genre-suffix-stripping) normalizeTitle
 * of the same name — both promote scripts already used the title-match.js
 * version before this extraction, and swapping to the other one would be an
 * unrelated title-matching behavior change bundled into a venue-only fix.
 */

const { normalizeTitle } = require('./title-match');
const { venuesMatch, isSubtitleVariantOf } = require('./deduplication');

const DAY_MS = 86400000;

// venue-write-guard-ok: in-memory dedup pool read from shows.json; nothing here writes a venue.

/**
 * @param {Array<object>} shows shows.json entries
 * @returns {Array<{title: string, venue: string, startDate: string|null, id?: string}>}
 */
function buildVenueTitlePool(shows) {
  return (Array.isArray(shows) ? shows : [])
    .filter(s => s && s.title && s.venue)
    .map(s => ({ title: s.title, venue: s.venue, startDate: s.openingDate || s.previewsStartDate || null, id: s.id }));
}

/**
 * Optional date-awareness (BRO-4851): with `withinYears`, a same title+venue
 * row only counts as a duplicate when both start dates are known and within
 * that many years — a revival at the same venue a decade later is a
 * different production. An unknown date on either side still counts as a
 * duplicate (fail safe: never mint a second row for what may be the same
 * production). Without `withinYears` the match is date-blind, as before.
 * `venueEquals` overrides venuesMatch for callers with known naming variants.
 */
function datesAllowDuplicate(poolEntry, opts) {
  if (opts.withinYears == null) return true;
  const a = Date.parse(poolEntry.startDate || '');
  const b = Date.parse(opts.startDate || '');
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return Math.abs(a - b) <= opts.withinYears * 365.25 * DAY_MS;
}

/**
 * Exact normalized-title + same-venue match, or null.
 * @param {Array<{title: string, venue: string, startDate?: string|null}>} pool
 * @param {string} candidateTitle
 * @param {string} venue
 * @param {{withinYears?: number, startDate?: string|null, venueEquals?: (a: string, b: string) => boolean}} [opts]
 */
function findExactDuplicate(pool, candidateTitle, venue, opts = {}) {
  const norm = normalizeTitle(candidateTitle);
  const sameVenue = opts.venueEquals || venuesMatch;
  return pool.find(s => normalizeTitle(s.title) === norm && sameVenue(s.venue, venue) && datesAllowDuplicate(s, opts)) || null;
}

/**
 * Same-venue title that's a subtitle-stripped variant of the candidate, or
 * null.
 * @param {Array<{title: string, venue: string, startDate?: string|null}>} pool
 * @param {string} candidateTitle
 * @param {string} venue
 * @param {{withinYears?: number, startDate?: string|null, venueEquals?: (a: string, b: string) => boolean}} [opts]
 */
function findSubtitleDuplicateTitle(pool, candidateTitle, venue, opts = {}) {
  const sameVenue = opts.venueEquals || venuesMatch;
  for (const s of pool) {
    if (sameVenue(s.venue, venue) && isSubtitleVariantOf(candidateTitle, s.title) && datesAllowDuplicate(s, opts)) return s.title;
  }
  return null;
}

module.exports = { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle };
