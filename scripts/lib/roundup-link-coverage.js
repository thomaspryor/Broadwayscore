/**
 * Roundup-link coverage (BRO-5557). An archived BroadwayWorld roundup or
 * Playbill "Verdict" page names the reviews the aggregator found. This module
 * answers, for each named review link, whether we hold it:
 *
 *   covered   a reviews.json row carries that url (or, failing an exact url,
 *             the show has as many scored rows on that site as the page has
 *             links to it, which handles an outlet whose url we normalised)
 *   excluded  we ingested a review-text file for it but it is not in
 *             reviews.json (flagged, rejected, unscored); `reason` says why
 *   missing   no review-text file or reviews.json row for that site at all
 *
 * Pure functions only (CLAUDE.md §15); scripts/audit-roundup-link-coverage.js
 * does the file I/O.
 *
 * Known limits (advisory audit, read the list, do not trust the absence of a row):
 *   - BroadwayWorld, Playbill and the social/ticketing hosts in NOT_AN_OUTLET are
 *     not treated as outlets, so a review that only BroadwayWorld hosts is never flagged;
 *   - a link whose slug shares no word with the show title (an opaque id) is skipped
 *     by isPlausibleForShow;
 *   - 'covered' by site count can hide a second critic at an outlet we hold one row for.
 */
'use strict';

const { hostOf } = require('./non-review-url-patterns');

const NOT_AN_OUTLET = /(^|\.)(broadwayworld|playbill|playbillder|playbillstore|playbilltravel|wisdomdigital|show-score|todaytix|todaytixgroup|facebook|twitter|x|instagram|youtube|threads|tiktok|linkedin|pinterest|google|apple|ticketmaster|telecharge)\.[a-z.]+$/i;

