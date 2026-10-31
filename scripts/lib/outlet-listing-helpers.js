'use strict';
const { publishedStampToLocalDate } = require('./local-date');

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
const { toDateMs } = require('./date-utils');

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
 *  - Titles in COMMON_WORD_SHOW_TITLES ("six", "rent", "chicago" etc.) are
 *    skipped here (the per-show SERP collector handles them). One-word titles
 *    under 5 chars ("fish", "rope") match only when the headline, slug or feed
 *    description also names a full cast, director or writer name of that show
 *    (namesShowCredit): "fish market" files nothing, "Melis Aker's Fish" lands
 *    on *Fish*.
 *  - Multi-word titles (≥2 tokens) must appear as whole words after
 *    normalization, and an "&"-led title ("& Juliet" -> "and juliet") may
 *    not follow another word ("Romeo and Juliet").
 *
 * @param {string} headline - Article headline/title from listing page
 * @param {string} urlSlug  - URL slug/path of the article
 * @param {Array}  activeShows - Shows with status open or previews
 * @param {string} [creditText] - feed description/summary; only used to find a cast or director name (or, for a brand-new production, a writer name) for one-word titles under 5 letters
 * @param {{nowMs?: number, publishDate?: string}} [opts] publishDate (YYYY-MM-DD) lets a credit-less short-title show match on a headline that is exactly its title, inside its run window
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

// A one-word title under 5 letters ("Fish", "Soon", "Rope") is too ambiguous to
// match on the title alone, and used to be skipped outright. Skipped meant never
// matched by this outlet-first sweep: Theater Pizzazz and Off Off Online both ran
// a Fish review in their RSS feeds the day after opening and the poller filed
// neither (BRO-5326; 13 of 251 running shows were in this blind spot). Such a
// title now matches when the headline, slug or feed description ALSO names a
// full cast, director or writer name of that show.
//
// Deliberately NOT extended to COMMON_WORD_SHOW_TITLES (Six, Chicago, Oliver...):
// their writers and composers are shared by every production of the title, so
// "Kander and Ebb's Cabaret at Chicago Shakespeare" would file under Chicago
// (found by review, reproduced, reverted). Composer/lyricist/source credits are
// excluded for the same reason, and because they can be a biopic's subject
// (MJ lists "Michael Jackson" under Music & Lyrics).
// Two kinds of credit, because they identify different things:
//  - Cast and directors belong to ONE production. They always count.
//  - Playwright, book and author credits belong to EVERY production of the play
//    ("Patrick Hamilton's Rope at Theatre Royal Bath" is not Rope off-Broadway),
//    so they count only while the show is a brand-new production (previews began
//    within YOUNG_PRODUCTION_DAYS, not a revival): the play is new, so no other
//    production exists yet. That is Fish: a world premiere, reviewed under
//    "Melis Aker's Fish".
// Not counted: casting, music and associate/assistant directors (named across many
// productions), composers, lyricists and songwriters, choreographers.
const PRODUCTION_ROLE_RE = /\bdirector\b/i;
const SHARED_ROLE_RE = /\b(playwright|writer|book|author|creator)\b/i;
const NOT_A_CREDIT_RE = /casting|music(al)?\s+director|associate|assistant|co-?director|song|compos|lyric|choreograph/i;
const YOUNG_PRODUCTION_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

function isYoungProduction(show, nowMs) {
  if (!show || show.isRevival === true) return false;
  const t = Date.parse(show.previewsStartDate || show.openingDate || '');
  return !Number.isNaN(t) && nowMs - t <= YOUNG_PRODUCTION_DAYS * DAY_MS && nowMs - t >= -DAY_MS * 365;
}

// Full-name credits that identify THIS production (see the two kinds above).
function creditNames(show, nowMs = Date.now()) {
  const young = isYoungProduction(show, nowMs);
  const roleOk = (p) => {
    const role = String((p && p.role) || '');
    if (NOT_A_CREDIT_RE.test(role)) return false;
    return PRODUCTION_ROLE_RE.test(role) || (young && SHARED_ROLE_RE.test(role));
  };
  const people = [...(show.creativeTeam || []).filter(roleOk), ...(show.cast || [])];
  // Full names only: a first or last name alone ("Mark") would match anything.
  return people.map((p) => hyphenSpaced(p && p.name)).filter((n) => n && n.split(/\s+/).length >= 2);
}

