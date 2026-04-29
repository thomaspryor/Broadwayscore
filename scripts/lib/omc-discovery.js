/**
 * One Minute Critic Direct Discovery
 *
 * OMC's canonical domain is `1minutecritic.com` (not the older
 * `oneminutecritic.com` alias — both are mapped in outlet-registry.json
 * under the `one-minute-critic` outletId). They have a working WordPress
 * RSS feed at `/feed/` that ships full content + dc:creator bylines, and
 * theater reviews follow a stable URL slug pattern: `*-review/`,
 * `*-broadway-review/`, `*-off-broadway-review/`, or
 * `*-review-{theater-slug}/`. Books, albums, and TV reviews use the
 * same `-review/` suffix, so we filter on `<category>` tags + show
 * title-match.
 *
 * Pre-this-lib, OMC required manual ingest every opening night
 * (Giant, Cats, Fallen Angels). No SERP coverage, no aggregator pickup.
 *
 * Public API: `discoverNewReviews(showId, show, since)` →
 *   Promise<Array<{url, outlet, outletId, criticName, publishDate, title}>>
 */

const { fetchPage } = require('./scraper');

const OMC_FEED_URL = 'https://1minutecritic.com/feed/';
const OUTLET_ID = 'one-minute-critic';
const OUTLET_NAME = '1 Minute Critic';

