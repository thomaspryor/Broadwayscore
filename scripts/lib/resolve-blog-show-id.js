/**
 * Resolve a blog post's frontmatter to a shows.json id.
 * Extracted from generate-blog-reviews-for-scoring.js so tests can require() it (BRO-2410).
 */
const { normalizeTitle } = require('./title-match');
const { venuesMatch } = require('./deduplication');

/**
 * Resolve a post's frontmatter to a shows.json id.
 * Priority: explicit showSlug > title match, disambiguated by venue, then
 * by dateAttended falling inside the run's [openingDate, closingDate].
 * Same-title shows (revivals, transfers) are common enough (Cats, Spelling
 * Bee below) that title alone isn't sufficient.
 */
function resolveShowId(data, file, slugToId, showsByNormTitle) {
  if (data.showSlug) {
    const showId = slugToId.get(data.showSlug);
    if (!showId) {
      console.warn(`[blog-scoring] Skipping ${file}: showSlug "${data.showSlug}" not found in shows.json`);
      return null;
    }
    return showId;
  }

  if (!data.show) {
    console.warn(`[blog-scoring] Skipping ${file}: no showSlug or show field`);
    return null;
  }

  let candidates = showsByNormTitle.get(normalizeTitle(data.show)) || [];
  if (candidates.length === 0) {
    console.warn(`[blog-scoring] Skipping ${file}: show "${data.show}" not found in shows.json`);
    return null;
  }

  if (candidates.length > 1 && data.venue) {
    // venuesMatch(), not a raw canonicalVenue() equality check — the latter
    // falls back to the lowercased first word for any venue outside the
    // curated alias table, so two unrelated theatres sharing a first word
    // (e.g. "The Duke on 42nd Street" / "The Public Theater") would
    // otherwise collapse to the same key for this automated decision.
    const byVenue = candidates.filter(sh => venuesMatch(data.venue, sh.venue));
    if (byVenue.length > 0) candidates = byVenue;
  }

  if (candidates.length > 1) {
    // Coerce to an ISO "YYYY-MM-DD" string: an unquoted YAML date (e.g.
    // 2026-03-21 with no quotes) is parsed by gray-matter/js-yaml into a
    // Date object, which would otherwise compare incorrectly (or throw)
    // against shows.json's ISO date strings below.
    const rawAttended = data.dateAttended || data.publishDate;
    const attended = rawAttended instanceof Date
      ? rawAttended.toISOString().slice(0, 10)
      : String(rawAttended || '');
    if (attended) {
      // Lower bound uses previewsStartDate (not openingDate) so a review
      // written during previews — the norm for this author, see Cats above —
      // isn't wrongly excluded from its own run's window.
      const byDate = candidates.filter(sh => {
        const start = sh.previewsStartDate || sh.openingDate;
        if (!start) return false;
        if (attended < start) return false;
        return !sh.closingDate || attended <= sh.closingDate;
      });
      if (byDate.length > 0) candidates = byDate;
    }
  }

  if (candidates.length !== 1) {
    console.warn(`[blog-scoring] Skipping ${file}: show "${data.show}" is ambiguous (${candidates.length} matches after venue/date disambiguation) — add showSlug to resolve`);
    return null;
  }

  return candidates[0].id;
}

module.exports = { resolveShowId };