function namesShowCredit(combined, show, nowMs = Date.now()) {
  const hay = ` ${combined} `;
  // normalizeTitle drops the apostrophe, so "Melis Aker's Fish" reads "melis akers".
  return creditNames(show, nowMs).some((name) => hay.includes(` ${name} `) || hay.includes(` ${name}s `));
}

// BRO-5358: Soon, Rope, Baby, MYTH and Nina are one-word titles under 5 letters
// whose shows.json rows carry no cast or creative team yet, so namesShowCredit
// can never be true and the outlet-first poller could never file them. For such
// a show the show's OWN venue, as a whole phrase in the headline, slug or feed
// description, is the credit context ("Soon at St. Luke's Theatre"). Guards:
//  - only when the show has no usable credits (otherwise credits stay the rule);
//  - a venue that is a bare generic word ("Theatre", "TBD") is not a signal;
//  - a one-word venue under 6 letters (JACK) must appear exactly as stored
//    (all-caps), so the name "Jack" or "jack of all trades" does not count;
//  - if another active show at the same venue matched by its own title, the
//    venue belongs to that show, not to this one (decided in findMatchingShows).
const GENERIC_VENUES = new Set(['theatre', 'theater', 'tbd', 'tba', 'various', 'off broadway', 'broadway', 'west end', 'london', 'new york', 'online', 'virtual']);
function venuePhrase(show) {
  const norm = hyphenSpaced(show && show.venue);
  if (!norm || GENERIC_VENUES.has(norm)) return '';
  return norm;
}

// Real feeds title an off-Broadway review with the bare show name: Off Off Online's
// "Soon" and Theater Scene's "Soon" (BRO-5358) name no venue, cast or writer. For a
// credit-less short-title show, an item whose WHOLE headline is the title ("Soon",
// "Review: Soon", "Soon review"), published inside the show's own run window, is
// credit enough: the date pins it to this production, the exact headline to the show.
const RUN_LEAD_DAYS = 3;
const RUN_TAIL_DAYS = 21;
function publishedInRunWindow(show, publishDate) {
  const pub = toDateMs(publishDate);
  const start = Date.parse(show.previewsStartDate || show.openingDate || '');
  if (Number.isNaN(pub) || Number.isNaN(start)) return false;
  const end = Date.parse(show.openingDate || '') || start;
  return pub >= start - RUN_LEAD_DAYS * DAY_MS && pub <= Math.max(start, end) + RUN_TAIL_DAYS * DAY_MS;
}

function headlineIsTitle(headline, show) {
  const norm = hyphenSpaced(show && show.title);
  const h = hyphenSpaced(String(headline || '').replace(/[_/]+/g, ' '));
  return !!norm && !!h && (h === norm || h === `review ${norm}` || h === `${norm} review`);
}

// The poller FILES whatever matches, so a venue credit also needs the item to call
// itself a review: "Soon to open at St. Luke's Theatre" is news, not a review.
const REVIEW_WORD_RE = /\b(review|reviews|reviewed)\b/i;

