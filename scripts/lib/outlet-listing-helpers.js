'use strict';

/**
 * outlet-listing-helpers.js
 *
 * Shared logic for the outlet-listing-poller. Extracted to a separate module
 * so tests can require() the real function rather than copying it.
 *
 * Key export: findMatchingShows(headline, urlSlug, activeShows)
 *
 * Cross-show detection design:
 *   - Scans ALL active (open/previews) shows against each discovered article
 *   - Uses normalizeTitle + word/phrase matching with safety guards for
 *     common-word show titles (Six, Rent, Cats, etc.)
 *   - Returns an array so callers can file the same article under 2+ shows
 */

const { normalizeTitle } = require('./title-match');
const { COMMON_WORD_SHOW_TITLES } = require('./multi-show-splitter');

/**
 * Escape a string for use inside a RegExp.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a headline + URL slug against all active shows and return every show
 * whose title appears in the combined text.
 *
 * Guards:
 *  - Titles in COMMON_WORD_SHOW_TITLES ("six", "rent", "chicago" etc.) require
 *    a word-boundary regex match AND the match must be in the URL slug (more
 *    specific than just the headline). This prevents "six actors" or "chicago
 *    theater" from triggering a stub under the show *Six* or *Chicago*.
 *  - Single-word normalized titles shorter than 7 chars and NOT in
 *    COMMON_WORD_SHOW_TITLES are also skipped — too short to match reliably
 *    (e.g. "nine" → 4 chars, would FP constantly).
 *  - Multi-word titles (≥2 tokens) use simple text.includes() after
 *    normalization — low FP risk since the full phrase must appear.
 *
 * @param {string} headline - Article headline/title from listing page
 * @param {string} urlSlug  - URL slug/path of the article
 * @param {Array}  activeShows - Shows with status open or previews
 * @returns {Array} subset of activeShows that match
 */
function findMatchingShows(headline, urlSlug, activeShows) {
  if (!headline && !urlSlug) return [];
  const combined = normalizeTitle((headline || '') + ' ' + (urlSlug || ''));
  if (!combined) return [];

  const matches = [];

  for (const show of activeShows) {
    const norm = normalizeTitle(show.title || '');
    if (!norm) continue;

    const tokens = norm.split(/\s+/).filter(Boolean);

    if (COMMON_WORD_SHOW_TITLES.has(norm)) {
      // Common one-word shows (Six, Rent, Chicago, Giant, etc.) are handled by
      // the per-show SERP collector (collect-outlet-reviews.js). Skip them here
      // to avoid false positives from generic theater articles.
      continue;
    }

    if (tokens.length === 1 && norm.length < 5) {
      // Very short single-word titles not in the common set (e.g. "Job", "Fur")
      // — too risky to match without production-credit context.
      continue;
    }

    // Multi-word titles or longer single-word distinctive titles:
    // simple substring match on the combined normalized text is sufficient.
    if (combined.includes(norm)) {
      matches.push(show);
    }
  }

  return matches;
}

/**
 * Build the list of qualifying outlets from reviews.json + shows.json.
 * Returns outletIds for outlets that reviewed ≥minShowCount distinct shows
 * that opened within the past lookbackDays.
 *
 * @param {Array}  allReviews    - reviews array from reviews.json
 * @param {Array}  allShows      - shows array from shows.json
 * @param {Set}    skipOutlets   - outletIds to exclude (dedicated scrapers, etc.)
 * @param {Object} [opts]
 * @param {number} [opts.minShowCount=5]
 * @param {number} [opts.lookbackDays=120]
 * @returns {string[]} sorted by review count descending
 */
function deriveQualifyingOutlets(allReviews, allShows, skipOutlets, opts = {}) {
  const { minShowCount = 5, lookbackDays = 120 } = opts;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const recentShows = new Set(
    allShows
      .filter(s => {
        const d = s.openingDate || s.previewsStartDate;
        return d && new Date(d) >= cutoff;
      })
      .map(s => s.id)
  );

  const outletShowSets = {};
  for (const review of allReviews) {
    if (!recentShows.has(review.showId)) continue;
    const id = review.outletId;
    if (!id || skipOutlets.has(id)) continue;
    if (!outletShowSets[id]) outletShowSets[id] = new Set();
    outletShowSets[id].add(review.showId);
  }

  return Object.entries(outletShowSets)
    .filter(([, s]) => s.size >= minShowCount)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([id]) => id);
}