function normUrl(u) {
  return String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

// One registrable-host rule for the whole repo (non-review-url-patterns.js, backed
// by host-suffix-lists.js): a private copy here already got abc.net.au wrong.
function siteOf(u) {
  return hostOf(u) || '';
}

function decode(s) {
  return String(s || '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#0*39;|&#x27;|&apos;/g, "'").replace(/<[^>]+>/g, '').trim();
}

/**
 * Review links on an archived roundup page.
 * BWW roundup: `<a href="URL">Outlet:</a>`; Playbill Verdict: `<a href="URL" target="_blank">Outlet (Critic)</a>`
 * (NYSR splits two critics across two anchors: "(Frank Scheck" / "Michael Sommers)").
 * @returns {Array<{url:string, label:string, site:string}>}
 */
function extractReviewLinks(html, kind) {
  const out = [];
  const seen = new Set();
  const re = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{1,160}?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const url = decode(m[1]);
    const label = decode(m[2]);
    const site = siteOf(url);
    if (!site || NOT_AN_OUTLET.test(`.${site}`)) continue;
    const isReviewLabel = kind === 'playbill-verdict'
      ? /[()]/.test(label)
      : /:\s*$/.test(label);
    if (!isReviewLabel) continue;
    const key = normUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, label, site });
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'musical', 'play', 'review', 'new', 'live']);
function titleTokens(title) {
  return String(title || '').toLowerCase().replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Existing URL-date evidence with its precision retained for run checks. */
function urlDateEvidence(url) {
  const u = String(url || '');
  const pad = (n) => String(n).padStart(2, '0');
  let m = u.match(/[/-](20\d{2})[/-](0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])(?:[/?#.-]|$)/);
  if (m) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, precision: 'day' };
  m = u.match(/-(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[/?#]|$)/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day' };
  m = u.match(/\/(20\d{2})\/(0?[1-9]|1[0-2])\//);
  if (m) return { date: `${m[1]}-${pad(m[2])}-15`, precision: 'month' };
  // Year-only path segment (variety.com/2022/legit/...): mid-year is enough to
  // tell a 2022 review from a 2026 run.
  m = u.match(/^https?:\/\/[^/]+\/(?:[a-z-]+\/)?(20\d{2})\/(?!\d)/i);
  return m ? { date: `${m[1]}-07-01`, precision: 'year' } : null;
}

function urlDate(url) {
  return urlDateEvidence(url)?.date || null;
}

/**
 * Reject a title-matched roundup belonging to another run BEFORE caching or
 * ingesting it. Only dated review anchors vote; undated links cannot rescue
 * a page. A tie is inconclusive; undated paths fall back to page metadata.
 * URL dates are contradiction evidence only, never stored review metadata.
 * Year/month-only paths represent intervals, not invented publication days.
 */
function checkRoundupRunWindow(html, show, kind) {
  // Touring roundups accumulate reviews from successive stops, rather than
  // covering one opening. Their later dates do not identify a different run.
  if (show && show.category === 'tour') return { ok: true };
  if (kind === 'bww-roundups' && show && show.venue) {
    const title = decode((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const namedVenue = title.match(/\bopens?\s+at\s+(.+?)(?:\s*\||$)/i)?.[1];
    if (namedVenue) {
      const { isLondonMarket, normalizeVenueName, OFF_BROADWAY_VENUES } = require('./venue-classification');
      const { venueTokens } = require('./aggregator-page-production');
      const named = normalizeVenueName(namedVenue);
      // Absence of a venue-token match proves nothing: headlines use company
      // names and abbreviations (RSC, MTC, Roundabout). Only reject a London
      // match when the headline explicitly names a registered NYC house.
      const knownNyc = named.length >= 5 && [...OFF_BROADWAY_VENUES].some((venue) =>
        venue === named || venue.startsWith(`${named} `) || venue.endsWith(` ${named}`));
      const expected = venueTokens(show.venue);
      if (isLondonMarket(show.category) && knownNyc && expected.length
        && !venueTokens(namedVenue).some((token) => expected.includes(token))) {
        return { ok: false, reason: 'roundup-venue-market-mismatch', pageVenue: namedVenue };
      }
    }
  }
  const opening = Date.parse(show && (show.openingDate || show.previewsStartDate));
  if (!Number.isFinite(opening)) return { ok: true };
  const start = opening - 60 * 86400000;
  const end = opening + 120 * 86400000;
  const dated = extractReviewLinks(html, kind).map((l) => urlDateEvidence(l.url)).filter(Boolean);
  const outside = dated.filter(({ date, precision }) => {
    const [year, month] = date.split('-').map(Number);
    const first = precision === 'year' ? Date.UTC(year, 0, 1)
      : precision === 'month' ? Date.UTC(year, month - 1, 1) : Date.parse(date);
    const last = precision === 'year' ? Date.UTC(year + 1, 0, 1) - 1
      : precision === 'month' ? Date.UTC(year, month, 1) - 1 : first;
    return last < start || first > end;
  }).length;
  if (outside > dated.length / 2) {
    return { ok: false, reason: 'roundup-review-dates-outside-run', datedLinks: dated.length, outsideLinks: outside };
  }
  // Some old Verdict pages have no dated outlet paths at all. Prefer their
  // explicit publication metadata to guessing from a title or article URL.
  if (!dated.length) {
    const { extractPageDateFromHtml } = require('./aggregator-page-production');
    const pageDate = extractPageDateFromHtml(html);
    const published = Date.parse(pageDate);
    if (Number.isFinite(published) && (published < start || published > end)) {
      return { ok: false, reason: 'roundup-page-date-outside-run', pageDate };
    }
  }
  return { ok: true };
}

/**
 * An archived roundup page can belong to another production of the same title
 * (a 2019 Broadway review filed under a 2026 West End revival), and an outlet
 * link can be about a different show entirely. Such links are not gaps. A link
 * is plausible when its dated path falls within the show's run window (opening
 * -60d .. +120d) and its slug shares a title word with the show.
 */
function isPlausibleForShow(link, show) {
  const open = show && (show.openingDate || show.previewsStartDate);
  const d = urlDate(link.url);
  if (d && open) {
    const days = (Date.parse(d) - Date.parse(open)) / 86400000;
    if (!(days >= -60 && days <= 120)) return false;
  }
  const toks = titleTokens(show && show.title);
  if (toks.length) {
    let slug = '';
    try { slug = decodeURIComponent(new URL(link.url).pathname).toLowerCase().replace(/['\u2019]/g, ''); } catch { /* keep empty */ }
    // Whole slug words, not substrings: 'our' must not match 'your'.
    const words = new Set(slug.split(/[^a-z0-9]+/).filter(Boolean));
    if (slug && !toks.some((t) => words.has(t) || words.has(`${t}s`))) return false;
  }
  return true;
}

// The audit and its regression tests use the same page and link policy.
function reviewLinksForShow(html, kind, show) {
  if (!checkRoundupRunWindow(html, show, kind).ok) return [];
  return extractReviewLinks(html, kind).filter((link) => isPlausibleForShow(link, show));
}

/**
 * @param {Array<{url:string,label:string,site:string}>} links
 * @param {Array<{url:string}>} reviewRows reviews.json rows for the show
 * @param {Array<object>} textFiles review-text files for the show (parsed)
 */
function classifyLinks(links, reviewRows, textFiles) {
  const rowUrls = new Set((reviewRows || []).map((r) => normUrl(r.url)));
  const rowsBySite = new Map();
  for (const r of reviewRows || []) rowsBySite.set(siteOf(r.url), (rowsBySite.get(siteOf(r.url)) || 0) + 1);
  const linksBySite = new Map();
  for (const l of links) linksBySite.set(l.site, (linksBySite.get(l.site) || 0) + 1);

  const fileUrls = (f) => [f.url, f.previousUrl, f.playbillVerdictUrl, ...(f.mergedDuplicateUrls || [])].filter(Boolean).map(normUrl);

  return links.map((l) => {
    const n = normUrl(l.url);
    if (rowUrls.has(n)) return { ...l, status: 'covered' };
    if ((rowsBySite.get(l.site) || 0) >= (linksBySite.get(l.site) || 1)) return { ...l, status: 'covered', via: 'site-count' };
    const file = (textFiles || []).find((f) => fileUrls(f).includes(n))
      || ((linksBySite.get(l.site) || 0) === 1
        ? (textFiles || []).find((f) => f.url && siteOf(f.url) === l.site && !f.duplicateOf)
        : null);
    if (file) {
      const reason = file.rejectionReason || file.incompleteReason || file.contentTierReason
        || (file.wrongShow ? 'wrongShow' : file.wrongProduction ? 'wrongProduction' : file.isRoundupArticle ? 'roundup-flag' : file.assignedScore == null ? 'unscored' : 'unknown');
      return { ...l, status: 'excluded', reason: `${file.contentTier || '?'}: ${reason}`, file: file.__file };
    }
    return { ...l, status: 'missing' };
  });
}

module.exports = { extractReviewLinks, classifyLinks, isPlausibleForShow, checkRoundupRunWindow, reviewLinksForShow, urlDate, normUrl, siteOf };
