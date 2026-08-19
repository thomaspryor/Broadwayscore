/**
 * Shared substring-match predicate for HeaderSearch's exact-match fallback
 * and the search-shows.json generator. Normalizes away punctuation/spacing
 * so title variants (e.g. "Gun & Powder" vs "gun &powder") still match —
 * same normalize-then-compare approach as apostrophe/punct title guards
 * elsewhere in the pipeline.
 */

// Below this, a stripped query/title is too short to be a meaningful signal
// (e.g. a 1-char akaTitle could substring-match nearly anything) — mirrors
// the 2-char floor HeaderSearch's caller already applies to raw queries.
const MIN_MATCH_LENGTH = 2;

function normalizeSearchText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True if `query` matches show.title or any of show.akaTitles. */
function matchesShowSearchQuery(show, query) {
  const q = normalizeSearchText(query);
  if (q.length < MIN_MATCH_LENGTH) return false;
  if (normalizeSearchText(show.title).includes(q)) return true;
  const akaTitles = show.akaTitles;
  if (Array.isArray(akaTitles)) {
    return akaTitles.some(t => normalizeSearchText(t).includes(q));
  }
  return false;
}

module.exports = { matchesShowSearchQuery, normalizeSearchText };