/**
 * Merge the dynamically-derived qualifying outlets with the "always-on" outlets
 * we've explicitly configured a dedicated strategy for (RSS/sitemap/WP API).
 *
 * Why: deriveQualifyingOutlets gates on review volume (≥minShowCount shows/4mo),
 * which is right for SERP-fallback outlets discovered from reviews.json. But an
 * outlet with a hand-configured strategy is high-value by definition and must be
 * polled EVERY run even when its show count is below the gate — otherwise it
 * depends solely on per-show SERP timing, which silently drops late/low-rank
 * reviews. That gap missed The Recs' 5-star The Lost Boys review (2026-04).
 *
 * Order: derived outlets first (sorted by volume), then any configured outlets
 * not already present. Skip-listed outlets are excluded from both sources.
 *
 * @param {string[]} derived       - output of deriveQualifyingOutlets
 * @param {string[]} configuredIds - outletIds with an explicit strategy config
 * @param {Set}      skipOutlets   - outletIds to exclude
 * @returns {string[]} deduped union
 */
function mergeAlwaysOnOutlets(derived, configuredIds, skipOutlets = new Set()) {
  const seen = new Set();
  const out = [];
  for (const id of [...derived, ...configuredIds]) {
    if (!id || skipOutlets.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Parse an RSS 2.0 / Atom feed XML string and return articles published
 * within the lookback window.
 *
 * @param {string} xml
 * @param {Date}   cutoff
 * @returns {Array<{url: string, headline: string, publishDate: string|null}>}
 */
function parseRssFeed(xml, cutoff) {
  const items = [];

  // RSS 2.0 items
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const [, body] of itemMatches) {
    const urlMatch = body.match(/<link>([^<]+)<\/link>/) || body.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const titleMatch = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch = body.match(/<pubDate>([^<]+)<\/pubDate>/i) || body.match(/<published>([^<]+)<\/published>/i);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();
    const headline = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
    const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
    if (pubDate && pubDate < cutoff) continue;
    if (!url.startsWith('http')) continue;
    items.push({ url, headline, publishDate: pubDate ? pubDate.toISOString().slice(0, 10) : null });
  }

  // Atom entries
  const entryMatches = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  for (const [, body] of entryMatches) {
    const urlMatch = body.match(/<link[^>]+href="([^"]+)"/) || body.match(/<id>([^<]+)<\/id>/);
    const titleMatch = body.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch = body.match(/<published>([^<]+)<\/published>/i) || body.match(/<updated>([^<]+)<\/updated>/i);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();
    const headline = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').trim() : '';
    const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
    if (pubDate && pubDate < cutoff) continue;
    if (!url.startsWith('http')) continue;
    items.push({ url, headline, publishDate: pubDate ? pubDate.toISOString().slice(0, 10) : null });
  }

  return items;
}

/**
 * Extract article URLs from a WordPress REST API response.
 *
 * @param {Array}  posts   - Array of WP post objects
 * @param {Date}   cutoff
 * @returns {Array<{url: string, headline: string, publishDate: string}>}
 */
function parseWpApiPosts(posts, cutoff) {
  const items = [];
  for (const post of posts) {
    const url = post.link || post.url;
    const headline = post.title?.rendered || post.title || '';
    const rawDate = post.date || post.date_gmt;
    if (!url || !rawDate) continue;
    const pubDate = new Date(rawDate);
    if (pubDate < cutoff) continue;
    items.push({ url, headline: headline.replace(/<[^>]+>/g, '').trim(), publishDate: pubDate.toISOString().slice(0, 10) });
  }
  return items;
}

/**
 * Parse an XML sitemap and return URLs matching the filter that are >= cutoff.
 *
 * Handles the missing-<lastmod> case: if an entry lacks <lastmod>, it is
 * INCLUDED (not dropped) — the caller's active-show filter is the safety net.
 * This prevents a CDN-cached sitemap with no <lastmod> from silently zeroing out
 * the feed (the failure mode that plagued the broken Vulture RSS strategy).
 *
 * @param {string}  xml
 * @param {Date}    cutoff
 * @param {RegExp}  [urlFilter]  — only return URLs matching this pattern
 * @returns {Array<{url: string, headline: null, publishDate: string|null}>}
 */
function parseSitemapXml(xml, cutoff, urlFilter) {
  const items = [];
  const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)];
  for (const [, body] of urlBlocks) {
    const locMatch = body.match(/<loc>([^<]+)<\/loc>/);
    if (!locMatch) continue;
    const url = locMatch[1].trim();
    if (!url.startsWith('http')) continue;
    if (urlFilter && !urlFilter.test(url)) continue;

    const lastmodMatch = body.match(/<lastmod>([^<]+)<\/lastmod>/);
    if (lastmodMatch) {
      const lastmod = new Date(lastmodMatch[1].trim());
      if (!isNaN(lastmod) && lastmod < cutoff) continue;
    }
    // No <lastmod> → include (don't silently drop — see function comment)

    items.push({ url, headline: null, publishDate: lastmodMatch ? lastmodMatch[1].trim().slice(0, 10) : null });
  }
  return items;
}

