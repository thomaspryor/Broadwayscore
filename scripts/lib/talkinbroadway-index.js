/**
 * talkinbroadway-index.js — pure helpers for the daily Talkin' Broadway index
 * collector (scripts/collect-talkinbroadway-index.js).
 *
 * TB's own index pages list every review it publishes, so reading them tells us
 * which reviews exist without waiting for the forum announcement or a SERP hit.
 * These helpers turn an index page's links into a to-fetch list: which link is a
 * review, which tracked show it belongs to, and whether we already hold it.
 * No I/O here, so the decisions are unit-testable (CLAUDE.md §15).
 */
'use strict';

const BASE = 'https://www.talkinbroadway.com';

// Review pages live under these sections. Region sections (/page/regional/) are
// left out: the collector tracks New York shows.
const REVIEW_PATH_RE = /^\/page\/(ob|world|bwaybway|westend)\/[^/?#]+\.html$/i;
// Navigation and listing pages share the review URL shape but are not reviews.
const NON_REVIEW_PAGE_RE = /\/(index|past|archive)\.html$/i;

/** Absolute, www-normalised URL with no hash or query; null if not a TB URL. */
function normalizeTbUrl(href) {
  if (!href || typeof href !== 'string') return null;
  let u;
  try {
    u = new URL(href, BASE);
  } catch {
    return null;
  }
  if (!/(^|\.)talkinbroadway\.com$/i.test(u.hostname)) return null;
  return `${BASE}${u.pathname}`;
}

/** Is this href a single review page (not nav, a listing, or an off-site share link)? */
function isReviewHref(href) {
  const url = normalizeTbUrl(href);
  if (!url) return false;
  const p = new URL(url).pathname;
  return REVIEW_PATH_RE.test(p) && !NON_REVIEW_PAGE_RE.test(p);
}

/** Lowercase, no punctuation or leading article, single spaces: "The Ask" and "Ask" compare equal. */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/**
 * Index link text is "<Show title> - M/D/YY" (sometimes cut to "<Show title> -"). Return the title only.
 */
function titleFromLinkText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})?\s*$/, '')
    .trim();
}

/**
 * Review links from an index page's anchors.
 * @param {{href:string,text:string}[]} anchors
 * @returns {{url:string,text:string}[]} one row per distinct (url, text), nav links dropped
 */
function extractReviewLinks(anchors) {
  const seen = new Set();
  const out = [];
  for (const a of anchors || []) {
    if (!a || !isReviewHref(a.href)) continue;
    const url = normalizeTbUrl(a.href);
    const text = titleFromLinkText(a.text);
    const key = `${url}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, text });
  }
  return out;
}

/** Title in a review page's <title>: `Talkin' Broadway Off-Broadway - "Good Time Charlie" - 10/9/26`. */
function titleFromPageTitle(pageTitle) {
  const m = String(pageTitle || '').match(/"([^"]{2,120})"/);
  return m ? m[1].trim() : null;
}

/**
 * Which tracked show does a title belong to? Only shows that opened inside
 * [now - windowDays, now + aheadDays] are considered, so a reused title (a
 * revival, a regional run of the same play) cannot attach to an old production.
 * @returns {{show: object|null, reason: 'match'|'none'|'ambiguous'}}
 */
function matchShowByTitle(title, shows, { now = new Date(), windowDays = 75, aheadDays = 3 } = {}) {
  const want = normalizeTitle(title);
  if (!want) return { show: null, reason: 'none' };
  const lo = now.getTime() - windowDays * 86400000;
  const hi = now.getTime() + aheadDays * 86400000;
  const hits = (shows || []).filter((s) => {
    // New York only: TB's index links are NYC reviews, and a same-title West End or regional run must not attach.
    if (!s || !s.openingDate || s.market !== 'broadway') return false;
    const t = Date.parse(s.openingDate);
    if (!Number.isFinite(t) || t < lo || t > hi) return false;
    return normalizeTitle(s.title) === want;
  });
  if (hits.length === 1) return { show: hits[0], reason: 'match' };
  return { show: null, reason: hits.length ? 'ambiguous' : 'none' };
}

/** Every "Theatre Review by {Critic} - {Date}" byline in a page, with the plain text just before it. */
function bylineSections(html) {
  const re = /Theatre Review by\s*(?:<a[^>]*>)?\s*([^<\n]+?)\s*(?:<\/a>)?\s+-\s+[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}/gi;
  const out = [];
  let prevEnd = 0;
  for (const m of String(html || '').matchAll(re)) {
    // Only the stretch since the previous byline, last 300 characters: the heading that
    // names the show sits right above its own byline, and the review above it is not evidence.
    const before = html.slice(prevEnd, m.index).replace(/<[^>]*>/g, ' ').slice(-300);
    out.push({ critic: m[1].trim(), before });
    prevEnd = m.index + m[0].length;
  }
  return out;
}

/**
 * Which critic wrote the review of THIS show on a page? One byline: that page is
 * the show's (the caller also checks the page title). Several bylines (a combined
 * day page): only the one whose preceding heading names the show; if that is not
 * exactly one, refuse rather than file another show's review under this one.
 * @returns {{critic:string}|{skip:string}}
 */
function pickCriticForShow(html, showTitle) {
  const sections = bylineSections(html);
  if (sections.length === 0) return { skip: 'no-byline' };
  if (sections.length === 1) return { critic: sections[0].critic };
  const want = ` ${normalizeTitle(showTitle)} `;
  const named = sections.filter((x) => ` ${normalizeTitle(x.before)} `.includes(want));
  return named.length === 1 ? { critic: named[0].critic } : { skip: 'multi-review-page' };
}

/** Is a page's <title> about this show? Day and title pages quote the show: `... - "Good Time Charlie" - 10/9/26`. */
function pageTitleMatchesShow(pageTitle, showTitle) {
  const t = titleFromPageTitle(pageTitle);
  return !!t && normalizeTitle(t) === normalizeTitle(showTitle);
}

/** Key for "we hold this review for this show". */
function heldKey(showId, url) {
  return `${showId}|${normalizeTbUrl(url)}`;
}

/**
 * Decide what to fetch. A link needs a title that matches one tracked show and a
 * (show, url) pair not already held.
 * @param {{url:string,title:string}[]} entries  title = link text or page title
 * @param {object[]} shows
 * @param {Set<string>} held  heldKey() values
 * @returns {{toFetch:{showId:string,url:string,title:string}[], skipped:{url:string,title:string,why:string}[]}}
 */
function planCollection(entries, shows, held, opts = {}) {
  const toFetch = [];
  const skipped = [];
  const queued = new Set();
  for (const e of entries || []) {
    const { show, reason } = matchShowByTitle(e.title, shows, opts);
    if (!show) {
      skipped.push({ url: e.url, title: e.title, why: reason === 'ambiguous' ? 'ambiguous-title' : 'no-tracked-show' });
      continue;
    }
    const key = heldKey(show.id, e.url);
    if (held.has(key)) {
      skipped.push({ url: e.url, title: e.title, why: 'held' });
      continue;
    }
    if (queued.has(key)) continue;
    queued.add(key);
    toFetch.push({ showId: show.id, url: normalizeTbUrl(e.url), title: e.title });
  }
  return { toFetch, skipped };
}

module.exports = {
  BASE,
  normalizeTbUrl,
  isReviewHref,
  normalizeTitle,
  extractReviewLinks,
  titleFromLinkText,
  titleFromPageTitle,
  matchShowByTitle,
  bylineSections,
  pickCriticForShow,
  pageTitleMatchesShow,
  heldKey,
  planCollection,
};
