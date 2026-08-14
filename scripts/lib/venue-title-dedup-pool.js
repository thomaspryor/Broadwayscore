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

/**
 * @param {Array<object>} shows shows.json entries
 * @returns {Array<{title: string, venue: string}>}
 */
function buildVenueTitlePool(shows) {
  return (Array.isArray(shows) ? shows : [])
    .filter(s => s && s.title && s.venue)
    .map(s => ({ title: s.title, venue: s.venue }));
}

/**
 * Exact normalized-title + same-venue match, or null.
 * @param {Array<{title: string, venue: string}>} pool
 * @param {string} candidateTitle
 * @param {string} venue
 */
function findExactDuplicate(pool, candidateTitle, venue) {
  const norm = normalizeTitle(candidateTitle);
  return pool.find(s => normalizeTitle(s.title) === norm && venuesMatch(s.venue, venue)) || null;
}

/**
 * Same-venue title that's a subtitle-stripped variant of the candidate, or
 * null.
 * @param {Array<{title: string, venue: string}>} pool
 * @param {string} candidateTitle
 * @param {string} venue
 */
function findSubtitleDuplicateTitle(pool, candidateTitle, venue) {
  for (const s of pool) {
    if (venuesMatch(s.venue, venue) && isSubtitleVariantOf(candidateTitle, s.title)) return s.title;
  }
  return null;
}

module.exports = { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle };
