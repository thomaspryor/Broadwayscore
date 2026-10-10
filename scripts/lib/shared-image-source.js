'use strict';

/**
 * One poster source, one show (BRO-4996).
 *
 * data/image-sources.json records where each show's image files came from. The
 * same source URL recorded for two show ids means one of them is showing the
 * other's art: the 2016 Forest Whitaker Hughie on the 1996 row, Hell's Kitchen
 * art on Illinoise, one Show Score file on 15 Kiln/Soho fringe rows. This
 * module is the guard the fetchers consult before taking a source, and the
 * audit's way of listing the rows that already share one.
 *
 * Sharing is fine only between productions the data links (transfers, tours:
 * cross-show-images.js lineageIds) or that ALLOWED_SHARED_IMAGES lists after a
 * look at the art. Sources that are known placeholders are never art. A row
 * that lists a source in its own rejectedImageUrls does not own it, so
 * rejecting it on the wrong row frees it for the right one.
 *
 * Pure, no I/O (CLAUDE.md §15); scripts/lib/shared-image-source.test.mjs.
 */

const { lineageIds, ALLOWED_SHARED_IMAGES } = require('./cross-show-images');
const { sameTitle } = require('./canon-poster-art');
const { todaytixMarket } = require('./todaytix-market');
const { isBroadwayCategory } = require('./venue-classification');

/** A source URL without its query string or Show Score CDN host (image-source-match.js). */
const { sourceBase } = require('./image-source-match');

const FORMATS = ['poster', 'thumbnail', 'hero'];

/** Only http(s) sources are art; "manual:<note>" entries are notes. */
const isUrlSource = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

// Sources that are not this or any listed show's art: a Show Score promo
// image that fetchFromShowScore's first-match regex took from the pages of 18
// unrelated Kiln/Soho/New Diorama rows ("Chicks in Heaven" has no row here).
// Compared without the query string.
const PLACEHOLDER_SOURCES = new Set([
  'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/62/medium_1711643050-chicks_in_heaven_poster_graphic__2_.jpg',
  'https://d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/62/preview_1711643050-chicks_in_heaven_poster_graphic__2_.jpg',
].map(sourceBase));

function isPlaceholderSource(url) {
  if (!isUrlSource(url)) return false;
  return PLACEHOLDER_SOURCES.has(sourceBase(url));
}

/**
 * May showId and otherId record the same source? Lineage-linked productions
 * and ALLOWED_SHARED_IMAGES pairs (either direction) may.
 */
function mayShareSource(showId, otherId, shows, { allowlist = ALLOWED_SHARED_IMAGES } = {}) {
  if (!showId || !otherId || showId === otherId) return true;
  if (allowlist[showId] && allowlist[showId].owner === otherId) return true;
  if (allowlist[otherId] && allowlist[otherId].owner === showId) return true;
  return lineageIds(showId, shows).has(otherId);
}

/**
 * Map of source base -> Set of show ids recording it (poster/thumbnail/hero,
 * http sources only). With shows, only their ids count (a retired row's
 * leftover entry shows nothing), and a source a row lists in its own
 * rejectedImageUrls is not that row's.
 */
