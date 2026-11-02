'use strict';
/**
 * Review-gap census noise (BRO-6804).
 *
 * data/audit/show-review-gap.json reported featured shows as "incomplete" because
 * the `missing` list held things that are not a review of that production, which
 * buried the one real miss on the Bodyguard tour (2026-11-02). Three sources:
 *
 *   1. Rows the audit ALREADY classified (confirmedNonReview, copyOfLiveReview,
 *      liveInReviews, or any collected-and-excluded flaggedMiss) but that the
 *      census adapter (gap-audit-merge.censusVerdictFor) counted anyway. The
 *      pre-send gate (currentRunUncollected) has always treated flaggedMisses as
 *      "collected-but-excluded"; the census disagreed with it.
 *   2. A syndication portal (yahoo/aol/msn/headtopics) hit that only the SERP
 *      census found. The portal is never the outlet, and no outlet row of that
 *      name can ever cover it, so it held "incomplete" forever.
 *   3. A Time Out listing blurb served at the review URL shape. The URL cannot
 *      tell it from a real review (407 real ones live at the same shape,
 *      BRO-5222); the page can (lib/timeout-capsule.js classifyTimeoutListingBlurb).
 *
 * Every drop is RECORDED (result.nonReviewCandidates / verdict.excluded), never
 * silent, so a filter that hides a real miss is visible in the audit file.
 */

const { isSyndicationHost } = require('./syndication-canonical');
const { classifyTimeoutListingBlurb } = require('./timeout-capsule');
const { isUrlMonthBeforeRun } = require('./gap-ingest-policy');

const TIMEOUT_LISTING_PATH = /^\/[a-z0-9-]+\/(theat(?:er|re))\/[^/]+\/?$/i;

function hostOfUrl(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * A Time Out theatre page at the listing URL shape, which MAY be a blurb.
 * A slug already saying "review" is a review page, not a listing.
 * @param {string} url
 * @returns {boolean}
 */
function isTimeoutListingShape(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'timeout.com') return false;
  if (!TIMEOUT_LISTING_PATH.test(u.pathname)) return false;
  return !/review/i.test(u.pathname);
}

// News-feed portals that republish third-party reviews under their own host
// (one story, one copy per country subdomain). Not in syndication-canonical's
// list because that list drives canonical dedup, not the census.
const PORTAL_HOST = /(^|\.)(headtopics\.com|newsbreak\.com|flipboard\.com|dailyhunt\.in|smartnews\.com)$/i;
function isPortalHost(url) { return PORTAL_HOST.test(hostOfUrl(url)); }

// UK touring-house places. A North American tour's reviews name US houses; a
// slug (or outlet host) naming one of these reviews the UK tour of the same title.
const UK_TOUR_PLACES = ['manchester', 'newcastle', 'wimbledon', 'birmingham', 'glasgow', 'edinburgh', 'leeds', 'liverpool',
  'nottingham', 'bristol', 'southampton', 'sunderland', 'norwich', 'plymouth', 'cardiff', 'belfast', 'sheffield', 'bradford',
  'aberdeen', 'dublin', 'milton-keynes', 'milton keynes', 'blackpool', 'canterbury', 'everyman', 'cheltenham', 'wolverhampton'];
