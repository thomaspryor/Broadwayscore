'use strict';

/**
 * Pure predicates for the opening-night metadata completeness gate (card #189).
 * Catches empty cast / placeholder synopsis / stale "upcoming" tag on shows
 * that are open or about to open — the class of bug that shipped The Whoopi
 * Monologues live with cast:[] and a templated synopsis.
 */

// Phrases the LLM synopsis generator tends to fall back on when it lacks
// specific plot detail. Anchored loosely enough to catch minor rewording but
// specific enough to avoid matching real synopses (e.g. "brings back memories").
const PLACEHOLDER_SYNOPSIS_PATTERNS = [
  /special theatrical experience/i,
  /brings back characters/i,
];

const MIN_SYNOPSIS_LENGTH = 120;

const STALE_UPCOMING_STATUSES = new Set(['open']);

/**
 * @param {Object} show
 * @returns {boolean} true if cast is missing or empty
 */
function hasEmptyCast(show) {
  if (!show || !Array.isArray(show.cast)) return true;
  return show.cast.length === 0;
}

/**
 * @param {string|null|undefined} synopsis
 * @returns {boolean} true if synopsis looks empty, templated, or too thin to be useful
 */
function isPlaceholderSynopsis(synopsis) {
  const text = (synopsis || '').trim();
  if (!text) return true;
  if (PLACEHOLDER_SYNOPSIS_PATTERNS.some(re => re.test(text))) return true;
  return text.length < MIN_SYNOPSIS_LENGTH;
}

/**
 * @param {Object} show
 * @returns {boolean} true if the show is live (status=open) but still tagged 'upcoming'
 */
function hasStaleUpcomingTag(show) {
  if (!show || !Array.isArray(show.tags)) return false;
  return STALE_UPCOMING_STATUSES.has(show.status) && show.tags.includes('upcoming');
}

/**
 * Count standalone occurrences of "revival" across a set of texts (e.g. review
 * fullText bodies). Used as a secondary signal alongside isRevivalByCanonicalTitle
 * for shows where a canonical-title match isn't available (retitled revivals).
 * @param {Array<string>} texts
 * @returns {number}
 */
function countRevivalMentions(texts) {
  const re = /\brevival\b/gi;
  let count = 0;
  for (const t of texts || []) {
    if (!t) continue;
    const matches = t.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

module.exports = {
  PLACEHOLDER_SYNOPSIS_PATTERNS,
  MIN_SYNOPSIS_LENGTH,
  hasEmptyCast,
  isPlaceholderSynopsis,
  hasStaleUpcomingTag,
  countRevivalMentions,
};
