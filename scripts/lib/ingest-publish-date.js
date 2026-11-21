'use strict';
// The publish date ingest-review-from-url.js stores for a page (BRO-6588).
// Same order the collector uses (collect-review-texts.js, page date then the
// byline fallback): the caller's --publish-date, the page metadata
// (article:published_time / JSON-LD / <time>), The Stage's walled-page meta,
// then the one byline date in the first 500 chars of the article text. The
// ingest path used to stop after the metadata, so a page served without its
// <head> (TheWrap's A Few Good Men review) landed undated.

const { extractPublishDate } = require('./article-extractor');
const { extractDateFromText } = require('./body-date-mismatch');
const { bodyPublishDateFallback } = require('./publish-date-provenance');
const { extractDateFromUrl } = require('./url-date');

/**
 * @param {object} a
 * @param {string|null} [a.publishDateArg] - --publish-date, trusted as given
 * @param {string|null} [a.html]
 * @param {string} a.url
 * @param {string|null} [a.text] - extracted article body
 * @param {string|null} [a.stagePublishDate] - walled-page-meta date for The Stage
 * @returns {{publishDate: string|null, dateSource: 'text-regex'|null, from: 'arg'|'page'|'stage'|'text'|null, reason?: string}}
 */
// BRO-6716: a show-listing page (Cititour) carries the review but no article date,
// only the production's run block: "Open/Close Dates</b><br>Opening 4/12/2026".
// Read that labelled date only. A prior run's page prints its own, different date.
function listingOpeningDate(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/Open\/Close Dates(?:<[^>]+>|\s)*Opening\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// BRO-6742: Lighting & Sound America review pages carry no date anywhere, only
// a headline that names the theatre: "Theatre in Review: Giant (Music Box Theatre)".
// Venue names vary ("Second Stage/Hayes Theater" for "Helen Hayes Theater"), so
// compare the distinctive words. A match on THIS production's venue, and on no
// other production's venue, dates the review to this production's opening.
// Words that recur across many venue names (shows.json counts: royal 243,
// square 156, new 147, york 116, ...) or are city/state suffixes. A match needs
// a word outside this list, so "New World Stages" never matches "New York City Center".
const GENERIC_VENUE_WORDS = new Set(['the', 'theatre', 'theater', 'theatres', 'theaters', 'stage', 'stages', 'center', 'centre',
  'at', 'of', 'and', 'in', 'for', 'on', 'company', 'playhouse', 'hall', 'house', 'arts', 'performing', 'new', 'york', 'nyc',
  'city', 'old', 'royal', 'square', 'park', 'american', 'national', 'north', 'south', 'east', 'west', 'st', 'street', 'tour',
  'ny', 'il', 'ca', 'ma', 'dc', 'chicago', 'london', 'boston', 'studio', 'studios', 'second', 'first', 'space', 'room']);
function venueWords(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 2 && !GENERIC_VENUE_WORDS.has(w));
}
const normTitle = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
// "Theatre in Review: <Show> (<Venue>)" -> { show, venue }. The venue is the
// last parenthesis; everything before it is the show name.
function parseLsaHeadline(html) {
  if (typeof html !== 'string') return null;
  const t = html.match(/<title>\s*Theatre in Review:([^<]*)<\/title>/i);
  if (!t) return null;
  const head = t[1].replace(/&amp;|&#0?38;/g, '&').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+[-\u2013\u2014]\s+Lighting\s*&\s*Sound America.*$/i, '').trim();
  const m = head.match(/^(.*\S)\s*\(([^()]*)\)\s*$/);
  return m ? { show: m[1].trim(), venue: m[2].trim() } : null;  // venue-write-guard-ok: parses an LSA headline for a date fallback; never written to shows.json
}
function headlineVenue(html) {
  const p = parseLsaHeadline(html);
  return p ? p.venue : null;
}
// The headline must name THIS show (or its main title before a subtitle), and
// its theatre must share a distinctive word with this production's venue and
// with no other production's venue.
function headlineVenueDate(html, { showTitle = null, showVenue = null, showOpeningDate = null, otherVenues = [] } = {}) {
  if (!showTitle || !showVenue || !showOpeningDate) return null;
  const p = parseLsaHeadline(html);
  if (!p) return null;
  const hs = normTitle(p.show);
  const st = normTitle(showTitle);
  const stMain = normTitle(String(showTitle).replace(/\s*[(:].*$/, ''));
  if (!hs || !(hs === st || hs === stMain || st.startsWith(hs + ' ') || hs.startsWith(st + ' '))) return null;
  const words = new Set(venueWords(p.venue));
  const hits = (venue) => venueWords(venue).some((w) => words.has(w));
  if (!hits(showVenue)) return null;
  if ((otherVenues || []).some(hits)) return null;
  return String(showOpeningDate).slice(0, 10);
}

function resolveIngestPublishDate({ publishDateArg = null, html = null, url, text = null, stagePublishDate = null, showOpeningDate = null, showTitle = null, showVenue = null, otherVenues = [] } = {}) {
  if (publishDateArg) return { publishDate: publishDateArg, dateSource: null, from: 'arg' };
  const page = html ? extractPublishDate(html, url) : null;
  if (page) return { publishDate: page, dateSource: null, from: 'page' };
  if (stagePublishDate) return { publishDate: stagePublishDate, dateSource: null, from: 'stage' };
  // Same floor as the collector: under 100 chars there is no byline to read.
  const fallback = (typeof text !== 'string' || text.length <= 100)
    ? { publishDate: null, reason: 'no-body-date' }
    : bodyPublishDateFallback({ textDate: extractDateFromText(text), urlDate: url ? extractDateFromUrl(url) : null });
  if (fallback.publishDate) return { publishDate: fallback.publishDate, dateSource: fallback.dateSource, from: 'text' };
  // Last resort, never over a page or byline date: the listing's run block names
  // THIS production's opening night, so the review is dated to it.
  const listed = listingOpeningDate(html);
  if (listed && showOpeningDate && listed === String(showOpeningDate).slice(0, 10)) {
    return { publishDate: listed, dateSource: 'listing-opening-date', from: 'listing' };
  }
  const byVenue = headlineVenueDate(html, { showTitle, showVenue, showOpeningDate, otherVenues });
  if (byVenue && fallback.reason !== 'body-url-conflict') {
    return { publishDate: byVenue, dateSource: 'headline-venue-opening-date', from: 'venue' };
  }
  // body-url-conflict: neither date wins; the rebuild's backfill settles it (BRO-5351).
  return { publishDate: null, dateSource: null, from: null, reason: fallback.reason };
}

module.exports = { resolveIngestPublishDate, listingOpeningDate, headlineVenueDate, headlineVenue };
