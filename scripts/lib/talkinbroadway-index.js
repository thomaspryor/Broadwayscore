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

const { isForumThreadUrl } = require('./talkinbroadway-forum-link');

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

/** "<title> - 9/9/26" -> "2026-09-09"; null when the text carries no complete date. */
function dateFromLinkText(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Review links from an index page's anchors.
 * @param {{href:string,text:string}[]} anchors
 * @returns {{url:string,text:string,date:string|null}[]} one row per distinct (url, text, date), nav links dropped
 */
function extractReviewLinks(anchors) {
  const seen = new Set();
  const out = [];
  for (const a of anchors || []) {
    if (!a || !isReviewHref(a.href)) continue;
    const url = normalizeTbUrl(a.href);
    const text = titleFromLinkText(a.text);
    const date = dateFromLinkText(a.text);
    const key = `${url}|${text}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, text, date });
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
function matchShowByTitle(title, shows, { now = new Date(), windowDays = 400, aheadDays = 3 } = {}) {
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

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** First "Theatre Review by {Critic} - {Month D, YYYY}" date on a page, as YYYY-MM-DD; null if none. */
function bylineDate(html) {
  const m = String(html || '').replace(/<[^>]*>/g, ' ')
    .match(/Theatre Review by[^\n]{1,80}?-\s*([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** Resolve an anchor href against the page it was read from ("Bug.html" on /page/world/past.html). */
function resolveAgainst(pageUrl, href) {
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * Does this stored file mean the show already has a Talkin' Broadway review in the corpus? Yes for
 * any file that points at a real review page, whatever its verdict: a file flagged wrongShow or
 * wrongProduction (tier 'invalid') is a repair job for a person, and re-queueing it every day would
 * spend the 12-page budget on pages the ingest cannot improve. Not held: an empty stub, or a
 * forum-thread husk whose real review page still has to be found.
 */
function holdsReview(file) {
  if (!file || !file.url || isForumThreadUrl(file.url)) return false;
  return file.contentTier !== 'stub';
}

/** Key for "we already hold a Talkin' Broadway review of this show". TB posts one review per production. */
function heldKey(showId) {
  return String(showId);
}

// A review is for this production only if it was posted around its press night. A same-title
// earlier run (Ectoplasm 2022, The Imaginary Invalid 2025) or a January review of a show that
// returns in October falls outside this window and is left alone.
const REVIEW_DATE_WINDOW = Object.freeze({ daysBeforeOpening: 10, daysAfterOpening: 60 });

function reviewDateFitsShow(reviewDate, show) {
  if (!reviewDate || !show || !show.openingDate) return false;
  const r = Date.parse(`${reviewDate}T12:00:00Z`);
  const o = Date.parse(`${show.openingDate}T12:00:00Z`);
  if (!Number.isFinite(r) || !Number.isFinite(o)) return false;
  const days = (r - o) / 86400000;
  return days >= -REVIEW_DATE_WINDOW.daysBeforeOpening && days <= REVIEW_DATE_WINDOW.daysAfterOpening;
}

const SECTION_CATEGORY = Object.freeze({ world: 'broadway', ob: 'off-broadway' });
const MAX_UNDATED_RANK = 80;

/**
 * Decide what to fetch. A link needs a title that matches one tracked New York show, a review
 * date near that show's opening, and no Talkin' Broadway review of the show already held.
 * @param {{url:string,title:string,date:string|null}[]} entries  title = link text or page title
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
    // Broadway list links carry no date ("Bug.html | Bug"); those are checked against the review
    // page's own byline date after the fetch (verifyPageDate), never taken on trust.
    // A Broadway-list link belongs to a Broadway show, an Off Broadway-list link to an Off Broadway show:
    // the same title is often both (Macbeth, The Cherry Orchard, La Boheme).
    const wantCategory = SECTION_CATEGORY[e.section];
    if (wantCategory && show.category !== wantCategory) {
      skipped.push({ url: e.url, title: e.title, why: 'wrong-section' });
      continue;
    }
    // Lists run newest first. An undated link far down is an old review, not worth a page load.
    if (!e.date && Number.isFinite(e.rank) && e.rank >= (opts.maxUndatedRank ?? MAX_UNDATED_RANK)) {
      skipped.push({ url: e.url, title: e.title, why: 'undated-not-recent' });
      continue;
    }
    if (e.date && !reviewDateFitsShow(e.date, show)) {
      skipped.push({ url: e.url, title: e.title, why: 'date-outside-run' });
      continue;
    }
    const key = heldKey(show.id);
    if (held.has(key)) {
      skipped.push({ url: e.url, title: e.title, why: 'held' });
      continue;
    }
    if (queued.has(key)) {
      skipped.push({ url: e.url, title: e.title, why: 'second-review-same-show' });
      continue;
    }
    queued.add(key);
    toFetch.push({ showId: show.id, url: normalizeTbUrl(e.url), title: e.title, openingDate: show.openingDate, verifyPageDate: !e.date });
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
  dateFromLinkText,
  reviewDateFitsShow,
  bylineDate,
  resolveAgainst,
  titleFromPageTitle,
  matchShowByTitle,
  bylineSections,
  pickCriticForShow,
  pageTitleMatchesShow,
  heldKey,
  holdsReview,
  planCollection,
  SECTION_CATEGORY,
  MAX_UNDATED_RANK,
};
