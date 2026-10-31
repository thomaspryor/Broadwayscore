'use strict';
/**
 * BRO-6606: match The Stage review sitemap entries to UK regional hub shows.
 *
 * The Stage review URLs are /reviews/<title>-review-<venue>-<city>-<names>, and
 * SiteMap_TheStage_Articles_Reviews1_v2.xml lists every one with a lastmod, so
 * discovery needs no login. A match needs the same title slug, a venue/city that
 * agrees with the show's venue, and a lastmod near the show's run.
 */

const VENUE_STOP = new Set(['the', 'theatre', 'theater', 'and', 'of', 'at', 'in', 'uk']);
const DAY = 86400000;

function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** { url, lastmod } entries from a sitemap body. */
function parseSitemapEntries(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/) || [])[1];
    const lastmod = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/) || [])[1] || null;
    if (loc) out.push({ url: loc, lastmod });
  }
  return out;
}

/** { titleSlug, rest } from a Stage review URL, or null when it is not a /reviews/ page. */
function parseStageReviewUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/^\/reviews\/([a-z0-9-]+?)\/?$/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const i = slug.indexOf('-review-');
  if (i < 1) return null;
  return { titleSlug: slug.slice(0, i), rest: slug.slice(i + '-review-'.length) };
}

function venueTokens(show) {
  const [name, city] = String(show.venue || '').split(',').map((x) => x.trim());
  const toks = (x) => slugify(x).split('-').filter((t) => t && !VENUE_STOP.has(t));
  return { name: toks(name), city: toks(city) };
}

function stripThe(s) { return s.replace(/^the-/, ''); }

function titleMatches(showSlug, stageSlug) {
  const a = stripThe(showSlug);
  const b = stripThe(stageSlug);
  if (a === b) return true;
  // "A Christmas Carol: A Ghost Story" is listed under its main title.
  return b.length >= 8 && a.startsWith(`${b}-`) && b.split('-').length >= 2;
}

/**
 * Score a Stage entry against a show. Returns null when the title or venue
 * disagrees, else { venueScore, dateOk }.
 */
function matchEntry(show, entry) {
  const p = parseStageReviewUrl(entry.url);
  if (!p) return null;
  if (!titleMatches(slugify(show.title), p.titleSlug)) return null;
  const rest = new Set(p.rest.split('-'));
  const v = venueTokens(show);
  const nameHit = v.name.length ? v.name.filter((t) => rest.has(t)).length / v.name.length : 0;
  const cityHit = v.city.length ? v.city.some((t) => rest.has(t)) : false;
  // One-word venues (Tron, Crucible, Octagon, Home) exist in several cities: the city must match too.
  if (v.name.length === 1 && !cityHit) return null;
  if (!(nameHit >= 0.75 || (nameHit >= 0.5 && cityHit))) return null;
  const open = show.openingDate ? Date.parse(show.openingDate) : NaN;
  const mod = entry.lastmod ? Date.parse(entry.lastmod) : NaN;
  let dateOk = null;
  if (Number.isFinite(open) && Number.isFinite(mod)) dateOk = mod >= open - 45 * DAY && mod <= open + 180 * DAY;
  return { venueScore: nameHit, cityHit, dateOk, url: entry.url, lastmod: entry.lastmod };
}

/** Matches per show id: only entries whose date window is confirmed (dateOk === true). */
function matchShows(shows, entries) {
  const out = {};
  for (const s of shows) {
    const hits = [];
    for (const e of entries) {
      const m = matchEntry(s, e);
      if (m && m.dateOk === true) hits.push(m);
    }
    if (hits.length) out[s.id] = hits;
  }
  return out;
}

module.exports = { slugify, parseSitemapEntries, parseStageReviewUrl, venueTokens, titleMatches, matchEntry, matchShows };
