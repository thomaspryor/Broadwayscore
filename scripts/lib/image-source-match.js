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
const AT_VENUE_MAX_GAP_DAYS = 1095;

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
 *  1. A candidate at the show's own venue (nearest date among them), unless
 *     its date is more than 3 years from the show's.
 *  2. Otherwise by city (venueCity, from buildVenueCityIndex): a row never
 *     takes a candidate at a venue known to be in the other city. A London row
 *     also drops isBroadway and undated candidates.
 *  3. Nearest full date; ties prefer Broadway only for NYC rows, then ratings.
 *  4. Rejected when more than 2 years from the show, when only undated
 *     candidates remain for a closed show that opened more than 2 years before
 *     nowMs, or when the show has no date and several candidates remain.
 * @returns {{candidate: object|null, reason: string}}
 */
function pickMezzanineCandidate(show, candidates, venueCity, { nowMs = Date.now() } = {}) {
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

  // A house plays many productions of one title (Chicago opened at the 46th
  // Street, now the Richard Rodgers, in 1975 and again in 1996), so a venue
  // match still has to be near the show's own date. The window is wider than
  // MAX_DATE_GAP_DAYS: Girl from the North Country's 2020 Belasco run reopened
  // there as the 2022 row after the pandemic shutdown.
  const atVenue = list.filter((c) => venuesMatch(c.theater, show && show.venue)
    && !(gap(c) !== Infinity && gap(c) > AT_VENUE_MAX_GAP_DAYS));
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
  // Away from the show's venue, an undated candidate is no evidence for a
  // closed production that opened years ago: the tie-break gave chicago-1975
  // the 2023 Ambassador poster. Running shows and recent ones keep it, since
  // Mezzanine's current listings (diary-shows.json) carry no date.
  if (g === Infinity && show.status === 'closed' && showMs != null
    && nowMs - showMs > MAX_DATE_GAP_DAYS * DAY) {
    return { candidate: null, reason: 'only undated candidates elsewhere for a closed show over 2 years old' };
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

/** A source URL without its query string, for comparing two image URLs. */
const sourceBase = (u) => String(u || '').split('?')[0];

/** Image source URLs a person rejected for this show (show.rejectedImageUrls). */
function isRejectedImage(images, show) {
  const rejected = show && Array.isArray(show.rejectedImageUrls) ? show.rejectedImageUrls : [];
  if (rejected.length === 0 || !images) return false;
  const set = new Set(rejected.map(sourceBase));
  return ['thumbnail', 'poster', 'hero'].some((k) => images[k] && set.has(sourceBase(images[k])));
}

/**
 * May archive-show-images.js keep the file already on disk instead of
 * downloading the CDN URL a fetch just put in shows.json? Only when that file
 * was downloaded from this same URL (recordedSource, from image-sources.json).
 * A fetch that picks new art for a row whose file name is unchanged (a .jpg
 * replacing a .jpg) otherwise left the old art on the site while
 * image-sources.json named the new source: the 2026-10-08 re-fetch did this to
 * 20+ historical Broadway rows (BRO-2242).
 */
function canReuseArchivedFile({ recordedSource, incomingUrl, fileExists, force }) {
  if (force || !fileExists) return false;
  return !!recordedSource && sourceBase(recordedSource) === sourceBase(incomingUrl);
}

/**
 * May a file found on disk fill a null shows.json image (page builder's hero
 * fallback, pre-deploy-check's orphan fix)? Not when the file's recorded
 * source (image-sources.json) is one a person rejected for this show: the
 * rejection nulls shows.json, and the disk fallback put 53 historical rows'
 * other-production banners straight back (BRO-2242).
 */
function mayServeDiskImage(show, recordedSource) {
  return !isRejectedImage({ hero: recordedSource }, show);
}

/** A recorded source a downloader can fetch (not manual:<note> or a label). */
const isDownloadableSource = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/**
 * The show id whose directory holds a local image path ("/images/shows/<id>/x.jpg"),
 * or null. A lineage row can point at a linked production's file, and that
 * file's provenance is recorded under the owner's id, not the row's.
 */
function imagePathOwner(p) {
  const m = typeof p === 'string' && p.match(/^\/images\/shows\/([^/]+)\//);
  return m ? m[1] : null;
}

/** The recorded source (image-sources.json) of the file show.images[format] serves. */
function recordedSourceFor(show, format, sources) {
  const owner = imagePathOwner(show && show.images && show.images[format]);
  const v = owner && sources && sources[owner] ? sources[owner][format] : null;
  return typeof v === 'string' ? v : null;
}

/**
 * May the fetcher keep the local file a show already serves for this format
 * when a re-fetch does not replace it? Not when that file's recorded source is
 * one a person rejected for this show: applyImages kept Kyoto's and the West
 * End Gatsby's New York banners this way after their rejection (BRO-4901).
 * No recorded source means unknown provenance, not rejected, so it is kept.
 */
function keepExistingImage(show, format, sources) {
  const existing = show && show.images && show.images[format];
  if (!imagePathOwner(existing)) return false;
  const recorded = recordedSourceFor(show, format, sources);
  return !recorded || !isRejectedImage({ [format]: recorded }, show);
}

/**
 * Local image fields in use whose recorded source is in the row's
 * rejectedImageUrls: either the art is still the rejected production, or a
 * hand fix replaced the file without updating image-sources.json. Both need a
 * person (BRO-4901). Returns [{ id, format, path, source }].
 */
function findRejectedSourcesInUse(shows, sources) {
  const out = [];
  for (const show of shows || []) {
    if (!show || !show.images || !Array.isArray(show.rejectedImageUrls) || !show.rejectedImageUrls.length) continue;
    for (const format of ['poster', 'thumbnail', 'hero']) {
      const p = show.images[format];
      if (!imagePathOwner(p)) continue;
      const source = recordedSourceFor(show, format, sources);
      if (source && isRejectedImage({ [format]: source }, show)) out.push({ id: show.id, format, path: p, source });
    }
  }
  return out;
}

/**
 * images._fileSources ({ format: { path, source } }) is how a fetch path that
 * writes a local file says where the bytes came from. The source URLs, for a
 * rejectedImageUrls check before the file is used.
 */
function fileSourceUrls(images) {
  const out = {};
  for (const [format, e] of Object.entries((images && images._fileSources) || {})) {
    if (e && typeof e.source === 'string') out[format] = e.source;
  }
  return out;
}

/**
 * Write images._fileSources into the image-sources map for every format whose
 * final value is still the file that fetch wrote (a format the caller kept
 * from before, or replaced, is left alone). Mutates sources; returns the
 * formats recorded.
 */
function recordFileSources(sources, images) {
  const recorded = [];
  if (!sources || !images) return recorded;
  for (const [format, e] of Object.entries(images._fileSources || {})) {
    const owner = e && imagePathOwner(e.path);
    if (!owner || typeof e.source !== 'string' || images[format] !== e.path) continue;
    sources[owner] = sources[owner] || {};
    sources[owner][format] = e.source;
    recorded.push(format);
  }
  return recorded;
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
  canReuseArchivedFile,
  mayServeDiskImage,
  ibdbEligible,
  isDownloadableSource,
  imagePathOwner,
  recordedSourceFor,
  keepExistingImage,
  findRejectedSourcesInUse,
  fileSourceUrls,
  recordFileSources,
};