function ukTourLegUrl(url, show) {
  if (!show || show.category !== 'tour' && show.market !== 'tour') return false;
  if (!/north american|us tour|national tour|american tour/i.test(`${show.venue || ''}`)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const hay = `${u.hostname} ${decodeURIComponent(u.pathname)}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const hostFlat = u.hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
  return UK_TOUR_PLACES.some((p) => new RegExp(`(^| )${p.replace(/-/g, ' ')}( |$)`).test(hay)
    || (p.length >= 7 && hostFlat.includes(p.replace(/[- ]/g, ''))))
    || /(^|\.)co\.uk$/i.test(u.hostname);
}

// Words that may sit directly before the show's title token in a review slug
// without extending the title ("review-girls-...", "londons-girls").
const TITLE_SAFE_PREV = new Set([
  'review', 'reviews', 'reviewed', 'of', 'new', 'musical', 'play', 'off', 'broadway', 'theatre', 'theater',
  'london', 'west', 'end', 'nyc', 'york', 'at', 'in', 'for', 'by', 'from', 'with', 'and', 'tour', 'live',
]);

/**
 * True when the URL slug reads as a LONGER title that contains the show's one
 * significant word: show "Girls" vs "the-girls-review" (The Girls), "school-girls"
 * (School Girls), "to-my-girls" (To My Girls). Applies only to a one-token title,
 * where the generic-title disambiguator has nothing to work with on a new show
 * (no cast or creatives yet), and only when the word before the token is not a
 * word of the show's own title and not a neutral review/market word.
 * @param {string} url
 * @param {{title?:string}} show
 * @param {(title:string)=>string[]} tokensOf  titleTokens (injected: audit owns its stopword list)
 * @returns {boolean}
 */
function titleExtendedInUrl(url, show, tokensOf) {
  if (!url || !show || !show.title || typeof tokensOf !== 'function') return false;
  const tokens = tokensOf(show.title);
  if (tokens.length !== 1) return false;
  let path;
  try { path = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return false; }
  const own = new Set(String(show.title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  // Words within ONE path segment only: a folder before the slug ("/en/", "/reviews/")
  // is not part of the title.
  for (const seg of path.split('/').filter(Boolean)) {
    const words = seg.replace(/\.[a-z0-9]{2,5}$/, '').split(/[^a-z0-9]+/).filter(Boolean);
    const idx = words.indexOf(tokens[0]);
    if (idx <= 0) continue;
    const prev = words[idx - 1];
    if (own.has(prev) || TITLE_SAFE_PREV.has(prev) || /^\d+$/.test(prev)) continue;
    return true;
  }
  return false;
}

/**
 * Why a not-yet-collected URL is not an owed review, decidable from the URL and
 * how it was found alone; null when it stays a candidate. Only SERP-census-only
 * rows are judged here: an aggregator vouched for the others.
 * @param {{url?:string, serpCensus?:boolean}} m
 * @param {{show?:object, tokensOf?:Function, serpCensusOnly?:boolean}} [ctx]
 * @returns {string|null}
 */
function missingNoiseReason(m, ctx = {}) {
  if (!m || !m.url) return null;
  const censusOnly = ctx.serpCensusOnly === true || m.serpCensus === true;
  if (!censusOnly) return null;
  if (isSyndicationHost(m.url) || isPortalHost(m.url)) return 'syndication-portal';
  if (ctx.show && ukTourLegUrl(m.url, ctx.show)) return 'uk-tour-leg';
  if (ctx.show && isUrlMonthBeforeRun(m.url, ctx.show)) return 'url-date-before-run';
  if (ctx.show && titleExtendedInUrl(m.url, ctx.show, ctx.tokensOf)) return 'longer-title-collision';
  return null;
}

/**
 * Why a census row (a `missing` or `flaggedMisses` entry of one audit result) is
 * not an owed review, or null when it stays in the census. Pure.
 * @param {object} m the audit row
 * @param {'missing'|'flagged'} kind
 * @param {{show?:object, tokensOf?:Function}} [ctx]
 * @returns {string|null}
 */
function censusExclusionReason(m, kind, ctx = {}) {
  if (!m) return null;
  if (typeof m.nonReviewVerdict === 'string' && m.nonReviewVerdict) return m.nonReviewVerdict;
  if (kind === 'missing') return missingNoiseReason(m, ctx);
  if (kind !== 'flagged') return null;
  if (m.confirmedNonReview === true) return 'confirmed-non-review';
  if (m.copyOfLiveReview === true) return 'copy-of-live-review';
  if (m.liveInReviews === true) return 'live-in-reviews';
  // A file we hold, that a detector or a person excluded, that the recovery pass
  // cannot heal (empty body / stale slug): collected-and-excluded, not owed.
  // Requires the audit's own `exclusion` stamp, so a bare {url, host} row stays a gap.
  if ((m.exclusion === 'automatedExcluded' || m.exclusion === 'humanExcluded') && m.recoverable !== true) {
    return 'collected-and-excluded';
  }
  return null;
}

/**
 * Page-level vetting of Time Out listing-shaped candidates. Fetches each one and
 * moves a pre-opening listing blurb out of `missing`. A fetch failure or an
 * inconclusive page leaves the URL in `missing` (fail open to alerting).
 * @param {Array<{url:string}>} missing
 * @param {{openingDate?:string}} show
 * @param {{fetchPage:(url:string)=>Promise<{content?:string}|null>}} deps
 * @returns {Promise<{missing:Array, nonReview:Array}>}
 */
async function vetTimeoutListingCandidates(missing, show, deps) {
  const kept = [];
  const nonReview = [];
  for (const m of (missing || [])) {
    if (!m || !isTimeoutListingShape(m.url)) { kept.push(m); continue; }
    let verdict = { verdict: 'unknown' };
    try {
      const page = await deps.fetchPage(m.url);
      verdict = classifyTimeoutListingBlurb({ html: page && page.content, openingDate: show && show.openingDate });
    } catch { /* fail open */ }
    if (verdict.verdict === 'listing_blurb') {
      nonReview.push({ ...m, nonReviewVerdict: 'timeout-listing-blurb', nonReviewDetail: verdict.reason });
    } else {
      kept.push(m);
    }
  }
  return { missing: kept, nonReview };
}

const PAGE_DATE_RES = [
  /"datePublished"\s*:\s*"([^"]+)"/i,
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
];
/**
 * Earliest machine-readable publish date on a page, or null.
 * @param {string} html
 * @returns {number|null} epoch ms
 */
function pagePublishMs(html) {
  const found = [];
  for (const re of PAGE_DATE_RES) {
    const m = String(html || '').match(re);
    const t = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(t)) found.push(t);
  }
  return found.length ? Math.min(...found) : null;
}

// A festival-named slug (Edinburgh Fringe) on any show: the audit's own Fringe URL
// rule is New-York-only, so a West End show's festival write-ups are judged by page date.
const FESTIVAL_SLUG = /(edinburgh|edfringe|fringe)/i;
const PAGE_DATE_GRACE_MS = 30 * 24 * 3600 * 1000;
const PAGE_DATE_VET_CAP = 6;

/**
 * Touring productions run parallel legs under one title (a UK tour beside the
 * North American one), and a leg's review often carries no place or date in its
 * URL. For a tour's SERP-census-only candidates, read the page and drop one
 * published more than 30 days before the run began: it reviews an earlier leg.
 * Capped per show so a noisy census cannot burn scrape credits; a failed or
 * undated page stays in `missing`.
 * @param {Array} missing
 * @param {{category?:string, previewsStartDate?:string, openingDate?:string, priorRuns?:Array}} show
 * @param {{fetchPage:Function}} deps
 * @returns {Promise<{missing:Array, nonReview:Array}>}
 */
async function vetTourCandidatesByPageDate(missing, show, deps) {
  const start = Date.parse((show && (show.previewsStartDate || show.openingDate)) || '');
  if (!show || !Number.isFinite(start)) return { missing: missing || [], nonReview: [] };
  const isTour = show.category === 'tour';
  const kept = [];
  const nonReview = [];
  let fetched = 0;
  for (const m of (missing || [])) {
    if (!m || m.serpCensus !== true || m.priorRun || fetched >= PAGE_DATE_VET_CAP || !(isTour || FESTIVAL_SLUG.test(m.url))) { kept.push(m); continue; }
    fetched++;
    let ms = null;
    try {
      const page = await deps.fetchPage(m.url);
      ms = pagePublishMs(page && page.content);
    } catch { /* fail open */ }
    if (ms !== null && ms < start - PAGE_DATE_GRACE_MS) {
      nonReview.push({ ...m, nonReviewVerdict: 'page-date-before-run', nonReviewDetail: new Date(ms).toISOString().slice(0, 10) });
    } else {
      kept.push(m);
    }
  }
  return { missing: kept, nonReview };
}

module.exports = {
  vetTourCandidatesByPageDate,
  pagePublishMs,
  isTimeoutListingShape,
  missingNoiseReason,
  titleExtendedInUrl,
  ukTourLegUrl,
  isPortalHost,
  censusExclusionReason,
  vetTimeoutListingCandidates,
  hostOfUrl,
};