function namesShowVenue(combined, rawText, show, nowMs = Date.now()) {
  if (creditNames(show, nowMs).length > 0) return false;
  if (!REVIEW_WORD_RE.test(`${rawText || ''} ${combined}`)) return false;
  const norm = venuePhrase(show);
  if (!norm) return false;
  if (!` ${combined} `.includes(` ${norm} `)) return false;
  const tokens = norm.split(/\s+/);
  if (tokens.length === 1 && norm.length < 6) {
    const stored = String(show.venue).trim();
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(stored)}($|[^A-Za-z0-9])`).test(String(rawText || ''));
  }
  return true;
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

function findMatchingShows(headline, urlSlug, activeShows, creditText = '', { nowMs = Date.now(), publishDate = null } = {}) {
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

  // Credit context may also come from the feed item's description; the title
  // itself must still appear in the headline or slug.
  const creditHay = `${combined} ${hyphenSpaced(String(creditText || ''))}`;

  const matches = [];
  // Matched on the show's venue alone (see namesShowVenue); checked after the loop.
  const venueOnly = new Set();
  const rawText = `${headline || ''} ${creditText || ''}`;

  for (const show of activeShows) {
    const norm = hyphenSpaced(String(show.title || '').replace(/[_/]+/g, ' '));
    if (!norm) continue;

    const tokens = norm.split(/\s+/).filter(Boolean);

    // A common-word show with no credits yet (Baby, BRO-5358) has nothing but
    // its venue to go on: venue belongs to one production, unlike a writer
    // credit shared by every production of the title, so it stays safe here.
    const commonWord = COMMON_WORD_SHOW_TITLES.has(norm);
    if (commonWord && !(creditNames(show, nowMs).length === 0 && venuePhrase(show))) {
      // Common one-word shows (Six, Rent, Chicago, Giant, etc.) are handled by
      // the per-show SERP collector (collect-outlet-reviews.js). Skip them here
      // to avoid false positives from generic theater articles.
      continue;
    }
    // Very short single-word titles not in the common set (e.g. "Job", "Fur",
    // "Fish") match only with production-credit context (namesShowCredit).
    const needsCredit = commonWord || (tokens.length === 1 && norm.length < 5);

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
    if (ok && needsCredit && !namesShowCredit(creditHay, show, nowMs)) {
      if (namesShowVenue(creditHay, rawText, show, nowMs)) venueOnly.add(show);
      else if (creditNames(show, nowMs).length === 0 && headlineIsTitle(headline, show) && publishedInRunWindow(show, publishDate)) venueOnly.add(show);
      else ok = false;
    }
    if (ok) {
      matches.push(show);
    }
  }

  // A venue credit is void when another show at the same venue matched on its
  // own title: "Hamlet at St. Luke's Theatre ... soon" belongs to Hamlet.
  return matches.filter((show) => !venueOnly.has(show)
    || !matches.some((o) => o !== show && !venueOnly.has(o) && venuePhrase(o) === venuePhrase(show)));
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

// Item description/summary as plain text, kept only as production-credit context
// for findMatchingShows (never matched against titles). Off Off Online titles a
// review just "Fish" and names the playwright only in the description.
function feedText(body, tags) {
  for (const tag of tags) {
    const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!m) continue;
    return m[1].replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c <= 0x10ffff ? String.fromCodePoint(c) : m; })
      .replace(/&nbsp;/g, ' ').replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 800);
  }
  return '';
}

/**
 * True when the text is an XML document whose root element is one of `roots`
 * (the first tag after BOM, declaration, stylesheet PIs, comments and doctype).
 * A proxied fetch can return a 200 block or interstitial page that a parser
 * would read as an empty feed ("no new reviews") instead of a failure, and an
 * HTML page that merely mentions <rss somewhere must not pass (BRO-6340).
 */
function hasXmlRoot(text, roots) {
  const body = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
  const m = body.match(/^<([A-Za-z][\w:.-]*)/);
  return !!m && roots.some(r => r.toLowerCase() === m[1].toLowerCase());
}

/** RSS 2.0, Atom or RSS 1.0 (RDF) feed. */
function looksLikeFeed(text) {
  return hasXmlRoot(text, ['rss', 'feed', 'rdf:RDF']);
}

/** XML sitemap or sitemap index. */
function looksLikeSitemap(text) {
  return hasXmlRoot(text, ['urlset', 'sitemapindex']);
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
    items.push({ url, headline, publishDate: pubDate ? publishedStampToLocalDate(pubDate, url) : null, description: feedText(body, ['description']) });
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
    items.push({ url, headline, publishDate: pubDate ? publishedStampToLocalDate(pubDate, url) : null, description: feedText(body, ['summary']) });
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
    // post.date is the site's local wall-clock stamp (no zone): its date part IS the calendar date.
    // Only the date_gmt fallback is UTC and needs converting (BRO-5499).
    const publishDate = post.date ? String(post.date).slice(0, 10) : publishedStampToLocalDate(`${String(post.date_gmt).slice(0, 19)}Z`, url);
    items.push({ url, headline: headline.replace(/<[^>]+>/g, '').trim(), publishDate });
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

    // lastmod is a UTC instant: store the publisher-local date, not the UTC day (BRO-5499)
    items.push({ url, headline: null, publishDate: lastmodMatch ? publishedStampToLocalDate(lastmodMatch[1].trim(), url) : null });
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

// --- Feed staleness (BRO-6352) ---
// TheWrap's tag feed and observer.com's theater feed froze in June 2026; the
// poller read "0 items in window" as "no new reviews" for 4 months while both
// outlets kept publishing (caught only by hand in BRO-6340). The poller now
// records each rss/sitemap feed's newest item here and flags a feed whose
// newest matching item is old while reviews.json still shows the outlet alive.
const OUTLET_FEED_HEALTH_REL = 'data/audit/outlet-feed-health.json';
const FEED_STALE_DAYS = 45;
const OUTLET_ALIVE_DAYS = 30;

/** Newest `publishDate` (YYYY-MM-DD string) among items, or null when none is dated. */
function newestItemDate(items) {
  let newest = null;
  for (const it of items || []) {
    const d = it && typeof it.publishDate === 'string' ? it.publishDate.slice(0, 10) : null;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (!newest || d > newest)) newest = d;
  }
  return newest;
}

/** Oldest `publishDate` among items, or null when none is dated. */
function oldestItemDate(items) {
  let oldest = null;
  for (const it of items || []) {
    const d = it && typeof it.publishDate === 'string' ? it.publishDate.slice(0, 10) : null;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (!oldest || d < oldest)) oldest = d;
  }
  return oldest;
}

/** outletId → newest review publishDate (YYYY-MM-DD) in reviews.json. */
function latestReviewDateByOutlet(reviews) {
  const out = {};
  for (const r of reviews || []) {
    if (!r || !r.outletId || typeof r.publishDate !== 'string') continue;
    const d = r.publishDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!out[r.outletId] || d > out[r.outletId]) out[r.outletId] = d;
  }
  return out;
}

/**
 * A feed is stale when the outlet is still publishing (a review in reviews.json
 * within aliveDays) but the feed's newest MATCHING item is older than staleDays,
 * or the feed has no matching items at all. Undated items that are present are
 * not judged stale (sitemaps without <lastmod>): there is nothing to compare.
 * No matching item in a site-wide feed whose items (oldestAny) only reach back
 * less than staleDays is not stale either: the window is too short to judge
 * (south-london's /feed/ holds ~a week of all-topic posts). A feed with no
 * dated item at all (empty, or a 200 challenge page) IS stale.
 * A dead outlet (no recent review) is never flagged: a silent feed is expected.
 */
function isFeedStale({ newestFiltered, filteredCount, newestAny = null, oldestAny = null, latestReviewDate, now = Date.now(), staleDays = FEED_STALE_DAYS, aliveDays = OUTLET_ALIVE_DAYS }) {
  if (!latestReviewDate) return false;
  const reviewMs = Date.parse(latestReviewDate);
  if (isNaN(reviewMs) || now - reviewMs > aliveDays * DAY_MS) return false;
  if (!newestFiltered) {
    if (filteredCount > 0) return false;
    if (!newestAny) return true;
    const oldestMs = Date.parse(oldestAny || newestAny);
    return !isNaN(oldestMs) && now - oldestMs > staleDays * DAY_MS;
  }
  const feedMs = Date.parse(newestFiltered);
  if (isNaN(feedMs)) return false;
  return now - feedMs > staleDays * DAY_MS;
}

module.exports = {
  OUTLET_FEED_HEALTH_REL,
  FEED_STALE_DAYS,
  OUTLET_ALIVE_DAYS,
  newestItemDate,
  oldestItemDate,
  latestReviewDateByOutlet,
  isFeedStale,
  namesShowVenue,
  looksLikeBookReview,
  findMatchingShows,
  deriveQualifyingOutlets,
  mergeAlwaysOnOutlets,
  parseRssFeed,
  looksLikeFeed,
  looksLikeSitemap,
  namesShowCredit,
  parseWpApiPosts,
  parseSitemapXml,
  extractListingUrls,
  buildSerpQuery,
};
