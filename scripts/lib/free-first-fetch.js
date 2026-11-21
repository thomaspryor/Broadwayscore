/**
 * Free-first fetch decisions (BRO-7532). Pure functions; no network.
 *
 * Rule: a free path may only SHORT-CIRCUIT a paid path when it produced a usable
 * answer. Errors, blocks and non-JSON always mean "fall back to the paid path".
 *
 * BRO-7531 follow-up (2026-11-15): a "no match" also fell back to the paid render,
 * so the free search saved nothing on the shows that cost the most. In the hour
 * after BRO-7532 landed the poller still paid 16 renders/hour for Deadline and
 * Hollywood Reporter (17/hour before), 14 of 16 for off-Broadway and
 * off-West-End shows, which those outlets reviewed once in 17 months. A CLEAN
 * no-match (see isCleanFreeNoMatch) now stands for those markets only; Broadway,
 * West End and everything else keep the paid render as the backstop.
 */
const { isSlowTrickleMarket } = require('./serp-second-opinion-policy');

/** WordPress REST search URL (works on deadline.com / hollywoodreporter.com). */
function buildWpSearchUrl(base, title) {
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}/wp-json/wp/v2/search?search=${encodeURIComponent(`${title} review`)}&per_page=20&subtype=post`;
}

/** @returns {{url:string,title:string}[]|null} null when the body is not a JSON array. */
function parseWpSearchResults(body) {
  if (typeof body !== 'string') return null;
  const t = body.trim();
  if (!t.startsWith('[')) return null;
  let arr;
  try { arr = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(p => p && typeof p.url === 'string' && /^https?:\/\//.test(p.url))
    .map(p => ({ url: p.url, id: Number.isInteger(p.id) ? p.id : null, title: String(p.title || '').replace(/<[^>]+>/g, '') }));
}

/** Test a URL against an `href="(...)"` style endpoint pattern, with a fresh non-global RegExp. */
function urlMatchesLinkPattern(url, linkPattern) {
  if (!linkPattern) return true;
  const re = new RegExp(linkPattern.source, linkPattern.flags.replace('g', ''));
  return re.test(`href="${url}"`);
}

const FILM_TV_MARKERS = /(?:^|[\/-])(?:movie|movies|film|films|tv|series|netflix|streaming|documentary|festival|tribeca|sundance|cannes|sxsw|venice|toronto|apple-tv|hbo|disney)(?:$|[\/-])/i;
const STAGE_MARKERS = /(?:^|[\/-])(?:broadway|theat(?:er|re)|musical|off-broadway|west-end|revival|play)(?:$|[\/-])/i;
const OTHER_MARKET_MARKERS = { broadway: /(?:west-end|london|edinburgh)/i, 'west-end': /(?:broadway)/i };

/**
 * Free hits must look like a STAGE review for the right market. Film, TV and
 * festival reviews of a same-titled work, and other-market reviews, would
 * otherwise count as a hit and suppress the paid render (BRO-7532 ship-check).
 */
function looksLikeStageReview(url, market = 'broadway') {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  if (FILM_TV_MARKERS.test(path) || !STAGE_MARKERS.test(path)) return false;
  const other = OTHER_MARKET_MARKERS[market];
  return !(other && other.test(path));
}

/**
 * Is this post from the show's current production? Needs a publish date on or
 * after (openingDate - graceDays). Unknown opening date or unparseable date =>
 * false, so the paid render decides.
 */
function isCurrentProductionPost(postDate, openingDate, graceDays = 45, maxDays = 120) {
  const post = Date.parse(postDate);
  const open = Date.parse(openingDate);
  if (!Number.isFinite(post) || !Number.isFinite(open)) return false;
  return post >= open - graceDays * 86400000 && post <= open + maxDays * 86400000;
}

/** WP single-post URL used to read a candidate's publish date. */
function buildWpPostDateUrl(base, id) {
  return `${String(base || '').replace(/\/+$/, '')}/wp-json/wp/v2/posts/${encodeURIComponent(id)}?_fields=id,date`;
}

/**
 * Decide whether the free WordPress search answered. Every candidate must pass
 * the same filters the paid path applies (linkPattern, urlLooksLike, named
 * non-review exclusions) BEFORE we call it a hit, so a free "hit" made only of
 * box-office posts or film reviews never suppresses the paid render.
 * @returns {{use:boolean, urls:string[], reason:string}}
 */
function decideFreeSearch(posts, { linkPattern, showTitle, urlLooksLike, nonReviewReason, market = 'broadway' } = {}) {
  if (!Array.isArray(posts)) return { use: false, urls: [], reason: 'unusable-response' };
  if (posts.length === 0) return { use: false, urls: [], reason: 'empty' };
  const urls = [];
  const hits = [];
  for (const p of posts) {
    const url = p && p.url;
    if (!url || urls.includes(url)) continue;
    if (!urlMatchesLinkPattern(url, linkPattern)) continue;
    // Real Deadline/THR review slugs say "review"; news about the show (closing dates,
    // box office) must not count as a free hit and suppress the paid render (BRO-7532 live test).
    if (!/(?:^|[\/-])reviews?(?:$|[\/-])/i.test(String(url).replace(/^https?:\/\/[^/]+/, ''))) continue;
    if (urlLooksLike && !urlLooksLike(url, showTitle)) continue;
    if (nonReviewReason && nonReviewReason(url)) continue;
    if (!looksLikeStageReview(url, market)) continue;
    urls.push(url);
    hits.push({ url, id: p.id == null ? null : p.id });
  }
  return urls.length ? { use: true, urls, hits, reason: 'hit' } : { use: false, urls: [], hits: [], reason: 'no-matching-review' };
}

/** Page size of the date-bounded search; an answer this long may be cut off. */
const WP_BOUNDED_PAGE_SIZE = 100;
/** Page size of the plain search (buildWpSearchUrl's per_page). */
const WP_SEARCH_PAGE_SIZE = 20;

/**
 * Date-bounded WordPress search (posts endpoint): every post matching the title
 * that was published inside the show's production window, the same window
 * isCurrentProductionPost uses. A plain search for a common title ("Touch",
 * "The Heart") fills its page with years of film reviews; inside the window the
 * answer is small enough to be complete.
 * @returns {string|null} null when the opening date is unknown or unparseable.
 */
function buildWpBoundedSearchUrl(base, title, openingDate, graceDays = 45, maxDays = 120) {
  const open = Date.parse(openingDate);
  if (!Number.isFinite(open)) return null;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}/wp-json/wp/v2/posts?search=${encodeURIComponent(`${title} review`)}`
    + `&after=${iso(open - graceDays * 86400000)}&before=${iso(open + maxDays * 86400000)}`
    + `&per_page=${WP_BOUNDED_PAGE_SIZE}&_fields=id,link,date`;
}

