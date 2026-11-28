'use strict';

/**
 * cast-link-slugs.js — the /cast/<slug> a person's name resolves to on the
 * site, for the newsletter (BRO-5165).
 *
 * src/lib/data-actors.ts numbers colliding names over actorIdentitiesInPageOrder
 * (the second identity whose name slugs the same becomes '<slug>-2'). A bare
 * slugify(name) therefore links the second person to the first person's page.
 * This replays the same assignment so each identity gets its real slug, and
 * leaves out a name that belongs to two identities rather than guess.
 */

const { slugify, assignUniqueSlugs } = require('./url-slug');
const { broadwayShows, actorIdentitiesInPageOrder } = require('./page-name-sources');

/**
 * @param {object[]} castEntries data/cast-manifest.json entries
 * @param {object[]} shows       data/shows.json rows
 * @returns {{ slugFor: (name: string) => string|null }}
 *   slugFor — the page slug, or null when the name is ambiguous (link nothing)
 */
function buildCastLinkResolver(castEntries, shows) {
  const bwayIds = new Set(broadwayShows(shows).map((s) => s.id));
  const identities = actorIdentitiesInPageOrder(castEntries || [], bwayIds);
  const slugs = assignUniqueSlugs(identities.map((a) => a.name));
  const slugById = new Map(identities.map((a, i) => [a.ibdbPersonId, slugs[i]]));
  const byName = new Map(); // name -> Set of page slugs
  const collidingBases = new Set(); // bare slugs more than one identity wants
  const seenBases = new Set();
  identities.forEach((a, i) => {
    if (!byName.has(a.name)) byName.set(a.name, new Set());
    byName.get(a.name).add(slugs[i]);
    const base = slugify(a.name);
    if (seenBases.has(base)) collidingBases.add(base);
    seenBases.add(base);
  });
  // Older spellings of a person (the page shows only the latest "current" one)
  // still point at that person's page, and count toward ambiguity.
  for (const m of castEntries || []) {
    if (!m || !m.ibdbPersonId || !m.name || !bwayIds.has(m.showId)) continue;
    const slug = slugById.get(m.ibdbPersonId);
    if (!slug) continue;
    if (!byName.has(m.name)) byName.set(m.name, new Set());
    byName.get(m.name).add(slug);
  }
  return {
    slugFor(name) {
      const exact = byName.get(name);
      if (exact) return exact.size === 1 ? [...exact][0] : null;
      const base = slugify(name);
      if (!base || collidingBases.has(base)) return null;
      return base;
    },
  };
}

module.exports = { buildCastLinkResolver };
