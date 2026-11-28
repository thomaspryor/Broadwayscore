/**
 * The one way to turn a pending-queue key / entry into a commercial.json key.
 *
 * commercial.json is keyed by show SLUG (cloud-memory/feedback_commercial_
 * slug_keys.md). Pending-review entries are keyed by whatever their writer
 * had (batch research uses the show ID, the Friday scraper the slug) and
 * carry an `entry.slug` that every apply path trusted:
 *     const commercialKey = entry.slug || (resolvedShow && resolvedShow.slug) || showId;
 * But deep-research-commercial.js copied its target straight into
 * entry.slug, and its targets come from commercial-research-queue.json,
 * which sweep-pending-commercial.js re-fills with pending KEYS (show IDs).
 * So entries like the-outsiders-2024 / hadestown-2019 / the-lost-boys-2026
 * carried slug = the show ID, and the reconciler (commercial-weekly run
 * 37151980535) and the RSS-poll apply step (the-balusters-2026 on
 * 2026-09-26, school-girls-...-2026 on 2026-09-28) wrote ID-keyed duplicates
 * next to the real slug entries. The dedupe step then refused them and the
 * whole weekly publish was blocked.
 *
 * Resolution never trusts a string just because of the field it came from:
 *   1. any candidate (entry.slug first, then the key) that IS a show slug
 *   2. else any candidate that is a show ID -> that show's slug
 *   3. else unresolved: the first candidate, flagged so callers can warn
 * Slug-first matters: mamma-mia-2001 is a real slug (a distinct production
 * from mamma-mia) and must never be "resolved" anywhere else.
 */

/**
 * @param {object[]|{shows: object[]}} showsOrData - shows.json data or its shows array
 * @returns {{bySlug: Map<string, object>, byId: Map<string, object>}}
 */
function buildShowKeyIndex(showsOrData) {
  const shows = Array.isArray(showsOrData) ? showsOrData : ((showsOrData && showsOrData.shows) || []);
  const bySlug = new Map();
  const byId = new Map();
  for (const s of shows) {
    if (!s || typeof s !== 'object') continue;
    if (s.slug) bySlug.set(s.slug, s);
    if (s.id) byId.set(s.id, s);
  }
  return { bySlug, byId };
}

/**
 * @param {string} key - pending-queue key (or any id-or-slug string)
 * @param {object} [entry] - pending entry; its `slug` field is a candidate, not an answer
 * @param {{bySlug: Map, byId: Map}} index - from buildShowKeyIndex
 * @returns {{slug: string, show: object|null, resolved: boolean}}
 */
function resolveCommercialSlug(key, entry, index) {
  const candidates = [entry && typeof entry.slug === 'string' ? entry.slug : null, key]
    .filter((c) => typeof c === 'string' && c.length > 0);
  const bySlug = (index && index.bySlug) || new Map();
  const byId = (index && index.byId) || new Map();
  for (const c of candidates) {
    if (bySlug.has(c)) return { slug: c, show: bySlug.get(c), resolved: true };
  }
  for (const c of candidates) {
    const show = byId.get(c);
    if (show && show.slug) return { slug: show.slug, show, resolved: true };
  }
  return { slug: candidates[0] || key, show: null, resolved: false };
}

/**
 * Re-key commercial.json records whose key is a show ID (not any show's
 * slug) onto that show's slug, when the slug key is free. A record whose slug
 * sibling already exists is left alone and returned in `conflicts` for
 * dedupe-commercial-id-keys.js to merge or refuse. Mutates `commercialShows`.
 *
 * @returns {{rekeyed: Array<{from: string, to: string}>, conflicts: Array<{idKey: string, slugKey: string}>}}
 */
function canonicalizeCommercialKeys(commercialShows, index) {
  const rekeyed = [];
  const conflicts = [];
  if (!commercialShows || !index) return { rekeyed, conflicts };
  for (const key of Object.keys(commercialShows)) {
    if (index.bySlug.has(key)) continue;
    const show = index.byId.get(key);
    if (!show || !show.slug || show.slug === key) continue;
    if (Object.prototype.hasOwnProperty.call(commercialShows, show.slug)) {
      conflicts.push({ idKey: key, slugKey: show.slug });
      continue;
    }
    commercialShows[show.slug] = commercialShows[key];
    delete commercialShows[key];
    rekeyed.push({ from: key, to: show.slug });
  }
  return { rekeyed, conflicts };
}

module.exports = { buildShowKeyIndex, resolveCommercialSlug, canonicalizeCommercialKeys };
