'use strict';

/**
 * page-name-sources.js — which names make a person/place page, in page order.
 *
 * The site derives its /creative/<slug>, /theater/<slug>,
 * /west-end/theater/<slug>, /off-broadway/theater/<slug> and /cast/<slug>
 * URLs from names in shows.json (creative teams, venues) and the cast
 * manifest, through slugify() and — for people — the slug-collision rule in
 * scripts/lib/url-slug.js assignUniqueSlugs(). Both halves of that are
 * order-sensitive: "Noël Coward" is `noel-coward-2` only because "Noel
 * Coward" reached `noel-coward` first (src/lib/data-creative.ts).
 *
 * These helpers are the ONE statement of "which names, in which order" for
 * each family. src/lib/data-creative.ts, src/lib/data-actors.ts and
 * src/lib/data-core.ts (the page builders) import them, and so does
 * scripts/build-slug-redirects.js, which replays each family with the
 * pre-S7-T3 rule (legacySlugify) to find the URLs the diacritic fold moved
 * and 301 them (S7-T3 follow-up). Shared, not copied, so the redirect
 * emitter can never number a collision differently from the page.
 *
 * Inputs are RAW shows.json rows / cast-manifest entries (the emitter runs
 * at prebuild, before any TS module exists); the page builders pass their
 * ComputedShow lists, which carry the same id/category/venue/creativeTeam
 * fields unchanged (src/lib/engine.ts computeShowData).
 */

const { getCategoriesForRole } = require('./creative-roles');

/**
 * @typedef {{ id?: string, category?: string, venue?: string, _devOnly?: boolean,
 *   creativeTeam?: Array<{ name: string, role: string }> }} ShowLike
 */

/** getAllShows() drops `_devOnly` rows; getBroadwayShows() keeps only the strict Broadway category. */
function broadwayShows(shows) {
  // Intentionally NOT isBroadwayCategory(): this walk must produce exactly the
  // rows src/lib/data-core.ts getBroadwayShows() → isBroadwayShow() produces
  // (strict category === 'broadway', task #1428), or the redirect emitter and
  // the /theater pages would disagree on which venues exist. A row with no
  // category is not a Broadway page there, so it is not one here either.
  return shows.filter((s) => s && !s._devOnly && s.category === 'broadway');
}

/**
 * IDs excluded from London listings — non-theatre experiences that crept into
 * the data set (e.g. ABBA Voyage is a hologram concert at a purpose-built
 * arena, not theatre). These shows still exist as detail pages but are
 * filtered out of the West End / Off-West End hubs, OG data and the venue
 * index (src/lib/data-core.ts imports this set for getWestEndShows /
 * getAllLondonShows), so "ABBA Arena" never becomes a venue page — nor a
 * venue redirect.
 */
const HIDDEN_LONDON_IDS = new Set([
  'abba-voyage-off-west-end-2026',
]);

/** getAllLondonShows(): West End + Off-West End minus HIDDEN_LONDON_IDS (the /west-end/theater venue index source). */
function londonShows(shows) {
  return shows.filter(
    (s) => s && !s._devOnly && (s.category === 'west-end' || s.category === 'off-west-end') && !HIDDEN_LONDON_IDS.has(s.id)
  );
}

/** getOffBroadwayShows(). */
function offBroadwayShows(shows) {
  return shows.filter((s) => s && !s._devOnly && s.category === 'off-broadway');
}

/**
 * Unified creative pages (src/lib/data-creative.ts buildUnifiedProfiles):
 * every creative-team member whose role maps to a category, first-encounter
 * order across the shows as given. Names are exact strings — "Noel Coward"
 * and "Noël Coward" are two people here, exactly as on the site.
 * @param {ShowLike[]} shows already filtered (broadwayShows)
 * @returns {string[]}
 */
