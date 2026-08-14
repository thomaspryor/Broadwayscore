/**
 * Shared logic for auditing data/venue-complexes*.json against real
 * shows.json venue strings. Mirrors the site's own slug pipeline exactly —
 * src/lib/data-core.ts:593 (slugify) and :758 (normalizeVenueName), copied
 * here since scripts/ can't import the TS module directly. Any drift between
 * these and data-core.ts would make this audit check the wrong thing.
 */

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalizeVenueName(venue) {
  return venue.trim().replace(/\s+/g, ' ');
}

// Building-word suffixes and city-name tokens common enough across unrelated
// NYC venues that raw word overlap on them alone is noise, not signal.
const GENERIC_TOKENS = new Set([
  'theater', 'theatre', 'theatres', 'stages', 'stage', 'company', 'center',
  'centre', 'at', 'the', 'for', 'of', 'and', 'a', 'new', 'york', 'city',
  'hall', 'house', 'space', 'club', 'studio', 'room',
]);

function coreTokens(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // Drop generic building words, bare numbers ("5", "42"), and single
    // characters (stray initials/possessive "s" left behind when apostrophes
    // become spaces, e.g. "Joe's" -> "joe s") — none are a same-venue signal
    // on their own, and are common enough across unrelated NYC venues to be
    // pure noise in the overlap check below.
    .filter(w => w && w.length > 1 && !GENERIC_TOKENS.has(w) && !/^\d+$/.test(w));
}

/**
 * Build slug -> Set(raw venue strings) for every show matching `categoryFilter`.
 */
function buildSlugIndex(shows, categoryFilter) {
  const slugToRaw = new Map();
  for (const show of shows) {
    if (!categoryFilter(show)) continue;
    if (!show.venue) continue;
    const name = normalizeVenueName(show.venue);
    if (!name) continue;
    const slug = slugify(name);
    if (!slug) continue;
    if (!slugToRaw.has(slug)) slugToRaw.set(slug, new Set());
    slugToRaw.get(slug).add(name);
  }
  return slugToRaw;
}

/**
 * For each complex, find real venue slugs NOT in subVenueSlugs (or the
 * complex's own slug) that share a distinguishing token with the complex
 * name or an already-covered raw venue string — i.e. same-class candidates
 * as the West End National Theatre bug (a bare-form variant of a venue
 * already partially linked). This is a heuristic: it catches the
 * shares-a-token case but cannot discover a sub-venue whose name shares
 * zero words with anything already on file (e.g. Claire Tow Theater under
 * Lincoln Center Theater) — those require editorial knowledge, not string
 * matching.
 *
 * Returns { [complexSlug]: [{ slug, rawStrings, showCount }] }
 */
function findCandidateGaps(shows, complexDefs, categoryFilter) {
  const slugToRaw = buildSlugIndex(shows, categoryFilter);
  const result = {};

  for (const [complexSlug, def] of Object.entries(complexDefs)) {
    const covered = new Set([complexSlug, ...def.subVenueSlugs]);
    const coreTokenSets = [];
    const addTokens = (str) => {
      const tokens = coreTokens(str);
      if (tokens.length) coreTokenSets.push(new Set(tokens));
    };
    addTokens(def.name);
    for (const slug of covered) {
      for (const raw of (slugToRaw.get(slug) || [])) addTokens(raw);
    }

    const candidates = [];
    for (const [slug, rawSet] of slugToRaw) {
      if (covered.has(slug)) continue;
      const slugWords = new Set(slug.split('-'));
      let bestOverlap = 0;
      for (const tokenSet of coreTokenSets) {
        let overlap = 0;
        for (const w of tokenSet) if (slugWords.has(w)) overlap++;
        bestOverlap = Math.max(bestOverlap, overlap);
      }
      if (bestOverlap >= 1) {
        candidates.push({
          slug,
          rawStrings: [...rawSet],
          showCount: shows.filter(
            s => categoryFilter(s) && s.venue && slugify(normalizeVenueName(s.venue)) === slug
          ).length,
        });
      }
    }
    if (candidates.length) result[complexSlug] = candidates;
  }

  return result;
}

/**
 * Every subVenueSlugs entry (and complexSlug itself, when used as an
 * "own theater" lookup) should resolve to at least one real venue string in
 * shows.json, OR be a synthetic complex with no own raw venue (e.g. Lincoln
 * Center Theater — see data-core.ts buildComplexIndex comment). This only
 * flags orphaned subVenueSlugs entries, which are always a real bug (a typo
 * or a venue string that no longer appears in the corpus).
 */
function findOrphanSubVenueSlugs(shows, complexDefs, categoryFilter) {
  const slugToRaw = buildSlugIndex(shows, categoryFilter);
  const orphans = {};
  for (const [complexSlug, def] of Object.entries(complexDefs)) {
    const missing = def.subVenueSlugs.filter(slug => !slugToRaw.has(slug));
    if (missing.length) orphans[complexSlug] = missing;
  }
  return orphans;
}

module.exports = {
  slugify,
  normalizeVenueName,
  buildSlugIndex,
  findCandidateGaps,
  findOrphanSubVenueSlugs,
};
