'use strict';

/**
 * Season listings for finder-based city hubs (BRO-7250). Pure functions, no I/O: the CLI is
 * scripts/city-season-sync.js. A hub should list the local professional productions running now or
 * opening soon BEFORE any review exists, so the source is the producing theatre's own season page
 * (read by an LLM, every row checked against the page text) plus BroadwayWorld's regional listing
 * (dates and art, allowlisted theatres only).
 *
 * Rules carried from the hub work (BRO-6854, BRO-7239): a closing date is only written with its source;
 * tours, concerts, readings, galas, youth and amateur companies never become hub shows; ids follow
 * "<slug>-regional-<year>" (add-show-action.js).
 */

const { norm, hasPhrase, addDays } = require('./city-review-finder');
const { SEASON_SOURCES } = require('./city-finder-config');

const HORIZON_DAYS = 100; // "the next ~3 months"
const MAX_RUN_DAYS = 200; // a longer "run" is a season banner, not a production

const NON_PRODUCTION_RE = /\b(tour|school|youth|teen|kids?|family series|jr\.?|concert|recital|tribute|tree lighting|reading|gala|benefit|fundraiser|workshop|class(es)?|camp|auditions?|open house|improv|karaoke|trivia|silent movie|in concert|live in|storytime|story time|rental|subscription|season ticket|gift|membership|tbd)\b/i;

/** Houses that mostly present touring work: never a producing theatre for a local hub. */
const PRESENTERS = new Set(['ArtsEmerson', 'Emerson Colonial Theatre']);

/** The producing theatre a listing's venue string names, or null (not on the allowlist). */
function resolveTheatre(city, venue) {
  const n = norm(venue);
  if (!n) return null;
  for (const t of city.theatres) {
    const names = [t.name, ...(t.aliases || []), ...((SEASON_SOURCES[t.name] || {}).venues || [])];
    if (names.some((a) => hasPhrase(n, a))) return PRESENTERS.has(t.name) ? null : t;
  }
  return null;
}

const isIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));

/** A row is usable when it has real dates, runs now or inside the horizon, and is not a banner or non-production. */
function usableWindow(row, today, horizonDays = HORIZON_DAYS) {
  if (!isIso(row.start) || !isIso(row.end) || row.start > row.end) return false;
  if ((Date.parse(row.end) - Date.parse(row.start)) / 86400000 > MAX_RUN_DAYS) return false;
  return row.end >= today && row.start <= addDays(today, horizonDays);
}

/** BroadwayWorld regional-listing rows -> season rows, allowlisted professional theatres only. */
function fromBwwRows(rows, city, today, horizonDays = HORIZON_DAYS) {
  const out = [];
  for (const r of rows || []) {
    const t = resolveTheatre(city, r.theatre);
    if (!t || !t.pro || NON_PRODUCTION_RE.test(r.title)) continue;
    const row = { title: r.title, theatre: t.name, city: t.city || r.city, start: r.start, end: r.end, source: 'broadwayworld-regional-listing', pageUrl: r.bwwUrl, image: r.image || null };
    if (usableWindow(row, today, horizonDays)) out.push(row);
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** The page names this month with a day number beside it ("Nov 12", "12 November"), not just a word that starts alike. */
const monthIn = (text, iso) => {
  const i = Number(iso.slice(5, 7)) - 1;
  const m = `(?:${MONTHS[i]}\\.?|${FULL[i]})`;
  return new RegExp(`\\b${m}\\s*\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s*${m}\\b`, 'i').test(text);
};

/**
 * LLM rows read from a theatre's season page -> season rows. Nothing the page does not say survives:
 * the title must appear in the page text, the start or end month must be named there, and a production link
 * must be one of the page's own links.
 */
function fromPageRows(rows, { theatre, pageText, pageLinks = [], pageUrl, today, horizonDays = HORIZON_DAYS }) {
  const hay = norm(pageText);
  const links = new Set(pageLinks);
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.title || NON_PRODUCTION_RE.test(r.title)) continue;
    if (!` ${hay} `.includes(` ${norm(r.title)} `)) continue;
    const row = { title: String(r.title).trim(), theatre: theatre.name, city: theatre.city, start: r.start, end: r.end, source: 'theatre-season-page', type: r.type, pageUrl: links.has(r.url) ? r.url : pageUrl, image: null };
    if (!usableWindow(row, today, horizonDays)) continue;
    if (!monthIn(pageText, row.start) && !monthIn(pageText, row.end)) continue;
    out.push(row);
  }
  return out;
}

const keyOf = (r) => `${norm(r.title)}|${norm(r.theatre)}`;

/** One row per production: theatre-page dates win over the listing; the listing's art is kept. */
function mergeSeason(lists) {
  const byKey = new Map();
  for (const row of lists.flat()) {
    const k = keyOf(row);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...row, sources: [row.source] }); continue; }
    const winner = row.source === 'theatre-season-page' && prev.source !== 'theatre-season-page' ? row : prev;
    const loser = winner === row ? prev : row;
    byKey.set(k, { ...winner, image: winner.image || loser.image, bwwUrl: [winner, loser].map((x) => x.pageUrl).find((u) => /broadwayworld/.test(u || '')) || null, sources: [...new Set([...(prev.sources || [prev.source]), row.source])] });
  }
  return [...byKey.values()].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/** Existing hub show for a season row (same title; venue names the theatre when the title is not unique). */
function findExisting(row, shows) {
  const yr = (d) => String(d || '').slice(0, 4);
  const same = shows.filter((s) => norm(s.title) === norm(row.title) && [yr(s.openingDate), yr(s.closingDate)].some((y) => y && (y === yr(row.start) || y === yr(row.end))));
  if (!same.length) return null;
  const th = norm(row.theatre).replace(/^the /, '');
  return same.find((s) => norm(s.venue || '').includes(th)) || null;
}

const slugify = (t) => String(t).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** id "<title>-regional-<year>"; a clash adds the theatre's first word; a second clash drops the row. */
function showId(row, taken) {
  const year = row.start.slice(0, 4);
  const base = slugify(row.title);
  const first = slugify(row.theatre).replace(/^the-/, '').split('-')[0];
  return [`${base}-regional-${year}`, `${base}-${first}-regional-${year}`].find((id) => !taken.has(id)) || null;
}

/**
 * The add-show entry for a season row. Dates are the theatre's own (closingDate + closingDateSource);
 * `images` is filled by the caller once the art is on disk.
 */
function buildShow(row, { id, hubSlug, hub, city, today, venueOf = (x) => x }) {
  return {
    id, title: row.title, slug: id,
    venue: venueOf(`${row.theatre}, ${row.city || city.defaultCity}, ${city.state}`),
    status: row.start > today ? 'upcoming' : 'open',
    type: row.type === 'musical' || row.type === 'play' ? row.type : (/\b(musical|cabaret|cinderella)\b/i.test(row.title) ? 'musical' : 'play'),
    category: 'regional', market: 'regional',
    openingDate: row.start, openingDateSource: row.source,
    closingDate: row.end, closingDateSource: row.source,
    discoverySource: hub.discoverySource,
    localOnly: true, city: hubSlug,
    discoveredAt: today,
    evidenceUrls: [row.pageUrl, row.bwwUrl].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i).slice(0, 3),
  };
}

module.exports = { HORIZON_DAYS, NON_PRODUCTION_RE, resolveTheatre, usableWindow, fromBwwRows, fromPageRows, mergeSeason, findExisting, showId, buildShow, slugify };