// Categories that mark non-theater reviews. OMC reviews books, albums, TV, and
// film alongside theater. Exclude these without trying to enumerate every theater
// term — false-negatives (theater post mis-tagged) are recoverable, but a book
// review masquerading as a theater review is not (it'd score-merge wrong).
const NON_THEATER_CATEGORIES = new Set([
  'books',
  'book',
  'memoir',
  'biography',
  'fiction',
  'nonfiction',
  'non-fiction',
  'tv',
  'television',
  'film',
  'movies',
  'movie',
  'music',
  'album',
  'albums',
]);

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8212;/g, '-')
    .replace(/&#8211;/g, '-')
    // WordPress RSS double-encodes & as &#038; (URL params: utm_source=rss&#038;utm_medium=rss).
    // Order matters: decode &#038; BEFORE &amp; so the result is a single ampersand,
    // not a literal "&amp;" left over. Apply numeric form before named form for safety.
    .replace(/&#038;/g, '&')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-');
}

// Strip RSS tracking parameters so the URL is fetchable + dedups correctly
// against existing files. We deliberately keep the protocol/host so URL.parse
// succeeds downstream (review-normalization.normalizeUrl strips the scheme,
// which is fine for canonical comparison in dedup but breaks `new URL(x)` here).
// Downstream pipeline (gather-reviews / processDiscoveredReviews) calls
// normalizeUrl for the final canonical form.
function cleanUrl(url) {
  try {
    const u = new URL(url);
    const drop = [];
    for (const key of u.searchParams.keys()) {
      if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid' || key === 'mc_cid' || key === 'mc_eid') drop.push(key);
    }
    for (const k of drop) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleM = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkM = block.match(/<link[^>]*>([\s\S]*?)<\/link>/);
    const dateM = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    const creatorM = block.match(/<dc:creator[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/);
    const cats = [];
    const catRegex = /<category[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g;
    let cm;
    while ((cm = catRegex.exec(block)) !== null) {
      cats.push(cm[1].trim());
    }
    if (titleM && linkM) {
      const pub = dateM && dateM[1] ? new Date(dateM[1].trim()) : null;
      // RSS double-escapes ampersands as &#038; — decode entities BEFORE
      // cleanUrl so URL params parse and dedup correctly.
      const linkRaw = decodeEntities(linkM[1].trim());
      items.push({
        title: decodeEntities(titleM[1].trim()),
        link: cleanUrl(linkRaw),
        pubDate: pub && !isNaN(pub.getTime()) ? pub : null,
        creator: creatorM ? decodeEntities(creatorM[1].trim()) : null,
        categories: cats.map((c) => decodeEntities(c).toLowerCase()),
      });
    }
  }
  return items;
}

// Title-match: 80% of significant words must appear with word boundaries.
// Done in-house because rss-discovery.js's titleMatchesShow has a known
// curly-apostrophe bug (line 188: `/['']/g` is two ASCII apostrophes, not
// the curly pair) that misses headlines with &#8217;. Our decodeEntities
// already folds curly→ASCII so a word-boundary match is safe.
function normalize(t) {
  return t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatchesOnce(itemTitle, showTitle) {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'at', 'on', 'to', 'for']);
  const showWords = normalize(showTitle).split(' ').filter((w) => w.length > 1 && !stop.has(w));
  if (showWords.length === 0) return false;
  const hay = normalize(itemTitle);
  const wordMatch = (h, w) => {
    const escaped = w.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    return new RegExp("(?:^|[\\s\\-/.'\"_])" + escaped + "(?:$|[\\s\\-/.'\"_])", 'i').test(h);
  };
  const matched = showWords.filter((w) => wordMatch(hay, w)).length;
  return matched >= Math.ceil(showWords.length * 0.8);
}

// Subtitle-prefix extraction with a guard against dangerous 1-word collapses.
// See identical helper in theatermania-discovery.js for rationale (ship-check P0:
// "Inherit, the Wind" → "Inherit", "Hello, Dolly!" → "Hello", etc. — false-match
// any feed item containing those words). Em-dash subtitle: always safe.
// Comma+article ("Beaches, A New Musical"): split, BUT require ≥2 sig words.
function safeSubtitlePrefix(showTitle) {
  if (!showTitle) return null;
  if (showTitle.includes(' - ')) {
    const p = showTitle.split(' - ')[0].trim();
    if (p.length >= 3 && p !== showTitle) return p;
  }
  const m = showTitle.match(/^(.+?),\s+(?:[Aa]|[Aa]n|[Tt]he|[Oo]r)\s+\S/);
  if (m) {
    const p = m[1].trim();
    const stop = new Set(['the','a','an','of','and','in','at','on','to','for']);
    const sigWords = p.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stop.has(w));
    if (sigWords.length >= 2 && p.length >= 3 && p !== showTitle) return p;
  }
  return null;
}

function titleMatches(itemTitle, showTitle) {
  if (titleMatchesOnce(itemTitle, showTitle)) return true;
  const primary = safeSubtitlePrefix(showTitle);
  if (primary) return titleMatchesOnce(itemTitle, primary);
  return false;
}

/**
 * Discover new OMC reviews for a show.
 *
 * @param {string} showId
 * @param {{ title: string, category?: string, openingDate?: string, previewsStartDate?: string }} show
 * @param {Date} [since] - Lower bound on publishDate.
 * @param {Object} [options]
 * @param {boolean} [options.verbose]
 * @returns {Promise<Array<{url, outlet, outletId, criticName, publishDate, title}>>}
 */
async function discoverNewReviews(showId, show, since, options = {}) {
  const { verbose = false } = options;
  if (!show || !show.title) return [];

  // Dateless-show guard: without an anchor, the default 30-day lookback can
  // ingest arbitrary current OMC reviews — ship-check P0.
  const opening = show.openingDate ? new Date(show.openingDate) : null;
  const previews = show.previewsStartDate ? new Date(show.previewsStartDate) : null;
  if (!opening && !previews && !(since instanceof Date && !isNaN(since.getTime()))) {
    if (verbose) console.log(`  [OMC-discovery] skip ${showId}: no openingDate/previewsStartDate/since anchor`);
    return [];
  }

  const DAY = 86400000;
  const sinceDate =
    since instanceof Date && !isNaN(since.getTime())
      ? since
      : previews
        ? new Date(previews.getTime() - 3 * DAY)
        : new Date(opening.getTime() - 7 * DAY);
  const untilDate = opening
    ? new Date(opening.getTime() + 30 * DAY)
    : new Date(Date.now() + DAY);

  // fetchPage: Playwright/BD/SB fallback chain (per scraper architecture rule).
  let xml;
  try {
    const result = await fetchPage(OMC_FEED_URL, { skipVerify: true });
    xml = (result && result.content) || '';
  } catch (err) {
    if (verbose) console.log(`  [OMC-discovery] fetch error: ${err.message}`);
    return [];
  }
  if (!xml) return [];

  const items = parseRssItems(xml);
  const hits = [];
  for (const item of items) {
    if (!item.link) continue;

    // URL pattern guard — OMC reviews use `{show-slug}-review/` or
    // `{show-slug}-review-{theater-or-star}/`. Excludes /tag/, /category/,
    // /author/. Also excludes year-in-review/listicle slugs that share the
    // suffix (`/year-in-review/`, `/2025-in-review/`, `/our-review-of-X/`,
    // `/best-of-Y-review/`) — flagged by ship-check P1.
    const path = (() => {
      try {
        return new URL(item.link).pathname.toLowerCase();
      } catch {
        return '';
      }
    })();
    if (!/-review(?:-[a-z0-9-]+)?\/?$/.test(path)) continue;
    // Reject listicle/year-end patterns. These are review-themed but not
    // single-show critic reviews.
    const NON_REVIEW_SLUG_PATTERNS = [
      /\byear-in-review\b/,
      /\b\d{4}-in-review\b/, // 2025-in-review, 2024-in-review, etc.
      /\bin-review\/?$/, // catches plain "in-review/" tail
      /\bour-review\b/,
      /\bbest-of-[a-z0-9-]+-review\b/,
      /\breview-(?:roundup|recap|wrap)\b/,
    ];
    if (NON_REVIEW_SLUG_PATTERNS.some((re) => re.test(path))) {
      if (verbose) console.log(`  [OMC-discovery] skip listicle/roundup: ${item.link}`);
      continue;
    }

    // Date window
    if (item.pubDate) {
      if (item.pubDate < sinceDate) continue;
      if (item.pubDate > untilDate) continue;
    }

    // Non-theater category filter (book/album/film/TV reviews share the
    // -review/ slug). If the only category overlap is non-theater, skip.
    const cats = item.categories || [];
    if (cats.length > 0) {
      const hasNonTheater = cats.some((c) => NON_THEATER_CATEGORIES.has(c));
      // hasNonTheater alone isn't a kill (a Broadway review tagged "Books" by
      // mistake should still be considered) — but if the URL slug has no
      // theater anchor AND there's a non-theater category, skip.
      const slugAnchorsTheater =
        path.includes('-broadway-') ||
        path.includes('-off-broadway-') ||
        path.includes('-west-end-') ||
        path.includes('-musical-');
      if (hasNonTheater && !slugAnchorsTheater) {
        if (verbose) console.log(`  [OMC-discovery] skip non-theater: ${item.title}`);
        continue;
      }
    }

    // Title match against the show name
    if (!titleMatches(item.title, show.title)) continue;

    hits.push({
      url: item.link,
      outlet: OUTLET_NAME,
      outletId: OUTLET_ID,
      criticName: item.creator || undefined,
      publishDate: item.pubDate ? item.pubDate.toISOString().slice(0, 10) : null,
      title: item.title,
      source: 'omc-discovery',
    });
  }

  if (verbose) {
    console.log(
      `  [OMC-discovery] ${hits.length} hits for "${show.title}" (${sinceDate.toISOString().slice(0, 10)}..${untilDate.toISOString().slice(0, 10)})`
    );
  }
  return hits;
}

module.exports = {
  discoverNewReviews,
  OUTLET_ID,
  OUTLET_NAME,
  OMC_FEED_URL,
  // Exported for test reuse:
  parseRssItems,
  titleMatches,
};