/**
 * Build a SERP site: query for the given domain. UK outlets (.co.uk) use the
 * correct British English spelling "theatre"; US outlets use "theater".
 *
 * Exported for unit testing.
 *
 * @param {string} domain  e.g. "thestage.co.uk" or "theatermania.com"
 * @returns {string}
 */
function buildSerpQuery(domain) {
  const isUk = domain.endsWith('.co.uk');
  return `site:${domain} ${isUk ? 'theatre' : 'theater'} review`;
}

/**
 * Extract article URLs from a generic HTML listing page.
 * Looks for <a href> links on the outlet's domain with URL patterns
 * that suggest individual article pages (not nav/category/tag pages).
 *
 * @param {string} html
 * @param {string} domain
 * @returns {Array<{url: string, headline: string}>}
 */
function extractListingUrls(html, domain) {
  const seen = new Set();
  const items = [];

  // Match all anchor tags with href
  const aMatches = [...html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [, href, rawText] of aMatches) {
    let url;
    try {
      url = href.startsWith('http') ? href : `https://${domain}${href.startsWith('/') ? href : '/' + href}`;
      new URL(url); // validate
    } catch { continue; }

    const urlObj = new URL(url);
    // Strict domain check: accept only exact match or www. subdomain.
    // Substring check (e.g. "broadway.timeout.com".includes("timeout.com")) is too permissive
    // and admits ticket/calendar subdomains that aren't article pages.
    const normalizedDomain = domain.replace(/^www\./, '');
    const urlHostNorm = urlObj.hostname.replace(/^www\./, '');
    if (urlHostNorm !== normalizedDomain) continue;

    // Skip navigation/utility links
    const path = urlObj.pathname;
    if (path === '/' || path === '' || path.split('/').filter(Boolean).length < 2) continue;
    if (/\/(tag|category|author|page|search|about|contact|advertise|subscribe|calendar)\//i.test(path)) continue;

    const headline = rawText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!headline || headline.length < 5) continue;

    // Dedup after headline check: image-only anchors (empty headline) must not
    // poison the seen set and block the subsequent text anchor for the same URL.
    if (seen.has(url)) continue;
    seen.add(url);

    items.push({ url, headline });
  }

  return items;
}

module.exports = {
  findMatchingShows,
  deriveQualifyingOutlets,
  mergeAlwaysOnOutlets,
  parseRssFeed,
  parseWpApiPosts,
  parseSitemapXml,
  extractListingUrls,
  buildSerpQuery,
};
