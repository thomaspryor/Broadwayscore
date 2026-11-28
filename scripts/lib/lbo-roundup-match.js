/**
 * Match an LBO roundup URL to a tracked West End show (BRO-6101).
 *
 * The scraper stripped a hardcoded list of theatre names from the URL slug and
 * title-matched what was left. Any venue not on that list ("tom-stoppard-theatre",
 * "regents-park-open-air-theatre") stayed in the title, dropped the match to
 * medium confidence and the roundup was skipped: Rent, Cats and One Flew Over
 * the Cuckoo's Nest were lost this way while their roundups sat in the sitemap.
 *
 * Fallback used only when the title match is not high confidence. The slug is
 * "<title>-<venue>", so a show matches when its title opens the slug and the
 * words after it name its venue. That also separates two same-title productions
 * (Jesus Christ Superstar at the Palladium vs at Drury Lane). A theatre renamed
 * since shows.json recorded it (Duke of York's -> Tom Stoppard Theatre) has no
 * venue overlap; then a single production opening within a year of the roundup
 * is accepted. The fetched page's own title is still checked afterwards.
 */
const { matchTitleToShow } = require('./show-matching');
const { foldDiacritics } = require('./title-match');
const { checkAggregatorPageProduction } = require('./aggregator-page-production');
const { extractPublishDate } = require('./article-extractor');
const fs = require('fs');
const path = require('path');
const { canonicalUrlFromHtml, sameRoundupUrl } = require('./aggregator-page-production');

// LBO's reported transposition, not a general fuzzy title match.
function canonicalizeLboTitle(title) {
  return String(title || '').replace(/\bgrace[\s-]+prevades\b/gi, 'Grace Pervades');
}

const VENUE_GENERIC = new Set(['the', 'theatre', 'theater', 'centre', 'center', 'royal', 'of', 'at', 'and', 'london', 'hall', 'house', 'open', 'air']);

