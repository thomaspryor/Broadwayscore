'use strict';

/**
 * name-slug-redirects.js — 301s for the person/place URLs the S7-T3
 * diacritic fold moved (2026 data audit, S7-T3 follow-up).
 *
 * Before S7-T3, src/lib/data-core.ts slugify() had no fold, so an accented
 * name's URL had a hyphen where the accent was: /creative/jos-quintero,
 * /creative/no-l-coward, /west-end/theater/no-l-coward-theatre,
 * /off-broadway/theater/repertorio-espa-ol-spanish-theatre-repertory,
 * /cast/ren-ceballos. The fold moved every one of them (jose-quintero,
 * noel-coward-2, noel-coward-theatre, …) with no redirect. Critics got
 * theirs from a hand-kept registry (scripts/lib/critic-slug-aliases.js,
 * S5-T9); these families are derived from the live data instead, at
 * prebuild, so they can never go stale:
 *
 *   for each page family, replay the names the page builder sees, in page
 *   order (scripts/lib/page-name-sources.js), through BOTH slug rules —
 *   legacySlugify (pre-fold) and slugify, with the family's collision
 *   numbering (scripts/lib/url-slug.js assignUniqueSlugs) where the page
 *   builder has one — and emit {old → new} wherever they differ and the
 *   old slug is not itself a live page (a live page always wins; a redirect
 *   there would shadow it).
 *
 * The Noël/Noel Coward case falls out of that replay rather than a table:
 * "Noel Coward" takes `noel-coward`, "Noël Coward" gets `noel-coward-2`
 * from the same assignUniqueSlugs call data-creative.ts uses, and its
 * pre-fold `no-l-coward` (unique under the old rule) maps to `noel-coward-2`.
 *
 * Output lands in data/slug-redirects-compact.json under one key prefix per
 * family (NAME_REDIRECT_PREFIXES — mirrored verbatim in
 * src/lib/slug-redirects.ts for the edge middleware, which cannot require()
 * this module; tests/unit/slug-redirects.test.ts asserts parity), beside the
 * show entries and the "critic:" entries. Always permanent (301): an old slug
 * has exactly one successor. src/middleware.ts redirects, and the
 * corresponding lookups (getUnifiedCreativeProfile, getTheaterBySlug,
 * getLondonTheaterBySlug, getOffBroadwayTheaterBySlug, getActorBySlug) fall
 * back through the same map, exactly like getCriticBySlug.
 */

const { slugify, legacySlugify, assignUniqueSlugs } = require('./url-slug');
const {
  broadwayShows,
  londonShows,
  offBroadwayShows,
  creativeNamesInPageOrder,
  broadwayTheaterNames,
  stubTheaterNames,
  actorIdentitiesInPageOrder,
} = require('./page-name-sources');

// Key prefixes inside data/slug-redirects-compact.json, one per route family.
// slugify() never emits ":", so none can collide with a bare show slug, and
// the family name in the key is what keeps /theater/x and /west-end/theater/x
// apart. Mirrored verbatim in src/lib/slug-redirects.ts NAME_REDIRECT_PREFIXES.
const NAME_REDIRECT_PREFIXES = Object.freeze({
  creative: 'creative:',
  theater: 'theater:',
  westEndTheater: 'west-end-theater:',
  offBroadwayTheater: 'off-broadway-theater:',
  cast: 'cast:',
});

/** @typedef {keyof typeof NAME_REDIRECT_PREFIXES} NameRedirectFamily */

/**
 * Pure: one family's {old → new} map.
 * @param {string[]} names page names in page order
 * @param {{ numbered: boolean, extraLive?: string[] }} opts
 *   numbered — the page builder numbers collisions (assignUniqueSlugs: creative,
 *   cast); otherwise slugs are plain slugify(name) and the page builder
 *   de-dupes by slug (theatres: the first name to reach a slug owns the page).
 *   extraLive — live slugs from outside the name list (curated venue-complex
 *   slugs) that an old slug must never shadow either.
 * @returns {Record<string,string>}
 */
function familyRedirects(names, { numbered, extraLive = [] }) {
  const live = numbered ? assignUniqueSlugs(names, slugify) : names.map((n) => slugify(n));
  const retired = numbered ? assignUniqueSlugs(names, legacySlugify) : names.map((n) => legacySlugify(n));
  const liveSet = new Set([...live, ...extraLive]);
  const out = {};
  for (let i = 0; i < names.length; i++) {
    const oldSlug = retired[i];
    const newSlug = live[i];
    if (!oldSlug || !newSlug || oldSlug === newSlug) continue;
    if (liveSet.has(oldSlug)) continue; // the old URL is somebody's live page now
    if (out[oldSlug] === undefined) out[oldSlug] = newSlug; // first name wins, like find()
  }
  return out;
}

/**
 * Pure: every family's redirects from the raw data the pages are built from.
 * @param {{ shows: object[], castEntries?: object[],
 *   complexSlugs?: { westEnd?: string[], offBroadway?: string[] } }} input
 *   shows        — data/shows.json rows (all markets; filtered per family here)
 *   castEntries  — data/cast-manifest.json entries ([] when the manifest is absent)
 *   complexSlugs — curated venue-complex slugs (data/venue-complexes*.json keys),
 *                  live pages on the two stub-venue routes
 * @returns {{ families: Record<NameRedirectFamily, Record<string,string>>, entries: Record<string,string> }}
 *   families — per family {old → new}, for the full (inspection) output
 *   entries  — the prefixed compact-map entries { "<prefix><old>": "<new>" }
 */
function buildNameSlugRedirects({ shows, castEntries = [], complexSlugs = {} }) {
  const bway = broadwayShows(shows);
  const bwayIds = new Set(bway.map((s) => s.id));
  const families = {
    creative: familyRedirects(creativeNamesInPageOrder(bway), { numbered: true }),
    theater: familyRedirects(broadwayTheaterNames(bway), { numbered: false }),
    westEndTheater: familyRedirects(stubTheaterNames(londonShows(shows)), {
      numbered: false,
      extraLive: complexSlugs.westEnd || [],
    }),
    offBroadwayTheater: familyRedirects(stubTheaterNames(offBroadwayShows(shows)), {
      numbered: false,
      extraLive: complexSlugs.offBroadway || [],
    }),
    cast: familyRedirects(
      actorIdentitiesInPageOrder(castEntries, bwayIds).map((a) => a.name),
      { numbered: true }
    ),
  };
  const entries = {};
  for (const [family, map] of Object.entries(families)) {
    for (const [oldSlug, newSlug] of Object.entries(map)) {
      entries[NAME_REDIRECT_PREFIXES[family] + oldSlug] = newSlug;
    }
  }
  return { families, entries };
}

module.exports = { NAME_REDIRECT_PREFIXES, familyRedirects, buildNameSlugRedirects };