/** @returns {{url:string,id:number|null}[]|null} null when the body is not a JSON array. */
function parseWpPostsResults(body) {
  if (typeof body !== 'string') return null;
  const t = body.trim();
  if (!t.startsWith('[')) return null;
  let arr;
  try { arr = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(p => p && typeof p.link === 'string' && /^https?:\/\//.test(p.link))
    .map(p => ({ url: p.link, id: Number.isInteger(p.id) ? p.id : null }));
}

/**
 * Is this free answer a CLEAN no-match, one the paid render could not improve on?
 * True only when the search answered with a JSON array, the page was not full
 * (a full page may have cut the review off), and NOTHING in it would pass the
 * paid path's own filter (link pattern, urlLooksLike, named non-review). A post
 * the paid filter would accept but the stricter free filters rejected (no stage
 * marker, old date) is not clean: the paid render decides, as before.
 */
function isCleanFreeNoMatch(posts, { linkPattern, showTitle, urlLooksLike, nonReviewReason, pageSize = WP_SEARCH_PAGE_SIZE, rawCount = null } = {}) {
  if (!Array.isArray(posts)) return false;
  // "Full" is judged on the RAW row count: the parsers drop rows without a link,
  // so a full page of 20 could otherwise count as 19 and pass as complete.
  if (Math.max(posts.length, Number.isInteger(rawCount) ? rawCount : 0) >= pageSize) return false;
  for (const p of posts) {
    const url = p && p.url;
    if (!url) continue;
    if (!urlMatchesLinkPattern(url, linkPattern)) continue;
    if (urlLooksLike && !urlLooksLike(url, showTitle)) continue;
    if (nonReviewReason && nonReviewReason(url)) continue;
    return false;
  }
  return true;
}

/** Rows in a JSON-array body before any filtering; null when it is not a JSON array. */
function wpRawCount(body) {
  if (typeof body !== 'string' || !body.trim().startsWith('[')) return null;
  try { const a = JSON.parse(body); return Array.isArray(a) ? a.length : null; } catch { return null; }
}

/**
 * Canary query for a WordPress endpoint ('search' or 'posts'): a word every
 * theatre trade site has thousands of posts for. An EMPTY free answer is only
 * trusted when this still returns rows, so an endpoint that starts answering
 * `[]` to everything (plugin change, cached empty, JSON rate-limit page) falls
 * back to the paid render instead of silently hiding reviews.
 */
function buildWpCanaryUrl(base, kind = 'search') {
  const b = String(base || '').replace(/\/+$/, '');
  return kind === 'posts'
    ? `${b}/wp-json/wp/v2/posts?search=${encodeURIComponent('Broadway review')}&per_page=1&_fields=id,link,date`
    : `${b}/wp-json/wp/v2/search?search=${encodeURIComponent('Broadway review')}&per_page=1&subtype=post`;
}

/**
 * Audit sample: on this share of clean no-matches the paid render still runs,
 * so a review the free search cannot see is caught within a few poller ticks
 * and logged (FREE-WP-CLEAN-MISS). Default 5%; FREE_WP_CLEAN_AUDIT_RATE=0..1.
 */
function shouldAuditCleanNoMatch(rand = Math.random, env = process.env) {
  const raw = env && env.FREE_WP_CLEAN_AUDIT_RATE;
  const rate = raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Math.min(1, Math.max(0, Number(raw))) : 0.05;
  return rate > 0 && rand() < rate;
}

/**
 * Does the URL carry a /YYYY/MM/ publish month that ended before the show's
 * production window (opening - graceDays)? Used to keep old film reviews of a
 * same-titled work out of the audit's miss log. Undated URL or unknown opening
 * date => false (cannot tell, so it counts).
 */
function urlDatedBeforeProduction(url, openingDate, graceDays = 45) {
  const m = /\/(20\d{2})\/(0[1-9]|1[0-2])\//.exec(String(url || ''));
  const open = Date.parse(openingDate);
  if (!m || !Number.isFinite(open)) return false;
  return Date.UTC(Number(m[1]), Number(m[2]), 1) <= open - graceDays * 86400000;
}

/**
 * May a clean free no-match stand without the paid render for this show?
 * Off-Broadway and off-West-End only (the same markets that dropped the paid
 * SERP second opinion). No show object, or any other market, keeps the render.
 * Kill switch: FREE_WP_NO_MATCH_PAID=1 restores the render after every no-match.
 */
function trustCleanFreeNoMatch(show, env = process.env) {
  if (env && env.FREE_WP_NO_MATCH_PAID === '1') return false;
  return isSlowTrickleMarket(show);
}

/**
 * Date that anchors the free search's production window (hit date gate and the
 * date-bounded re-ask). The opening date when known; otherwise the previews
 * start date. BRO-7532 recheck 2026-11-20: off-market shows still in previews
 * with no opening date (Peter Pan, Santa's First Christmas, Do Not Try This at
 * Home) could never prove a clean no-match on a common title, so they paid
 * about 57 Deadline/THR renders a day. Neither date usable (or previews began
 * more than maxDays ago) => null, and the caller keeps the paid render as before.
 */
function freeSearchAnchorDate(openingDate, show, now = Date.now(), maxDays = 120) {
  if (Number.isFinite(Date.parse(openingDate))) return openingDate;
  const previews = show && show.previewsStartDate;
  const p = Date.parse(previews);
  if (!Number.isFinite(p)) return null;
  // The window ends maxDays after the anchor. A show still in previews past that
  // point could get reviewed outside the window, so it keeps the paid render.
  // A previews date still in the future may be wrong or postponed: keep the paid render.
  if (now < p) return null;
  return now <= p + maxDays * 86400000 ? previews : null;
}

/**
 * DTLI direct-GET outcome for a /shows/<slug>/ page:
 *  'page'      - 200, closed HTML, review blocks present: use it.
 *  'not-found' - DTLI's own "Page not found" document (HTTP 404, closed HTML,
 *                the site's 404 title). The show has no DTLI page yet. The paid
 *                chain fetches this same 404 document and returns it as a
 *                "success" (BRO-7532 recheck: "Extracted 0 critic blocks" after
 *                every Bright Data call for an unopened show, ~400 calls a day
 *                for one show), so answering with it changes nothing for the
 *                caller and the next poll asks again.
 *  'fallback'  - anything else (403, bare 404, challenge, truncated): paid chain.
 */
const DTLI_404_TITLE = /<title>\s*Page not found\s*[-–|]\s*Did They Like It\?\s*<\/title>/i;
function dtliDirectOutcome(status, content) {
  if (typeof content !== 'string' || !/<\/html\s*>/i.test(content)) return 'fallback';
  if (status === 200 && /<div class="(?:poster-)?review-item">/.test(content)) return 'page';
  if (status === 404 && DTLI_404_TITLE.test(content) && !/review-item/.test(content)) return 'not-found';
  return 'fallback';
}

/**
 * theatre.reviews direct-first gate. Accept only a real page: 200, not a
 * challenge, closed document, and a positive content marker for the path
 * (a CleanTalk interstitial can come back 200; the site's own pages mention
 * cleantalk, so only positive markers are reliable). Anything else falls
 * through to the paid chain.
 */
function isTheatreReviewsHost(hostname) {
  return hostname === 'theatre.reviews' || hostname === 'www.theatre.reviews';
}
/**
 * A theatre.reviews round-up carries star glyphs in its tier headers or inline
 * ratings. The site uses BOTH "⭑" (e.g. Beetlejuice) and "★" (e.g. Avenue Q,
 * The 39 Steps, checked live 2026-11-17); scrape-theatre-reviews.js parses
 * both, so every gate that asks "is this a real round-up?" must accept both.
 */
function hasTheatreReviewsStarMarker(content) {
  return typeof content === 'string' && /[⭑★]/.test(content);
}
function theatreReviewsDirectAcceptable(pathname, status, content) {
  if (status !== 200 || typeof content !== 'string' || !/<\/html\s*>/i.test(content)) return false;
  if (/^\/reviews-roundup\//.test(pathname)) return hasTheatreReviewsStarMarker(content);
  return false; // other TR paths: no verified marker, keep the paid route
}

module.exports = {
  buildWpSearchUrl,
  parseWpSearchResults,
  urlMatchesLinkPattern,
  decideFreeSearch,
  looksLikeStageReview,
  isCurrentProductionPost,
  buildWpPostDateUrl,
  buildWpBoundedSearchUrl,
  parseWpPostsResults,
  isCleanFreeNoMatch,
  trustCleanFreeNoMatch,
  freeSearchAnchorDate,
  dtliDirectOutcome,
  wpRawCount,
  buildWpCanaryUrl,
  shouldAuditCleanNoMatch,
  urlDatedBeforeProduction,
  WP_BOUNDED_PAGE_SIZE,
  WP_SEARCH_PAGE_SIZE,
  isTheatreReviewsHost,
  theatreReviewsDirectAcceptable,
  hasTheatreReviewsStarMarker,
};
