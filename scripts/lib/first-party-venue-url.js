'use strict';

/**
 * BRO-7668: is a URL the producing theatre's own site?
 *
 * Local-hub regional shows (theatreinchicago / theatreindc / theatreinla,
 * city-finder, BWW local reviews) sat at missing_tickets (high) in the
 * freshness report: 47 of 50 rows on 2026-11-24. The ticket enrichers only
 * accept hand-allowlisted hosts (ticket-link-discovery.js VENUE_SITES /
 * REGIONAL_VENUE_SITES), and none of those small US houses are on it, so the
 * free venue phase matched 0 of them and the SERP phase rejected their own
 * pages. Yet the theatre's own page was already in hand: city-finder stores it
 * in evidenceUrls (northcoastrep.org/production/the-cottage/), and the
 * theatreinX listing prints the theatre's website on its detail page.
 *
 * A URL counts as first-party only when its site label is spelled from the
 * venue's own name (equality, never substring): "North Coast Repertory
 * Theatre" -> northcoastrep, "Lyric Stage Company of Boston" -> lyricstage,
 * "City Lit Theater" -> citylit. A newspaper or critic site named after the
 * city (sandiegouniontribune, bostonglobe) can never equal such a spelling.
 */

const { foldDiacritics } = require('./title-match');
const { isBlockedOfficialUrl } = require('./official-url-discovery');

// Words a theatre's name shares with every other theatre's.
const GENERIC = new Set([
  'the', 'theatre', 'theater', 'theatres', 'theaters', 'company', 'co', 'stage',
  'playhouse', 'repertory', 'rep', 'arts', 'center', 'centre', 'performing',
  'house', 'festival', 'studio', 'group', 'productions', 'ensemble', 'of', 'and',
  'at', 'in', 'on', 'a',
]);
// Suffixes a theatre's domain commonly adds to its distinctive name.
const SUFFIXES = ['', 'theatre', 'theater', 'theatreco', 'theaterco', 'rep', 'stage', 'playhouse', 'arts', 'co', 'company'];
// Listing sites the hub shows are staged from: never a theatre's own page.
const LISTING_HOST_RE = /(^|\.)(theatrein[a-z]+\.com|broadwayworld\.com)$/i;
const MULTI_PART_TLDS = /\.(co|org|ac|com|net)\.(uk|au|nz)$/;

function words(text) {
  return foldDiacritics(String(text || '')).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** "Lyric Stage Company of Boston, Boston, MA" -> the theatre name part only. */
function venueName(venue) {
  return String(venue || '').split(',')[0].split(/\s+-\s+/)[0];
}

/** www.tickets.goodmantheatre.org -> goodmantheatre; cft.org.uk -> cft. */
function siteLabel(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const trimmed = host.replace(MULTI_PART_TLDS, '.tld').split('.');
  if (trimmed.length < 2) return null;
  return trimmed[trimmed.length - 2].replace(/-/g, '');
}

/** Every domain label a theatre with this name would plausibly own. */
function venueSpellings(venue) {
  const all = words(venueName(venue));
  const ws = all[0] === 'the' ? all.slice(1) : all;
  const distinctive = ws.filter((w) => !GENERIC.has(w));
  if (distinctive.length === 0) return new Set();
  const stems = new Set();
  for (let k = 1; k <= ws.length; k++) {
    const head = ws.slice(0, k);
    if (head.some((w) => !GENERIC.has(w))) stems.add(head.join(''));
  }
  stems.add(distinctive.join(''));
  const out = new Set();
  for (const stem of stems) {
    for (const suffix of SUFFIXES) {
      const s = stem + suffix;
      if (s.length >= 5) out.add(s);
    }
  }
  return out;
}

/** True when `url` is an http(s) page on the theatre's own site. */
function isFirstPartyVenueUrl(url, venue) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  if (isBlockedOfficialUrl(url)) return false;
  try { if (LISTING_HOST_RE.test(new URL(url).hostname)) return false; } catch { return false; }
  const label = siteLabel(url);
  return !!label && venueSpellings(venue).has(label);
}

/**
 * The best first-party page for a show from what it already carries:
 * a production page (non-root path) beats a homepage. `extra` lets a caller
 * offer a URL it just read (the theatreinX listing's website link).
 */
function pickFirstPartyVenueUrl(show, extra = []) {
  const cands = [...(show && Array.isArray(show.evidenceUrls) ? show.evidenceUrls : []), ...extra]
    .filter((u) => isFirstPartyVenueUrl(u, show && show.venue));
  const isRoot = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '') === ''; } catch { return true; } };
  return cands.find((u) => !isRoot(u)) || cands[0] || null;
}

module.exports = { isFirstPartyVenueUrl, pickFirstPartyVenueUrl, venueSpellings, siteLabel };
