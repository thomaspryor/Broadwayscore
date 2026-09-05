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
  // BRO-155: "Loft Story" (an unrelated Brooklyn venue) false-positived
  // against "The Players Theatre Loft" sub-venue on this token alone.
  'loft',
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
    // Same Array.isArray guard as findOrphanSubVenueSlugs. A spread of a
    // missing/non-iterable subVenueSlugs throws "is not iterable" here on
    // exactly the malformed def findMalformedComplexDefs exists to REPORT.
    // Today this is only reached from the .mjs audit test, where a throw is
    // contained, but the moment a caller in validate-data.js reaches it the
    // uncaughtException handler turns it back into a push-refusal sentinel —
    // the failure the hardening was supposed to remove. Harden both, not one.
    const covered = new Set([complexSlug, ...(Array.isArray(def && def.subVenueSlugs) ? def.subVenueSlugs : [])]);
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
    // Tolerate a malformed def here rather than throwing. A bare
    // `def.subVenueSlugs.filter(...)` on a def missing the key threw a
    // TypeError, and scripts/validate-data.js's uncaughtException handler
    // (validate-data.js:85-91) turns any throw into a push-refusal sentinel —
    // so one missing JSON key would have hard-blocked every automated
    // core-data push with a stack trace instead of a diagnosis.
    // findMalformedComplexDefs() below is what reports the malformed shape.
    const slugs = Array.isArray(def && def.subVenueSlugs) ? def.subVenueSlugs : [];
    const missing = slugs.filter(slug => !slugToRaw.has(slug));
    if (missing.length) orphans[complexSlug] = missing;
  }
  return orphans;
}

/**
 * Complex defs whose subVenueSlugs is missing or not an array.
 *
 * This shape is genuinely blocking, unlike an orphaned slug: src/lib/data-core.ts
 * buildComplexIndex does `def.subVenueSlugs.map(...)` with no guard, so a def
 * without the key throws during the Next build, not just in an audit.
 *
 * Returns { [complexSlug]: <typeof description of what was found> }.
 */
function findMalformedComplexDefs(complexDefs) {
  const bad = {};
  for (const [complexSlug, def] of Object.entries(complexDefs)) {
    if (!def || typeof def !== 'object') {
      bad[complexSlug] = def === null ? 'null' : typeof def;
      continue;
    }
    if (!Array.isArray(def.subVenueSlugs)) {
      bad[complexSlug] = def.subVenueSlugs === undefined ? 'missing' : typeof def.subVenueSlugs;
    }
  }
  return bad;
}

// A "dead complex" check (zero resolvable sub-venues AND an unresolvable own
// slug) was written here and then removed before merge, deliberately. The first
// reviewer wanted it because emptying subVenueSlugs is the cheapest way to
// silence an orphan finding. The adversarial reviewer showed the premise was
// wrong: src/lib/data-core.ts:885 maps EVERY def unconditionally and returns it
// with showCount 0, so a complex that groups nothing is a shape the site emits
// by design, not a broken one. "Delete the entry" would have been editorial
// policy invented by an audit, and it would have fired a permanent advisory at
// any legitimately pre-declared or seasonally dormant complex. It also had zero
// findings against the live corpus, so it carried no evidence of value either.
// If an empty complex page ever turns out to matter, add it back with that page
// as the evidence.

/**
 * The audit's own market/defs-file pairing, in one place.
 *
 * Scope, stated precisely: this removes ONE of three copies — the one
 * scripts/validate-data.js used to inline — so this file and
 * scripts/audit-venue-complex-slugs.test.mjs now share it. It is NOT the single
 * source of market knowledge for the whole codebase: src/lib/data-core.ts still
 * defines its own London membership plus hidden-show exclusion (data-core.ts:316)
 * and off-Broadway membership (data-core.ts:845), and a third market would still
 * need its JSON import and public accessors there. Adding a market is one edit
 * for the AUDIT, not one edit for the site.
 *
 * `defsFile` is a repo-relative path, not a require() — this module stays pure
 * (no fs, no require of data) so both consumers keep controlling their own
 * loading. `matches` is the category predicate for that market's shows.
 */
const VENUE_COMPLEX_MARKETS = [
  {
    key: 'off-broadway',
    label: 'off-Broadway',
    defsFile: 'data/venue-complexes.json',
    matches: (show) => show.category === 'off-broadway',
  },
  {
    key: 'london',
    label: 'West End',
    defsFile: 'data/venue-complexes-west-end.json',
    matches: (show) => show.category === 'west-end' || show.category === 'off-west-end',
  },
];

module.exports = {
  slugify,
  normalizeVenueName,
  buildSlugIndex,
  findCandidateGaps,
  findOrphanSubVenueSlugs,
  findMalformedComplexDefs,
  VENUE_COMPLEX_MARKETS,
};
