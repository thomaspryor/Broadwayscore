/**
 * Playbill per-show review-roundup discovery for type:opera shows.
 *
 * Sibling to scripts/lib/playbill-verdict-discover.js. That helper scrapes
 * Playbill's "The Verdict" CATEGORY page (Broadway, not opera). This helper
 * targets the OTHER Playbill content type: per-show roundup articles like
 *   /article/what-did-reviews-say-about-tristan-und-isolde-at-met-opera
 *   /article/reviews-are-out-for-el-ultimo-sueno-de-frida-y-diego-at-met-opera
 *   /article/reviews-what-did-critics-think-of-the-amazing-adventures-of-kavalier-clay-at-the-metropolitan-opera
 *
 * Playbill publishes one such article per major Met premiere, ~1 week after
 * opening. Each article aggregates outlet links (NYT, WSJ, FT, Operawire,
 * Bachtrack, Vulture, NYCR, Parterre, etc.) we'd otherwise discover one
 * outlet at a time. High-recall, low-cost safety net for the per-outlet
 * fan-out — when this hits, it suppresses several redundant outlet fetches.
 *
 * Discovery strategy: SERP query against playbill.com filtered to the
 * roundup-title patterns. Slugs are not deterministic enough for URL
 * guessing (Tristan uses "what-did-reviews-say-about", Kavalier uses
 * "reviews-what-did-critics-think-of", Frida uses "reviews-are-out-for"),
 * and Playbill's site-search is JS-rendered.
 *
 * Used by: SITE_SEARCH_ENDPOINTS['playbill-roundup'] in site-search-discovery.js
 * (firing as a regular opera endpoint, gated `applies: type === 'opera'`).
 */

'use strict';

const { serpQuery } = require('./url-discovery');
const { withOperaCache } = require('./opera-discovery-cache');

const ROUNDUP_URL_PATTERNS = [
  /\/article\/reviews-are-out-for-[a-z0-9-]+/i,
  /\/article\/what-did-reviews-say-about-[a-z0-9-]+/i,
  /\/article\/reviews-what-did-critics-think-of-[a-z0-9-]+/i,
  /\/article\/what-did-critics-think-of-[a-z0-9-]+/i,
];

const REVIEW_OUTLET_DOMAINS = [
  'nytimes.com',
  'wsj.com',
  'newyorker.com',
  'vulture.com',
  'washingtonpost.com',
  'ft.com',
  'thetimes.com',
  'theartsdesk.com',
  'operawire.com',
  'bachtrack.com',
  'parterre.com',
  'newyorkclassicalreview.com',
  'classicalvoiceamerica.org',
  'seenandheard-international.com',
  'nystagereview.com',
  'observer.com',
  'theatermania.com',
  'broadwayworld.com',
];

function _looksLikeRoundupUrl(url) {
  return ROUNDUP_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Discover outlet review URLs for an opera show via Playbill roundup.
 *
 * @param {Object} show — must have title, id, type:'opera', openingDate
 * @param {Object} [options]
 * @param {Function} [options.fetcher] — async (url) => string; defaults to
 *   site-search-discovery.fetchSSR via scraper.fetchPage fallback chain.
 * @returns {Promise<string[]>} outlet review URLs found in the roundup
 */
async function discoverPlaybillRoundup(show, options = {}) {
  if (!show || show.type !== 'opera' || !show.title || !show.id) return [];
  return withOperaCache({ outletId: 'playbill-roundup', showId: show.id }, async () => {
    // Step 1: SERP for a Playbill roundup article matching this show.
    const q = `site:playbill.com "${show.title}" reviews Met Opera`;
    const results = await serpQuery(q, { nbResults: 10 }).catch(() => null);
    if (!Array.isArray(results) || results.length === 0) return [];

    const candidate = results
      .map((r) => (typeof r === 'string' ? r : r.url || r.link))
      .filter(Boolean)
      .find(_looksLikeRoundupUrl);
    if (!candidate) {
      console.log(`    [playbill-roundup] no roundup URL for ${show.id} in ${results.length} SERP results`);
      return [];
    }

    // Step 2: fetch the roundup article and extract outlet URLs.
    const fetcher = options.fetcher || (await _getDefaultFetcher());
    let html;
    try {
      html = await fetcher(candidate);
    } catch (e) {
      console.warn(`    [playbill-roundup] article fetch failed ${candidate}: ${e.message}`);
      return [];
    }

    const found = new Set();
    // Greedy URL extraction across the article body. Restrict to known
    // review-outlet domains so we don't pull in tracker/ads/Playbill nav.
    const urlPattern = /https?:\/\/(?:[a-z0-9-]+\.)*([a-z0-9-]+\.[a-z]{2,})\/[^\s"')<>]+/gi;
    let m;
    while ((m = urlPattern.exec(html)) !== null) {
      const fullUrl = m[0];
      const host = m[1].toLowerCase();
      if (!REVIEW_OUTLET_DOMAINS.some((d) => host === d || host.endsWith('.' + d) || fullUrl.includes(d))) continue;
      // Drop obvious non-article paths
      if (/\/(?:tag|category|author|search|wp-content|assets|cdn|static)\b/i.test(fullUrl)) continue;
      // Drop image/asset/tracking suffixes
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|woff2?)\b/i.test(fullUrl)) continue;
      // Trim trailing punctuation that survived the regex
      const cleaned = fullUrl.replace(/[),.;:!?"'>\]]+$/, '');
      found.add(cleaned);
    }

    return Array.from(found);
  });
}

let _cachedFetcher = null;
async function _getDefaultFetcher() {
  if (_cachedFetcher) return _cachedFetcher;
  const { fetchPage } = require('./scraper');
  _cachedFetcher = async (url) => {
    const r = await fetchPage(url, { skipVerify: true });
    if (!r || !r.content) throw new Error('fetchPage returned no content');
    return r.content;
  };
  return _cachedFetcher;
}

module.exports = {
  discoverPlaybillRoundup,
  _looksLikeRoundupUrl,
  _ROUNDUP_URL_PATTERNS: ROUNDUP_URL_PATTERNS,
  _REVIEW_OUTLET_DOMAINS: REVIEW_OUTLET_DOMAINS,
};