function creativeNamesInPageOrder(shows) {
  const seen = new Set();
  const names = [];
  for (const show of shows) {
    if (!show.creativeTeam) continue;
    for (const member of show.creativeTeam) {
      if (!member || getCategoriesForRole(String(member.role ?? '')).length === 0) continue;
      if (seen.has(member.name)) continue;
      seen.add(member.name);
      names.push(member.name);
    }
  }
  return names;
}

/**
 * Broadway theater pages (src/lib/data-core.ts getAllTheaters): one page per
 * RAW venue string, in first-encounter order, minus "_"-prefixed internals.
 * No collision numbering — two raw strings with one slug share the first's page.
 * @param {ShowLike[]} shows already filtered (broadwayShows)
 * @returns {string[]}
 */
function broadwayTheaterNames(shows) {
  const seen = new Set();
  const names = [];
  for (const show of shows) {
    const venue = show.venue;
    if (!venue || seen.has(venue)) continue;
    seen.add(venue);
    if (venue.startsWith('_')) continue;
    names.push(venue);
  }
  return names;
}

// Placeholder venue strings that never get their own venue page (announced
// shows sometimes list "TBA" as the venue).
const STUB_THEATER_PLACEHOLDER_VENUES = new Set(['TBA', 'TBD', 'tba', 'tbd', 'Unknown', 'unknown']);

/**
 * The page name for a West End / Off-Broadway venue string, or null when it
 * gets no page (src/lib/data-core.ts buildStubTheaterIndex): trimmed,
 * whitespace collapsed; "_"-prefixed internals and placeholders excluded.
 * @param {unknown} venue
 * @returns {string|null}
 */
function stubTheaterName(venue) {
  if (typeof venue !== 'string' || !venue) return null;
  const name = venue.trim().replace(/\s+/g, ' ');
  if (!name || name.startsWith('_') || STUB_THEATER_PLACEHOLDER_VENUES.has(name)) return null;
  return name;
}

/**
 * Every distinct page name a stub venue index sees, in first-encounter
 * order. The index itself groups by slug (first name wins the page); the
 * redirect emitter needs every name, because each spelling had its own
 * pre-fold URL.
 * @param {ShowLike[]} shows already filtered (londonShows / offBroadwayShows)
 * @returns {string[]}
 */
function stubTheaterNames(shows) {
  const seen = new Set();
  const names = [];
  for (const show of shows) {
    const name = stubTheaterName(show.venue);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * @typedef {{ showId: string, castType: 'obc'|'replacement'|'current', name: string,
 *   ibdbPersonId?: string }} CastManifestEntry
 */

/**
 * Actor pages (src/lib/data-actors.ts buildAllProfiles): one page per IBDB
 * person id, first-encounter order over the cast manifest; orphans (no id)
 * and entries for shows outside the Broadway set are skipped; the page name
 * is the first spelling seen, overridden by the most recent `current` cast
 * spelling.
 * @param {CastManifestEntry[]} entries data/cast-manifest.json entries
 * @param {Set<string>} showIds ids of broadwayShows()
 * @returns {Array<{ ibdbPersonId: string, name: string }>}
 */
function actorIdentitiesInPageOrder(entries, showIds) {
  const byId = new Map();
  for (const member of entries) {
    if (!member || !member.ibdbPersonId) continue;
    if (!showIds.has(member.showId)) continue;
    let actor = byId.get(member.ibdbPersonId);
    if (!actor) {
      actor = { ibdbPersonId: member.ibdbPersonId, name: member.name };
      byId.set(member.ibdbPersonId, actor);
    }
    if (member.castType === 'current') actor.name = member.name;
  }
  return Array.from(byId.values());
}

module.exports = {
  HIDDEN_LONDON_IDS,
  STUB_THEATER_PLACEHOLDER_VENUES,
  broadwayShows,
  londonShows,
  offBroadwayShows,
  creativeNamesInPageOrder,
  broadwayTheaterNames,
  stubTheaterName,
  stubTheaterNames,
  actorIdentitiesInPageOrder,
};
