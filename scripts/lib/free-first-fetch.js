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
    .map(p => ({ url: p.url, title: String(p.title || '').replace(/<[^>]+>/g, '') }));
}

/** Test a URL against an `href="(...)"` style endpoint pattern, with a fresh non-global RegExp. */
function urlMatchesLinkPattern(url, linkPattern) {
  if (!linkPattern) return true;
  const re = new RegExp(linkPattern.source, linkPattern.flags.replace('g', ''));
  return re.test(`href="${url}"`);
}

/**
 * Decide whether the free WordPress search answered. Every candidate must pass
 * the same filters the paid path applies (linkPattern, urlLooksLike, named
 * non-review exclusions) BEFORE we call it a hit, so a free "hit" made only of
 * box-office posts or film reviews never suppresses the paid render.
 * @returns {{use:boolean, urls:string[], reason:string}}
 */
function decideFreeSearch(posts, { linkPattern, showTitle, urlLooksLike, nonReviewReason } = {}) {
  if (!Array.isArray(posts)) return { use: false, urls: [], reason: 'unusable-response' };
  if (posts.length === 0) return { use: false, urls: [], reason: 'empty' };
  const urls = [];
  for (const p of posts) {
    const url = p && p.url;
    if (!url || urls.includes(url)) continue;
    if (!urlMatchesLinkPattern(url, linkPattern)) continue;
    // Real Deadline/THR review slugs say "review"; news about the show (closing dates,
    // box office) must not count as a free hit and suppress the paid render (BRO-7532 live test).
    if (!/review/i.test(String(url).replace(/^https?:\/\/[^/]+/, ''))) continue;
    if (urlLooksLike && !urlLooksLike(url, showTitle)) continue;
    if (nonReviewReason && nonReviewReason(url)) continue;
    urls.push(url);
  }
  return urls.length ? { use: true, urls, reason: 'hit' } : { use: false, urls: [], reason: 'no-matching-review' };
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
  isTheatreReviewsHost,
  theatreReviewsDirectAcceptable,
};