function buildSourceIndex(sources, shows = null) {
  const byId = shows ? new Map(shows.filter(Boolean).map((s) => [s.id, s])) : null;
  const index = new Map();
  for (const [id, entry] of Object.entries(sources || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (byId && !byId.has(id)) continue;
    const rejected = new Set(((byId && byId.get(id).rejectedImageUrls) || []).map(sourceBase));
    for (const f of FORMATS) {
      if (!isUrlSource(entry[f])) continue;
      const k = sourceBase(entry[f]);
      if (rejected.has(k)) continue;
      if (!index.has(k)) index.set(k, new Set());
      index.get(k).add(id);
    }
  }
  return index;
}

/** Record that showId now uses url (fetchers call this as they accept art). */
function addToSourceIndex(index, showId, url) {
  if (!index || !isUrlSource(url)) return;
  const k = sourceBase(url);
  if (!index.has(k)) index.set(k, new Set());
  index.get(k).add(showId);
}

/**
 * Why showId must not take url, or null when it may: a known placeholder, or a
 * source another show already records that is not the same production.
 * @returns {null | {reason: 'placeholder'} | {reason: 'owned', owner: string}}
 */
function sourceConflict(showId, url, index, shows, opts) {
  if (!isUrlSource(url)) return null;
  if (isPlaceholderSource(url)) return { reason: 'placeholder' };
  const owners = index && index.get(sourceBase(url));
  if (!owners) return null;
  for (const other of owners) {
    if (other !== showId && !mayShareSource(showId, other, shows, opts)) return { reason: 'owned', owner: other };
  }
  return null;
}

/**
 * The images object with every format whose URL conflicts set to null, and
 * the dropped entries for logging. Local paths and nulls pass through.
 */
function stripConflictingSources(showId, images, index, shows, opts) {
  if (!images || typeof images !== 'object') return { images, dropped: [] };
  const out = { ...images };
  const dropped = [];
  for (const f of FORMATS) {
    const c = sourceConflict(showId, out[f], index, shows, opts);
    if (c) { dropped.push({ format: f, url: out[f], ...c }); out[f] = null; }
  }
  return { images: out, dropped };
}

/**
 * Sources recorded for two or more live, unrelated show ids, plus placeholder
 * sources in use. For the audit: [{ source, ids, placeholder }].
 */
function findSharedSources(sources, shows, opts) {
  const index = buildSourceIndex(sources, shows || []);
  const out = [];
  for (const [source, idSet] of index) {
    const ids = [...idSet].sort();
    const placeholder = PLACEHOLDER_SOURCES.has(source); // index keys are already sourceBase'd
    if (placeholder) { out.push({ source, ids, placeholder }); continue; }
    if (ids.length < 2) continue;
    const unrelated = ids.some((a, i) => ids.slice(i + 1).some((b) => !mayShareSource(a, b, shows, opts)));
    if (unrelated) out.push({ source, ids, placeholder });
  }
  return out;
}

const showYear = (s) => {
  const t = Date.parse((s && (s.openingDate || s.previewsStartDate)) || '');
  return Number.isNaN(t) ? null : new Date(t).getUTCFullYear();
};

/**
 * May this show take art from the Show Score page `url`? Show Score keeps one
 * page per title, showing its newest production, so when another production
 * of the same title resolves to the same page (resolveUrl: show -> url), only
 * the newest of them may use its art. skylight-1996 took the 2015
 * Mulligan/Nighy poster, the-little-foxes-1997 the 2017 Linney/Nixon one and
 * hughie-1996 the 2016 Forest Whitaker one this way (BRO-4996). A row with no
 * date loses to a dated one.
 */
function showScoreArtEligible(show, url, allShows, resolveUrl) {
  if (!show || !url) return false;
  const mine = showYear(show);
  for (const other of allShows || []) {
    if (!other || other.id === show.id || !sameTitle(show, other)) continue;
    if (sourceBase(resolveUrl(other)) !== sourceBase(url)) continue;
    const theirs = showYear(other);
    if (theirs != null && (mine == null || theirs > mine)) return false;
  }
  return true;
}

// Without these, "The Caretaker" half-matches the-lion-king-on-broadway.
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in']);
const slugWords = (t) => String(t || '').toLowerCase().replace(/-/g, ' ')
  .replace(/[\'\u2018\u2019]/g, '') // "Doll's" is "dolls" in a slug
  .replace(/["\u201C\u201D:!?,.()&+]/g, ' ')
  .replace(/\bon broadway\b|\bthe musical\b/g, ' ')
  .split(/[\s-]+/).filter((w) => w && !STOP_WORDS.has(w));

/** Does a TodayTix slug name this title? Half its words, as in discoverTodayTixId, minus stop words. */
function titleMatchesSlug(title, slug) {
  // Unique words: "Big Man, Little Man" is not half of "music-man".
  const words = [...new Set(slugWords(title))];
  const inSlug = new Set(slugWords(slug));
  return words.length > 0 && words.filter((w) => inSlug.has(w)).length / words.length >= 0.5;
}

/** Share of the slug's words the title has. */
function slugCoverage(title, slug) {
  const t = new Set(slugWords(title)), sw = [...new Set(slugWords(slug))];
  return sw.length ? sw.filter((w) => t.has(w)).length / sw.length : 0;
}

/**
 * Every (non-stop) word of title a is in title b, and b is not a numbered
 * sequel ("The Devil Wears Prada 2"). A one-word title counts only as b's
 * main title before a subtitle ("Cats: The Jellicle Ball"), so "Player" is
 * not within "Player Kings" nor "End" within "The Ocean at the End of the Lane".
 */
function wordsWithin(a, b) {
  const wa = slugWords(a), wbl = slugWords(b), wb = new Set(wbl);
  if (!wa.length || !wa.every((w) => wb.has(w))) return false;
  if (new Set(wa).size === 1) {
    const la = String(a).trim().toLowerCase(), lb = String(b).trim().toLowerCase();
    if (!lb.startsWith(la) || !/^\s*[:!(\u2013\u2014-]/.test(lb.slice(la.length))) return false;
  }
  const sa = new Set(wa);
  return !wbl.some((w) => !sa.has(w) && /^\d+$/.test(w));
}

const isRunning = (s) => s && (s.status === 'open' || s.status === 'previews');

// An announced row often has no date yet; its id carries the season year.
const rowYear = (s) => {
  const y = showYear(s);
  if (y != null) return y;
  const m = /-(\d{4})$/.exec((s && s.id) || '');
  return m ? Number(m[1]) : null;
};

const newerThan = (a, b) => {
  const ya = rowYear(a), yb = rowYear(b);
  return ya != null && (yb == null || ya > yb);
};

/**
 * The other live row that owns TodayTix id `id`, when this show must not use
 * it; else null. One TodayTix page is one production, and the cache in
 * data/todaytix-ids.json holds ids under unrelated rows (the Lion King's 42
 * under the-caretaker-2003, & Juliet's 25598 under romeo-juliet-2024). It
 * decides an owner rather than refusing everyone: the row whose title the
 * cached slug names wins; between rows of one title, a "-on-broadway" page is
 * the Broadway row's, else in one TodayTix city the newest row's (the page
 * sells the current production). Anything less certain is left to the
 * image-source guard.
 */
function todaytixIdOwner(show, id, cachedShows, shows, opts) {
  if (!show || id == null || !cachedShows) return null;
  const byId = new Map((shows || []).filter(Boolean).map((s) => [s.id, s]));
  for (const [otherId, entry] of Object.entries(cachedShows)) {
    if (otherId === show.id || !entry || entry.id == null || String(entry.id) !== String(id)) continue;
    const other = byId.get(otherId);
    if (!other || mayShareSource(show.id, otherId, shows, opts)) continue;
    const slug = entry.slug || (cachedShows[show.id] && cachedShows[show.id].slug);
    // "Cats: The Jellicle Ball" and "Cats" are one title for this purpose.
    const related = sameTitle(show, other) || wordsWithin(show.title, other.title) || wordsWithin(other.title, show.title);
    // A "<title>-on-broadway" page is the Broadway production's.
    if (slug && related && /-on-broadway$/.test(slug)) {
      const mineBw = isBroadwayCategory(show), theirsBw = isBroadwayCategory(other);
      if (theirsBw && !mineBw) return otherId;
      if (mineBw && !theirsBw) continue;
    }
    if (slug && !related) {
      const mine = titleMatchesSlug(show.title, slug);
      const theirs = titleMatchesSlug(other.title, slug);
      if (theirs && !mine) return otherId;
      if (mine && !theirs) continue;
      // Both name it ("Raisin" and "A Raisin in the Sun"): the fuller name wins.
      if (mine && theirs) {
        const a = slugCoverage(show.title, slug), b = slugCoverage(other.title, slug);
        if (b > a) return otherId;
        if (a > b) continue;
      }
    }
    if (!related || todaytixMarket(show) !== todaytixMarket(other)) continue;
    // A running production keeps the page over an upcoming or closed one.
    if (isRunning(other) && !isRunning(show)) return otherId;
    if (isRunning(show) && !isRunning(other)) continue;
    if (newerThan(other, show)) return otherId;
  }
  return null;
}

module.exports = {
  todaytixIdOwner,
  showScoreArtEligible,
  titleMatchesSlug,
  PLACEHOLDER_SOURCES,
  sourceBase,
  isPlaceholderSource,
  mayShareSource,
  buildSourceIndex,
  addToSourceIndex,
  sourceConflict,
  stripConflictingSources,
  findSharedSources,
};
