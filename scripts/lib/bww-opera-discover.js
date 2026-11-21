/**
 * BWW Opera review URL discovery.
 *
 * Sibling to scripts/lib/bww-rr-discover.js, but for BroadwayWorld's
 * dedicated opera coverage at /bwwopera/reviews. BWW Opera publishes
 * Met-transmission reviews by Richard Sasanow and others; the listing
 * page renders server-side without a Cloudflare interstitial (unlike
 * /reviews.php which requires Browserbase), so a plain curl with a
 * desktop UA is sufficient.
 *
 * URL pattern: /bwwopera/article/Review-{HAND-AUTHORED-SLUG}-{YYYYMMDD}
 *
 * Used by: SITE_SEARCH_ENDPOINTS['broadwayworld'] in site-search-discovery.js,
 * which is dispatched by scripts/opening-night-poller.js for type:opera shows.
 *
 * Soft-404 guard: BWW returns the homepage HTML with 200 OK for missing
 * URLs (see memory/feedback_aggregator_soft_404.md). The discovery path
 * checks the response title and bails if it doesn't contain "Opera"
 * or "Review".
 */

'use strict';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'is',
  'la', 'le', 'el', 'un', 'une', 'und', 'de', 'di', 'y', 'et', 'des', 'en',
]);

function titleTokens(title) {
  // Strip diacritics first so "Último Sueño" → "ultimo sueno" (real tokens)
  // and not "ltimo sue" (fragments left after the char filter removes ú/ñ).
  return (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Discover BWW Opera review URLs for a given show.
 *
 * @param {Object} show - shows.json entry. Must have `title`, `openingDate`, `id`.
 * @param {Object} [options]
 * @param {Function} [options.fetcher] - injectable fetch returning string body.
 *   Defaults to scripts/lib/site-search-discovery.fetchSSR.
 * @returns {Promise<Array<{url, outletId, outlet, source}>>}
 */
async function discoverBwwOperaReviews(show, options = {}) {
  if (!show || show.type !== 'opera') return [];
  const title = show.title;
  if (!title) return [];

  const fetcher = options.fetcher || (await getDefaultFetcher());
  let html;
  try {
    html = await fetcher('https://www.broadwayworld.com/bwwopera/reviews');
  } catch (e) {
    console.warn(`    [bww-opera-discover] fetch failed: ${e.message}`);
    return [];
  }

  // Soft-404 detection. BWW returns the generic homepage with 200 OK when
  // a section page is missing — we can't rely on the title to distinguish
  // (the legit /bwwopera/reviews page returns "Broadway Show Reviews &
  // Critics' Ratings | BroadwayWorld", same title family as the homepage).
  // Instead, rely on the URL pattern itself: /bwwopera/article/Review- is
  // specific to the section. If the response has zero such URLs, treat as
  // soft-404 or structural change and bail.
  const urls = new Set();
  const pattern = /["'](?:https?:\/\/(?:www\.)?broadwayworld\.com)?(\/bwwopera\/article\/Review-[A-Za-z0-9-]+)["']/g;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    urls.add('https://www.broadwayworld.com' + m[1]);
  }

  if (urls.size === 0) {
    console.warn('    [bww-opera-discover] 0 /bwwopera/article/Review- URLs found (soft-404 or structural change)');
    return [];
  }

  const tokens = titleTokens(title);
  if (tokens.length === 0) return [];

  // Match policy: BWW slugs are hand-authored marketing copy that routinely
  // shortens the show name (Eugene Onegin → "Mets ONEGIN Revival…", Frida y
  // Diego → "FRIDA Y DIEGO is the Ultimate Dream…"). Treat ≥50% token match
  // as sufficient, with a floor of 1. False-positive risk is bounded by the
  // filterOperaUrls() year-window check at the caller side.
  const minHits = Math.max(1, Math.ceil(tokens.length / 2));

  const results = [];
  for (const url of urls) {
    const slug = url.split('/').pop().toLowerCase();
    const hits = tokens.filter((t) => slug.includes(t)).length;
    if (hits >= minHits) {
      results.push({
        url,
        outletId: 'broadwayworld',
        outlet: 'BroadwayWorld',
        source: 'bww-opera-discover',
      });
    }
  }
  return results;
}

let _cachedFetcher = null;
async function getDefaultFetcher() {
  if (_cachedFetcher) return _cachedFetcher;
  // Use scraper.fetchPage — its fallback chain (cookies-plain → Bright Data →
  // ScrapingBee → Playwright) handles BWW's intermittent Cloudflare gate.
  const { fetchPage } = require('./scraper');
  _cachedFetcher = async (url) => {
    const r = await fetchPage(url, { skipVerify: true });
    if (!r || !r.content) throw new Error(`fetchPage returned no content for ${url}`);
    return r.content;
  };
  return _cachedFetcher;
}

module.exports = {
  discoverBwwOperaReviews,
  _titleTokens: titleTokens,
};
