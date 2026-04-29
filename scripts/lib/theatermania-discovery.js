/**
 * TheaterMania Direct Discovery
 *
 * Polls the TheaterMania WordPress REST API directly for reviews —
 * decoupled from DTLI / SERP. TM URLs use opaque numeric IDs
 * (`/news/review-{slug}_{id}/`) which makes SERP slug-matching
 * unreliable, and DTLI was the only path until this lib.
 *
 * Endpoint: `/wp-json/wp/v2/news?categories=157` (Reviews category, verified
 * 2026-04-29). Each item has { date, link, title.rendered }. The site-search
 * layer in `site-search-discovery.js` also uses this endpoint, but with a
 * tight ±3-day window. This lib widens to opening-window+lookback so it can
 * be reused as a fallback when site-search's narrow window misses the post.
 *
 * Public API: `discoverNewReviews(showId, show, since)` →
 *   Promise<Array<{url, outlet, outletId, criticName?, publishDate, title}>>
 *
 * Critics are NOT extracted here — the TM REST API doesn't ship dc:creator
 * cheaply (would need _embed=author + a second join). collect-review-texts.js
 * already extracts the byline from the article page, so leaving criticName
 * undefined here is correct: rebuild merges the byline at text-collection
 * time. (See feedback_rss_discovery_pending_strand.md — that strand is
 * about RSS+'Unknown' criticName routing into _pending. Here, criticName is
 * undefined, not 'Unknown'; routing is gated on the literal 'Unknown'.)
 */

const { fetchJSON } = require('./scraper');
const { titleMatchesShow } = require('./rss-discovery');

// Try the full title; if it fails, fall back to "primary title" extracted by
// safeSubtitlePrefix. Comma-internal titles ("Hello, Dolly!", "Caroline, or
// Change", "Inherit, the Wind") collapse to dangerously generic 1-word
// primaries ("Hello", "Caroline", "Inherit") that false-match anything in the
// feed window — ship-check P0. So:
//
//   - " - " (em-dash) is always a safe subtitle separator (mirrors url-
//     discovery.js's primaryTitle convention).
//   - ", A "/", An "/", ", The "/", or " comma+article patterns are subtitle-
//     like — split, BUT require the primary to have ≥2 significant words after
//     stop-filter. Drops Beaches' bare-"Beaches" fallback (1 word) but keeps
//     "A Beautiful Noise, The Neil Diamond Musical" → "A Beautiful Noise".
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

function titleMatchesShowOrPrimary(itemTitle, showTitle) {
  if (!itemTitle || !showTitle) return false;
  if (titleMatchesShow(itemTitle, showTitle)) return true;
  const primary = safeSubtitlePrefix(showTitle);
  if (primary) return titleMatchesShow(itemTitle, primary);
  return false;
}

// per_page=100 is WP's max — accommodates long opening windows
// (openingDate ± 30d) without truncation. The Reviews category publishes
// ~1-2 posts/day on busy weeks; 100 is comfortable headroom.
const TM_REST_REVIEWS_URL =
  'https://www.theatermania.com/wp-json/wp/v2/news?categories=157&per_page=100&_fields=link,date,title';

const OUTLET_ID = 'theatermania';
const OUTLET_NAME = 'TheaterMania';

// Curly→straight quote/dash normalization — done here (not just entity decoding)
// because rss-discovery.js's titleMatchesShow has a known apostrophe-class bug
// (line 188: /['']/g is two ASCII apostrophes, doesn't fold curly variants).
// Folding here keeps the helper usable for TM headlines containing &#8217;.
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
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-');
}

/**
 * Discover new TM reviews for a show.
 *
 * @param {string} showId
 * @param {{ title: string, openingDate?: string, previewsStartDate?: string }} show
 * @param {Date} [since] - Lower bound on publishDate. Default: openingDate-7d
 *   (or 30d ago if no openingDate).
 * @param {Object} [options]
 * @param {boolean} [options.verbose]
 * @returns {Promise<Array<{url, outlet, outletId, publishDate, title}>>}
 */
async function discoverNewReviews(showId, show, since, options = {}) {
  const { verbose = false } = options;
  if (!show || !show.title) return [];

  // Dateless-show guard: without an openingDate or previewsStartDate, the
  // default 30-day lookback can ingest arbitrary current TM reviews — a
  // ship-check P0 (any title-match coincidence in the open feed window
  // would flow through). Only run when at least one anchor date is set.
  const opening = show.openingDate ? new Date(show.openingDate) : null;
  const previews = show.previewsStartDate ? new Date(show.previewsStartDate) : null;
  if (!opening && !previews && !(since instanceof Date && !isNaN(since.getTime()))) {
    if (verbose) console.log(`  [TM-discovery] skip ${showId}: no openingDate/previewsStartDate/since anchor`);
    return [];
  }

  // Default lookback: prefer previewsStartDate-3d, fall back to openingDate-7d.
  // Matches the windowing used by aggregator polling.
  const DAY = 86400000;
  const sinceDate =
    since instanceof Date && !isNaN(since.getTime())
      ? since
      : previews
        ? new Date(previews.getTime() - 3 * DAY)
        : new Date(opening.getTime() - 7 * DAY);

  // Upper bound: openingDate+30d, else now+1d. Prevents stale-cache surprises.
  const untilDate = opening
    ? new Date(opening.getTime() + 30 * DAY)
    : new Date(Date.now() + DAY);

  const after = sinceDate.toISOString();
  const before = untilDate.toISOString();
  const url = `${TM_REST_REVIEWS_URL}&after=${after}&before=${before}`;

  // fetchJSON: ScrapingBee → direct fallback (per scraper architecture rule).
  let posts;
  try {
    posts = await fetchJSON(url);
  } catch (err) {
    if (verbose) console.log(`  [TM-discovery] fetch error: ${err.message}`);
    return [];
  }

  if (!Array.isArray(posts)) return [];

  const hits = [];
  for (const p of posts) {
    if (!p || !p.link) continue;
    const title = decodeEntities((p.title && p.title.rendered) || '');
    if (!title) continue;

    // Title must contain the show name (handles co-running productions in the
    // same window). 80% word-boundary rule, with subtitle-fallback so
    // "Beaches, A New Musical" matches the bare "Beaches" review headline.
    if (!titleMatchesShowOrPrimary(title, show.title)) continue;

    // The "Reviews" category (157) reliably gates content type for new posts;
    // require the URL to look like a review post. Old TM URL patterns
    // (/off-broadway/reviews/...) also pass.
    const u = p.link.toLowerCase();
    const looksReviewish =
      u.includes('/news/review-') ||
      u.includes('/reviews/') ||
      u.match(/_\d{6,}\/?$/); // numeric-id slug
    if (!looksReviewish) continue;

    hits.push({
      url: p.link,
      outlet: OUTLET_NAME,
      outletId: OUTLET_ID,
      publishDate: p.date ? p.date.slice(0, 10) : null,
      title,
      source: 'theatermania-discovery',
    });
  }

  if (verbose) {
    console.log(`  [TM-discovery] ${hits.length} hits for "${show.title}" (${after.slice(0, 10)}..${before.slice(0, 10)})`);
  }
  return hits;
}

module.exports = {
  discoverNewReviews,
  OUTLET_ID,
  OUTLET_NAME,
  TM_REST_REVIEWS_URL,
};
