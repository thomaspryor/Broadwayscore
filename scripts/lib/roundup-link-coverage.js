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

/** YYYY-MM-DD (or YYYY-MM) a review url's path declares, else null. */
function urlDate(url) {
  const u = String(url || '');
  const pad = (n) => String(n).padStart(2, '0');
  let m = u.match(/[/-](20\d{2})[/-](0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])(?:[/?#.-]|$)/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = u.match(/-(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[/?#]|$)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = u.match(/\/(20\d{2})\/(0?[1-9]|1[0-2])\//);
  if (m) return `${m[1]}-${pad(m[2])}-15`;
  // Year-only path segment (variety.com/2022/legit/...): mid-year is enough to
  // tell a 2022 review from a 2026 run.
  m = u.match(/^https?:\/\/[^/]+\/(?:[a-z-]+\/)?(20\d{2})\/(?!\d)/i);
  return m ? `${m[1]}-07-01` : null;
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

module.exports = { extractReviewLinks, classifyLinks, isPlausibleForShow, urlDate, normUrl, siteOf };
