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

const { normalizeTitle, foldDiacritics } = require('./title-match');
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
 *  - Multi-word titles (≥2 tokens) must appear as whole words after
 *    normalization, and an "&"-led title ("& Juliet" -> "and juliet") may
 *    not follow another word ("Romeo and Juliet").
 *
 * @param {string} headline - Article headline/title from listing page
 * @param {string} urlSlug  - URL slug/path of the article
 * @param {Array}  activeShows - Shows with status open or previews
 * @returns {Array} subset of activeShows that match
 */
// normalizeTitle JOINS hyphenated words ("Grown-Ups" → "grownups", deliberate
// for exact title-to-title matching, see title-match.js). A headline or URL
// slug is running text, not a title: "Deep-Heat Rivalry" and the slug
// "review-deep-heat-rivalry-at-…" both collapse to one token and never
// contain "deep heat rivalry" (BRO-4185: Theatre Weekly's review was in its
// RSS feed and matched nothing). So also compare a hyphens-as-spaces form of
// both sides. Kept local — title-match's contract is unchanged.
function hyphenSpaced(s) {
  return normalizeTitle(String(s || '').replace(/[-‐‑‒–—]/g, ' '));
}

// A book review names the musical's title or characters without being about
// the stage show (1 Minute Critic's "'Galinda: A Charmed Childhood' book
// review" landed on both Wicked entries, BRO-4656). Only the explicit "book
// review" label or a books-section path counts, and a theatre word keeps the
// item (a review comparing a musical with its source novel).
const BOOK_REVIEW_RE = /\bbook[\s-]+reviews?\b/i;
const THEATRE_WORD_RE = /\b(?:musical|stage|broadway|theat(?:er|re)|tour(?:ing)?|production|cast|play)\b/i;
// A books-section path (WSJ's /arts-culture/books/ "'Auslander' Review" put a
// novel on The Outsiders) counts the same as the label.
const BOOKS_SECTION_RE = /(?:^|\/)books?\//i;
function looksLikeBookReview(headline, urlSlug) {
  const text = `${headline || ''} ${String(urlSlug || '').replace(/[-_/]+/g, ' ')}`;
  return (BOOK_REVIEW_RE.test(text) || BOOKS_SECTION_RE.test(String(urlSlug || ''))) && !THEATRE_WORD_RE.test(text);
}

function findMatchingShows(headline, urlSlug, activeShows) {
  if (!headline && !urlSlug) return [];
  if (looksLikeBookReview(headline, urlSlug)) return [];
  // Slug separators become spaces too (hyphenSpaced handles the dashes):
  // normalizeTitle glues "hamilton-review-..." into one word the whole-word
  // test below can never find a title in.
  const combined = hyphenSpaced(String(headline || '').replace(/[_/]+/g, ' ')
    + ' ' + String(urlSlug || '').replace(/[/_.]+/g, ' '));
  if (!combined) return [];
  // Glued path segments ("TheBalusters.html", "Ragtime2025.html" on Talkin'
  // Broadway) only count when the segment STARTS with the glued title, so
  // "duchess-theatre" never yields "chess" and "romeo-and-juliet" never
  // yields "and juliet".
  // Only truly glued segments (no separators at all); a hyphenated slug is
  // already covered by `combined`, and prefix-matching it would let
  // "deep-heatwave" yield "Deep Heat".
  const gluedSegments = String(urlSlug || '').split(/[/.]+/)
    .filter((s) => s && !/[-_\s]/.test(s));

  const matches = [];

  for (const show of activeShows) {
    const norm = hyphenSpaced(String(show.title || '').replace(/[_/]+/g, ' '));
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

    // Multi-word titles or longer single-word distinctive titles: the title
    // must appear as whole words. A raw includes() also matched inside longer
    // words and, since normalizeTitle turns "&" into "and", put The Stage's
    // "Romeo and Juliet review" on "& Juliet" (and-juliet-2022, 2026-09-27).
    // So an "&"-led title may not follow another word either. Whole words
    // also keep "heat" spaced out of a slug from matching inside "theatre"
    // (BRO-4185's concern).
    const hay = ` ${combined} `;
    let at = hay.indexOf(` ${norm} `);
    let ok = false;
    while (at !== -1 && !ok) {
      ok = !(tokens[0] === 'and' && at > 0);
      at = hay.indexOf(` ${norm} `, at + 1);
    }
    if (!ok) {
      const glued = foldDiacritics(norm).replace(/[^a-z0-9]/g, '');
      ok = glued.length >= 6 && tokens[0] !== 'and'
        // normalizeTitle drops a leading article; the glued URL keeps it.
        // The title must end the segment or stop at a digit or a capital
        // ("Ragtime2025", "TheBalusters"), never mid-word.
        && gluedSegments.some((seg) => ['', 'the', 'a', 'an'].some((art) => {
          const lower = foldDiacritics(seg).toLowerCase();
          if (!lower.startsWith(art + glued)) return false;
          const next = seg.charAt(art.length + glued.length);
          return next === '' || /[0-9A-Z]/.test(next);
        }));
    }
    if (ok) {
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
// An unparseable date is an Invalid Date — truthy, never `< cutoff`, and its
// toISOString() throws RangeError, which used to abort the whole outlet
// (BRO-4185). Treat it as "no date" instead.
function parseFeedDate(dateMatch) {
  if (!dateMatch) return null;
  const d = new Date(dateMatch[1].trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseRssFeed(xml, cutoff) {
  const items = [];

  // RSS 2.0 items
  // `<item[\s>]` also matches RSS 1.0's `<item rdf:about="…">` (BRO-4185).
  const itemMatches = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  for (const [, body] of itemMatches) {
    const urlMatch = body.match(/<link>([^<]+)<\/link>/) || body.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const titleMatch = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch = body.match(/<pubDate>([^<]+)<\/pubDate>/i) || body.match(/<published>([^<]+)<\/published>/i);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();
    const headline = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
    const pubDate = parseFeedDate(dateMatch);
    if (pubDate && pubDate < cutoff) continue;
    if (!url.startsWith('http')) continue;
    items.push({ url, headline, publishDate: pubDate ? pubDate.toISOString().slice(0, 10) : null });
  }

  // Atom entries
  const entryMatches = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)];
  for (const [, body] of entryMatches) {
    // Prefer rel="alternate"; accept either quote style (Blogger emits href='…').
    const urlMatch = body.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
      || body.match(/<link[^>]+href=["']([^"']+)["']/i)
      || body.match(/<id>([^<]+)<\/id>/);
    const titleMatch = body.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch = body.match(/<published>([^<]+)<\/published>/i) || body.match(/<updated>([^<]+)<\/updated>/i);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();
    const headline = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').trim() : '';
    const pubDate = parseFeedDate(dateMatch);
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
  looksLikeBookReview,
  findMatchingShows,
  deriveQualifyingOutlets,
  mergeAlwaysOnOutlets,
  parseRssFeed,
  parseWpApiPosts,
  parseSitemapXml,
  extractListingUrls,
  buildSerpQuery,
};
