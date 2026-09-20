/**
 * westendtheatre.com URL discovery for audit-we-closing-dates.js.
 *
 * WestEndTheatre.com (WET) has no central show index — booking pages use
 * unpredictable numeric-ID-prefixed paths (e.g. /5308/shows/avenue-q/,
 * /313823/shows/stranger-things-the-first-shadow-tickets/) that can't be
 * guessed from the show's slug/id the way broadway.com's /shows/{slug}/
 * pattern can (see BRO-1158). Discovery instead goes through Google SERP —
 * the same site:-scoped pattern scripts/lib/serp-slug-discovery.js already
 * uses for seatplan.com/londonboxoffice.co.uk/londontheatredirect.com — and
 * the result is persisted to data/westend-slug-map.json (dtli-slug-map.json
 * pattern) so a show is only SERP-queried once.
 *
 * Deliberately a THIN wrapper around serpQuery rather than reusing
 * discoverSlug() from serp-slug-discovery.js: that function returns only the
 * trailing slug segment ('avenue-q'), discarding the numeric ID prefix that
 * is required to actually fetch the page. This module needs the full URL.
 */

'use strict';

const fs = require('fs');
const { foldDiacritics } = require('./title-match');

const WET_URL_RE = /westendtheatre\.com\/\d+\/shows\/[a-z0-9-]+\/?/i;

// Negative-cache retry window. Without this, a show with no westendtheatre.com
// presence (not covered at all, or a newly-added show WET hasn't picked up
// yet) gets re-SERP-queried on every single daily audit run indefinitely —
// unbounded, silently compounding SERP spend as the open-WE-show list grows.
// A show can gain WET coverage later (WET adds new productions continuously),
// so this is a retry-after, not a permanent skip.
const NEGATIVE_CACHE_RETRY_DAYS = 14;

function loadSlugMap(mapPath) {
  try {
    return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch {
    return { _meta: { lastUpdated: null, source: 'westendtheatre.com via SERP', matchedShows: 0 }, shows: {} };
  }
}

function saveSlugMap(mapPath, map) {
  map._meta = map._meta || {};
  map._meta.lastUpdated = new Date().toISOString().slice(0, 10);
  map._meta.matchedShows = Object.keys(map.shows || {}).length;
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
}

/**
 * Pick the best westendtheatre.com show-page URL from a SERP result set.
 * Pure function — no network — so it's directly testable against fixture
 * SERP payloads (CLAUDE.md rule 15).
 *
 * @param {Array<{url: string, title?: string}>} results
 * @param {string} showTitle
 * @returns {string|null}
 */
function pickBestWetUrl(results, showTitle) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const titleNorm = foldDiacritics(showTitle).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const titleWords = titleNorm.split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));

  for (const r of results) {
    const url = r.url || '';
    if (!WET_URL_RE.test(url)) continue;
    if (/\/reviews?\//i.test(url)) continue; // review-roundup posts, not the booking page
    const resultTitle = foldDiacritics(r.title || '').toLowerCase();
    const matchCount = titleWords.filter(w => resultTitle.includes(w)).length;
    if (titleWords.length > 0 && matchCount < Math.max(1, Math.ceil(titleWords.length * 0.5))) continue;
    const m = url.match(/(https?:\/\/(?:www\.)?westendtheatre\.com\/\d+\/shows\/[a-z0-9-]+\/?)/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Discover (or read from cache) the westendtheatre.com booking-page URL for
 * a show. Writes new discoveries back to the slug map.
 *
 * @param {object} show - shows.json record ({ id, name/title })
 * @param {string} mapPath - path to data/westend-slug-map.json
 * @param {object} [opts]
 * @param {Function} [opts.serpQuery] - injected for tests; defaults to url-discovery's serpQuery
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<string|null>}
 */
async function discoverWestEndTheatreUrl(show, mapPath, opts = {}) {
  const log = opts.log || (() => {});
  const serpQuery = opts.serpQuery || require('./url-discovery').serpQuery;
  const title = show.name || show.title || show.id;

  const map = loadSlugMap(mapPath);
  const cached = map.shows[show.id];
  if (cached && cached.url) return cached.url;
  if (cached && cached.notFoundAt) {
    const daysSince = Math.floor((Date.now() - new Date(cached.notFoundAt).getTime()) / 86400000);
    if (daysSince < NEGATIVE_CACHE_RETRY_DAYS) return null;
  }

  const query = `site:westendtheatre.com "${title}"`;
  let results;
  try {
    results = await serpQuery(query, { nbResults: 10, geo: 'gb', log });
  } catch (e) {
    log(`  [we-slug-discovery] SERP error for ${show.id}: ${e.message.slice(0, 100)}`);
    return null;
  }
  // serpQuery() returns null (not an empty array, not a throw) when no SERP
  // provider key is configured, or on some provider failures — see
  // url-discovery.js's "⚠ No SERP API keys available" early-return. That is
  // NOT the same fact as "queried Google and got zero westendtheatre.com
  // matches": conflating the two would write a false notFoundAt entry every
  // time the provider is unavailable (observed live in this session's own
  // local dry-run with no SERP keys set — every show got cached as
  // not-found), silently suppressing real discovery for 14 days once a key
  // IS configured. Only persist the negative cache when the query genuinely
  // ran (results is an array, however empty).
  if (results === null || results === undefined) {
    log(`  [we-slug-discovery] SERP unavailable for ${show.id} — not caching as not-found`);
    return null;
  }
  const url = pickBestWetUrl(results, title);
  if (!url) {
    map.shows[show.id] = { notFoundAt: new Date().toISOString().slice(0, 10) };
    saveSlugMap(mapPath, map);
    return null;
  }

  map.shows[show.id] = { url, discoveredAt: new Date().toISOString().slice(0, 10) };
  saveSlugMap(mapPath, map);
  return url;
}

module.exports = {
  loadSlugMap,
  saveSlugMap,
  pickBestWetUrl,
  discoverWestEndTheatreUrl,
  WET_URL_RE,
};
