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
const { foldDiacritics } = require('./title-match');
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

// UK touring-house places (names that are also North American tour cities, such as
// Birmingham AL, Manchester NH, Dublin OH, are left out: a UK outlet is caught by co.uk).
//  A North American tour's reviews name US houses; a
// slug (or outlet host) naming one of these reviews the UK tour of the same title.
const UK_TOUR_PLACES = ['newcastle', 'wimbledon', 'edinburgh', 'liverpool',
  'nottingham', 'southampton', 'sunderland', 'cardiff', 'belfast', 'bradford',
  'milton-keynes', 'milton keynes', 'blackpool', 'canterbury', 'everyman', 'cheltenham', 'wolverhampton'];
// Ambiguous names count only inside an outlet's HOST (ilovemanchester.com), never a slug.
const UK_HOST_ONLY_PLACES = ['manchester', 'birmingham', 'bristol', 'glasgow', 'leeds', 'sheffield', 'aberdeen', 'dublin'];
function ukTourLegUrl(url, show) {
  if (!show || show.category !== 'tour' && show.market !== 'tour') return false;
  if (!/north american|us tour|national tour|american tour/i.test(`${show.venue || ''}`)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  let pathDecoded;
  try { pathDecoded = decodeURIComponent(u.pathname); } catch { pathDecoded = u.pathname; }
  const hay = foldDiacritics(`${u.hostname} ${pathDecoded}`).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const hostFlat = u.hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
  return UK_TOUR_PLACES.some((p) => new RegExp(`(^| )${p.replace(/-/g, ' ')}( |$)`).test(hay)
    || (p.length >= 7 && hostFlat.includes(p.replace(/[- ]/g, ''))))
    || UK_HOST_ONLY_PLACES.some((p) => hostFlat.includes(p))
    || /(^|\.)co\.uk$/i.test(u.hostname);
}

// Words that may sit directly before the show's title token in a review slug
// without extending the title ("review-girls-...", "londons-girls").
const TITLE_EXTENDING_PREV = new Set(['the', 'a', 'an', 'to', 'my', 'your', 'our', 'their', 'school', 'mean']);
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
  const own = new Set(foldDiacritics(String(show.title)).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  // Words within ONE path segment only: a folder before the slug ("/en/", "/reviews/")
  // is not part of the title.
  for (const seg of path.split('/').filter(Boolean)) {
    const words = seg.replace(/\.[a-z0-9]{2,5}$/, '').split(/[^a-z0-9]+/).filter(Boolean);
    const idx = words.indexOf(tokens[0]);
    if (idx <= 0) continue;
    const prev = words[idx - 1];
    if (own.has(prev) || TITLE_SAFE_PREV.has(prev) || /^\d+$/.test(prev)) continue;
    // Only a leading article/possessive/known qualifier extends the title ("the-girls",
    // "to-my-girls", "school-girls"). Any other preceding word is a critic name, an
    // adjective or a possessive ("denzel-...-othello", "a-thrilling-hamlet",
    // "disneys-aladdin"): a real review of the one-word show.
    if (!TITLE_EXTENDING_PREV.has(prev)) continue;
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
  // A file we hold that a PERSON excluded and the recovery pass cannot heal:
  // decided, not owed. An automated exclusion is deliberately NOT dropped (a real
  // preview-period review a detector wrongly flagged must reach a person; see
  // flagged-miss-basis.js ruleConfirmedBasis (d)). Requires the audit's own
  // `exclusion` stamp, so a bare {url, host} row stays a gap.
  if (m.exclusion === 'humanExcluded' && m.recoverable !== true) {
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
async function vetTimeoutListingCandidates(missing, show, deps, budget) {
  const kept = [];
  const nonReview = [];
  for (const m of (missing || [])) {
    // Out of run budget: stop fetching; the rest stay candidates (fail open).
    if (!m || !isTimeoutListingShape(m.url) || (budget && budget.exceeded())) { kept.push(m); continue; }
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

// In priority order: the article's own meta tag first, then the first JSON-LD
// datePublished (a later one may belong to a related-article node).
const PAGE_DATE_RES = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /"datePublished"\s*:\s*"([^"]+)"/i,
];
/**
 * The article's machine-readable publish date on a page, or null.
 * @param {string} html
 * @returns {number|null} epoch ms
 */
function pagePublishMs(html) {
  for (const re of PAGE_DATE_RES) {
    const m = String(html || '').match(re);
    const t = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return null;
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
async function vetTourCandidatesByPageDate(missing, show, deps, budget) {
  const start = Date.parse((show && (show.previewsStartDate || show.openingDate)) || '');
  if (!show || !Number.isFinite(start)) return { missing: missing || [], nonReview: [] };
  const isTour = show.category === 'tour';
  const kept = [];
  const nonReview = [];
  let fetched = 0;
  for (const m of (missing || [])) {
    if (!m || m.serpCensus !== true || m.priorRun || fetched >= PAGE_DATE_VET_CAP || (budget && budget.exceeded()) || !(isTour || FESTIVAL_SLUG.test(m.url))) { kept.push(m); continue; }
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