function norm(s) {
  return foldDiacritics(String(s || '')).toLowerCase()
    .replace(/[‘’‚′`]/g, "'").replace(/'/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    // slugs split contractions ("i-m-sorry", "york-s"); titles drop the apostrophe
    .replace(/\b([a-z]+) (s|m|t|d|re|ve|ll)\b/g, '$1$2')
    .trim();
}

function postSlugOf(url) {
  return String(url || '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/news\/post\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
}

// Roundup slugs sometimes name a different building than shows.json: a renamed
// house (Duke of York's is now the Tom Stoppard Theatre) or the National's
// auditoria. Each rule adds the slug-side tokens for a venue.
const VENUE_ALIASES = [
  { match: /duke of york/, add: ['tom', 'stoppard'] },
  { match: /\b(dorfman|olivier|lyttelton|cottesloe)\b/, add: ['national'] },
];

function venueTokens(venue) {
  const n = norm(venue);
  const tokens = n.split(' ').filter(w => w && !VENUE_GENERIC.has(w));
  for (const rule of VENUE_ALIASES) if (rule.match.test(n)) tokens.push(...rule.add);
  return tokens;
}

function matchBySlug(url, shows, year) {
  // "review-roundup-<title>-<venue>" or "<title>-<venue>-review-round-up"
  const slugNorm = norm(postSlugOf(url)).replace(/\breview round ?up\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!slugNorm) return null;
  const hits = [];
  for (const s of shows) {
    const full = norm(s.title);
    // LBO drops a trailing "the musical" ("Kinky Boots the Musical" -> kinky-boots-...)
    const t = [full, full.replace(/ the musical$/, '')].find(c => c && (slugNorm === c || slugNorm.startsWith(c + ' ')));
    if (!t) continue;
    const tail = slugNorm.slice(t.length).trim().split(' ').filter(Boolean);
    const vt = venueTokens(s.venue);
    const venueHit = tail.length > 0 && vt.length > 0 && vt.some(w => tail.includes(w));
    hits.push({ show: s, tail, venueHit });
  }
  if (!hits.length) return null;
  const inWindow = (h) => !year
    || (h.show.openingDate && Math.abs(Number(h.show.openingDate.slice(0, 4)) - year) <= 1);
  // A venue hit alone is not enough: the same title at the same venue recurs
  // (Royal Court, Regent's Park), so the production must also be in the
  // roundup's year window. <lastmod> is an edit date, so the window is +-1.
  const withVenue = hits.filter(h => h.venueHit && inWindow(h));
  if (withVenue.length === 1) return withVenue[0].show;
  // Several in-window productions at the venue: no safe pick.
  // No venue overlap is NOT matched: a longer slug ("cats-the-jellicle-ball-...")
  // is usually a different show that merely starts with this title.
  return null;
}

const yr = (d) => { const y = Number(String(d || '').slice(0, 4)); return y >= 1900 && y <= 2200 ? y : null; };

/**
 * Does the production run (opening-1 .. closing+1, open-ended while open) or a
 * prior run include `year`? <lastmod> is an edit date, hence the +-1 slack.
 * A show with no opening date cannot be placed, so it stays eligible.
 */
function showRunNearYear(show, year) {
  const runs = [{ o: yr(show.openingDate) || yr(show.previewsStartDate), c: yr(show.closingDate) }];
  for (const r of Array.isArray(show.priorRuns) ? show.priorRuns : []) runs.push({ o: yr(r && r.openingDate), c: yr(r && r.closingDate) });
  const dated = runs.filter(r => r.o);
  if (!dated.length) return true;
  const nowY = new Date().getFullYear();
  return dated.some((r, i) => {
    const c = r.c || (i === 0 && show.status !== 'closed' ? nowY : r.o);
    return year >= r.o - 1 && year <= c + 1;
  });
}

/**
 * @param {string} url roundup URL
 * @param {string|null} extractedTitle title parsed from the URL (theatre suffix stripped), if any
 * @param {object[]} shows London-market shows
 * @param {{year?:number}} [opts] article year from the sitemap <lastmod>
 * @returns {{show:object, via:'title'|'slug-venue'}|null}
 */
function matchLboRoundup(url, extractedTitle, shows, opts = {}) {
  extractedTitle = canonicalizeLboTitle(extractedTitle);
  if (extractedTitle) {
    // BRO-6089: with a sitemap year, only productions whose run (or a declared
    // prior run) reaches that year compete on title, so a same-title revival
    // from another era cannot take the round-up.
    // Only when another show shares the title: a unique title keeps its match
    // (<lastmod> is an edit date and can be years after the production).
    const key = norm(extractedTitle);
    const siblings = opts.year ? shows.filter(s => norm(s.title) === key) : [];
    const pool = siblings.length > 1 ? shows.filter(s => norm(s.title) !== key || showRunNearYear(s, opts.year)) : shows;
    const t = pool.length ? matchTitleToShow(extractedTitle, pool, { market: 'west-end' }) : null;
    if (t && t.show && t.confidence === 'high') return { show: t.show, via: 'title' };
  }
  const s = matchBySlug(url, shows, opts.year);
  return s ? { show: s, via: 'slug-venue' } : null;
}

/**
 * BRO-7545: the sitemap year cannot distinguish two runs in the same year.
 * Route the fetched page by its own publication metadata before archiving or
 * writing reviews. Prefer a show's own run over a later transfer's priorRuns.
 * An uncorroborated alternative never replaces the original candidate.
 */
function resolveLboRoundupProduction({ html, show, shows }) {
  const date = extractPublishDate(html, '') || null;
  const prod = checkAggregatorPageProduction({ html, show, pageDate: date });
  const unchanged = { show, prod, rerouted: false };
  if (!date) return unchanged;
  const siblings = shows.filter(s => norm(s.title) === norm(show.title));
  const match = matchTitleToShow(show.title, siblings, { market: 'west-end', date, year: Number(date.slice(0, 4)) });
  const alt = match && match.confidence === 'high' ? match.show : null;
  if (!alt || alt.id === show.id || !(alt.openingDate || alt.previewsStartDate)) return unchanged;
  const altProd = checkAggregatorPageProduction({ html, show: { ...alt, priorRuns: [] }, pageDate: date });
  if (!altProd.corroborated || altProd.outOfRun) return unchanged;
  return { show: alt, prod: altProd, rerouted: true, from: show.id };
}

// Once a page is routed to an earlier sibling, reuse that sibling's cache on
// the next cron run instead of fetching again under the title-only candidate.
function readLboRoundupArchive({ archiveDir, url, show, shows }) {
  const candidates = [show, ...shows.filter(s => s.id !== show.id && norm(s.title) === norm(show.title))];
  for (const candidate of candidates) {
    const archivePath = path.join(archiveDir, `${candidate.id}.html`);
    if (!fs.existsSync(archivePath) || Date.now() - fs.statSync(archivePath).mtimeMs >= 14 * 86400000) continue;
    const html = fs.readFileSync(archivePath, 'utf8');
    const cachedUrl = canonicalUrlFromHtml(html) || (html.match(/<!--\s*Source:\s*(\S+)\s*-->/i) || [])[1];
    if (sameRoundupUrl(cachedUrl, url)) return { show: candidate, archivePath, html };
  }
  return null;
}

module.exports = { showRunNearYear, matchLboRoundup, matchBySlug, postSlugOf, norm, canonicalizeLboTitle, resolveLboRoundupProduction, readLboRoundupArchive };
