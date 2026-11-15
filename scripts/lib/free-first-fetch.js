/**
 * Free-first fetch decisions (BRO-7532). Pure functions; no network.
 *
 * Rule: a free path may only SHORT-CIRCUIT a paid path when it produced a usable
 * answer. Errors, blocks, non-JSON, empty and no-match all mean "fall back to the
 * paid path", so coverage can only go up.
 */

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
const STAGE_MARKERS = /(?:broadway|theat(?:er|re)|musical|off-broadway|west-end|revival|play)/i;
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
function isCurrentProductionPost(postDate, openingDate, graceDays = 45) {
  const post = Date.parse(postDate);
  const open = Date.parse(openingDate);
  if (!Number.isFinite(post) || !Number.isFinite(open)) return false;
  return post >= open - graceDays * 86400000;
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
function theatreReviewsDirectAcceptable(pathname, status, content) {
  if (status !== 200 || typeof content !== 'string' || !/<\/html\s*>/i.test(content)) return false;
  if (/^\/reviews-roundup\//.test(pathname)) return content.includes('⭑');
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
  isTheatreReviewsHost,
  theatreReviewsDirectAcceptable,
};
