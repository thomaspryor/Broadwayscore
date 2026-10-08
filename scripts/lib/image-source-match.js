'use strict';
/**
 * Production-level matching for the title-keyed image caches in
 * fetch-show-images-auto.js (BRO-2242, BRO-4851).
 *
 * Mezzanine and Theatr are looked up by normalized title, so every production
 * of a title is a candidate. Picking by title alone put New York art on London
 * rows: Theatr (an NYC-only app) gave the 2025 Haymarket Othello the Denzel
 * Washington Broadway poster and the 2024 Haymarket Godot the Keanu Reeves one,
 * and Mezzanine's Broadway tie-break gave the 2025 Old Vic Oedipus the Studio 54
 * poster. These functions pick the candidate for THIS production: venue first,
 * then market, then the nearest date.
 *
 * Pure, no I/O (CLAUDE.md §15); scripts/lib/image-source-match.test.mjs.
 */

const { todaytixMarket } = require('./todaytix-market');
const { findOtherSameTitleProduction } = require('./canon-poster-art');

const DAY = 86400000;
const MAX_DATE_GAP_DAYS = 730;

/**
 * Venue name reduced to comparable tokens: accents folded, case dropped,
 * "the" and "theatre"/"theater" removed, punctuation collapsed. "The Old Vic"
 * and "Old Vic Theatre" both become "old vic"; "Noël Coward Theatre" and
 * "Noel Coward" match. Compared for equality, so "Old Vic" never matches
 * "Young Vic" and "Apollo" never matches "Apollo Victoria".
 */
function normalizeVenueName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && t !== 'the' && t !== 'theatre' && t !== 'theater')
    .join(' ');
}

function venuesMatch(a, b) {
  const na = normalizeVenueName(a);
  return !!na && na === normalizeVenueName(b);
}

/** The show's own date: opening night, else first preview. */
function showDateMs(show) {
  const t = Date.parse((show && (show.openingDate || show.previewsStartDate)) || '');
  return Number.isNaN(t) ? null : t;
}

// Mezzanine openedAt is { __type: 'Date', iso } from the Parse API but a plain
// ISO string from the diary-shows.json fallback; handle both.
function mezzDateMs(openedAt) {
  if (!openedAt) return null;
  const iso = typeof openedAt === 'object' ? openedAt.iso : openedAt;
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : t;
}

/**
 * Which city each normalized venue name belongs to, learned from shows.json:
 * 'london' or 'nyc' when every row at that venue is in one city, absent when
 * both (the Lyceum, the Palace) or never seen (renamed houses like the Martin
 * Beck). Mezzanine's isBroadway flag is unreliable for old productions (the
 * 2002 Martin Beck Man of La Mancha is false), so the venue decides.
 */
function buildVenueCityIndex(shows) {
  const seen = new Map();
  for (const s of shows || []) {
    const v = normalizeVenueName(s && s.venue);
    if (!v) continue;
    const city = todaytixMarket(s);
    seen.set(v, seen.has(v) && seen.get(v) !== city ? 'both' : city);
  }
  const index = new Map();
  for (const [v, c] of seen) if (c !== 'both') index.set(v, c);
  return index;
}

/**
 * Pick the Mezzanine production that is THIS show, or null.
 *  1. A candidate at the show's own venue (nearest date among them).
 *  2. Otherwise by city (venueCity, from buildVenueCityIndex): a row never
 *     takes a candidate at a venue known to be in the other city. A London row
 *     also drops isBroadway and undated candidates.
 *  3. Nearest full date; ties prefer Broadway only for NYC rows, then ratings.
 *  4. Rejected when more than 2 years from the show, or when the show has no
 *     date and several candidates remain.
 * @returns {{candidate: object|null, reason: string}}
 */
function pickMezzanineCandidate(show, candidates, venueCity) {
  const list = (candidates || []).filter((c) => c && c.artUrl);
  if (list.length === 0) return { candidate: null, reason: 'no candidates with art' };
  const showMs = showDateMs(show);
  const london = todaytixMarket(show) === 'london';
  const gap = (c) => {
    const m = mezzDateMs(c.openedAt);
    return showMs != null && m != null ? Math.abs(showMs - m) / DAY : Infinity;
  };
  const nearest = (pool, preferBroadway) => pool.slice().sort((a, b) =>
    (gap(a) - gap(b))
    || (preferBroadway ? (b.isBroadway === true) - (a.isBroadway === true) : 0)
    || ((b.ratingsCount || 0) - (a.ratingsCount || 0)))[0];

  const atVenue = list.filter((c) => venuesMatch(c.theater, show && show.venue));
  if (atVenue.length > 0) {
    return { candidate: nearest(atVenue, false), reason: `venue match (${atVenue[0].theater})` };
  }

  const cityOf = (c) => (venueCity ? venueCity.get(normalizeVenueName(c.theater)) : undefined);
  const otherCity = london ? 'nyc' : 'london';
  const pool = list.filter((c) => cityOf(c) !== otherCity
    && (!london || (c.isBroadway !== true && mezzDateMs(c.openedAt) != null)));
  if (pool.length === 0) return { candidate: null, reason: 'no candidate for this market' };
  if (showMs == null && pool.length > 1) {
    return { candidate: null, reason: `${pool.length} candidates but show has no date` };
  }
  const best = nearest(pool, !london);
  const g = gap(best);
  if (g !== Infinity && g > MAX_DATE_GAP_DAYS) {
    return { candidate: null, reason: `best candidate is ${Math.round(g)} days off` };
  }
  return { candidate: best, reason: g === Infinity ? 'undated' : `date gap ${Math.round(g)}d` };
}

/**
 * May this Theatr record supply art for this show? Theatr lists current New
 * York productions only, so:
 *  - a record at the show's own venue is always fine;
 *  - a London row never takes one;
 *  - a closed row takes one only when no other production shares its title
 *    (otherwise the record is most likely the later production).
 */
function theatrEligible(show, candidate, allShows) {
  if (!show || !candidate) return false;
  if (candidate.venue && venuesMatch(candidate.venue.name, show.venue)) return true;
  if (todaytixMarket(show) === 'london') return false;
  if (show.status === 'closed' && findOtherSameTitleProduction(show, allShows || [])) return false;
  return true;
}

/** Image source URLs a person rejected for this show (show.rejectedImageUrls). */
function isRejectedImage(images, show) {
  const rejected = show && Array.isArray(show.rejectedImageUrls) ? show.rejectedImageUrls : [];
  if (rejected.length === 0 || !images) return false;
  const base = (u) => String(u || '').split('?')[0];
  const set = new Set(rejected.map(base));
  return ['thumbnail', 'poster', 'hero'].some((k) => images[k] && set.has(base(images[k])));
}

/** IBDB is a Broadway database: any hit for a London row is another production. */
function ibdbEligible(show) {
  return todaytixMarket(show) !== 'london';
}

module.exports = {
  buildVenueCityIndex,
  normalizeVenueName,
  venuesMatch,
  pickMezzanineCandidate,
  theatrEligible,
  isRejectedImage,
  ibdbEligible,
};
