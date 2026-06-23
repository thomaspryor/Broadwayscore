/**
 * Cross-show URL slug guard — single source of truth.
 *
 * Detects when a review's URL slug clearly names a DIFFERENT show than the one
 * it is filed under (e.g. an `every-brilliant-thing` URL stored in the
 * `schmigadoon-2026` directory). This is the canonical implementation; both the
 * ingest-time guard (scripts/gather-reviews.js createReviewFile) and the
 * corpus-wide audit (scripts/audit-cross-show-url.js) MUST call this — never
 * reimplement the slug comparison. Naive reimplementations repeatedly produced
 * the same false-positive classes this function already filters:
 *   - common URL-path words ("/broadway/", "/theater/") matching short slugs
 *   - same-play different-production (Romeo & Juliet revivals, Harry Potter
 *     parts, Encores! La Cage) where the play name legitimately recurs
 * Extracted verbatim from gather-reviews.js on 2026-06-23 after a BWW scrape
 * bypassed the ingest-only guard and mis-filed 11 Every Brilliant Thing reviews
 * under Schmigadoon. See memory/feedback (cross-show URL guard).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Slugs that are too generic / collision-prone to use as a cross-show signal.
const CROSS_SHOW_SLUG_EXCLUDE = new Set([
  'broadway', 'west-end', 'the-story', 'romantic-comedy', 'the-red-shoes',
  'les-miserables', 'once-in-a-lifetime', 'body-count', 'the-car-man',
  'good-night-oscar', 'the-visit', 'the-outsiders', 'the-notebook',
]);

const _indexCache = new Map();

/**
 * Build the {id,title,slug} index from a shows array (pure, no IO).
 */
function buildShowSlugIndex(shows) {
  const index = [];
  for (const s of shows || []) {
    const slug = slugify(s.title);
    if (slug.length >= 8 && !CROSS_SHOW_SLUG_EXCLUDE.has(slug)) {
      index.push({ id: s.id, title: s.title, slug });
    }
  }
  return index;
}

/**
 * Cached slug index keyed by shows.json path.
 */
function getShowSlugIndex(showsPath = DEFAULT_SHOWS_PATH) {
  if (_indexCache.has(showsPath)) return _indexCache.get(showsPath);
  let index = [];
  try {
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const shows = showsData.shows || showsData;
    index = buildShowSlugIndex(shows);
  } catch {}
  _indexCache.set(showsPath, index);
  return index;
}

/**
 * @param {string} showId   show the review is currently filed under
 * @param {string} url      the review URL
 * @param {object} [opts]   { showsPath, index } — inject an index for tests
 * @returns {null | { matchedShowId, matchedTitle, showTitle }}
 */
function detectCrossShowUrlMismatch(showId, url, opts = {}) {
  if (!url) return null;
  try {
    const urlPath = new URL(url).pathname.toLowerCase();
    const index = opts.index || getShowSlugIndex(opts.showsPath || DEFAULT_SHOWS_PATH);
    const thisShow = index.find(s => s.id === showId);
    if (!thisShow) return null;

    // Check if URL contains this show's slug — if yes, no mismatch
    if (urlPath.includes(thisShow.slug)) return null;

    // Also check the show ID slug (without year/market suffix) for partial matches
    const idSlug = showId.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
    if (idSlug.length >= 8 && urlPath.includes(idSlug)) return null;

    // Normalize connectors (and/the) so "romeo-and-juliet" ≈ "romeo-juliet"
    const stripConnectors = s => s.replace(/-(?:and|the)-/g, '-');
    const idSlugNorm = stripConnectors(idSlug);
    if (idSlugNorm !== idSlug && idSlugNorm.length >= 8 && urlPath.includes(idSlugNorm)) return null;

    // Check if URL contains a different show's slug
    for (const other of index) {
      if (other.id === showId) continue;
      // Skip shows that share a base title with this show (same slug or prefix relationship)
      const otherIdSlug = other.id.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
      if (otherIdSlug === idSlug) continue;
      // Skip if connector-normalized slugs match (e.g., "romeo-and-juliet" ≈ "romeo-juliet")
      const otherIdSlugNorm = stripConnectors(otherIdSlug);
      if (otherIdSlugNorm === idSlugNorm) continue;
      // Skip if one show's slug is a prefix of the other (e.g., "kinky-boots" vs "kinky-boots-the-musical")
      if (thisShow.slug.startsWith(other.slug) || other.slug.startsWith(thisShow.slug)) continue;
      if (idSlug.startsWith(otherIdSlug) || otherIdSlug.startsWith(idSlug)) continue;
      if (urlPath.includes(other.slug)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
      // Also check a base-title slug (first significant words of the title, without
      // parentheticals or subtitles). Catches shows with long qualified slugs like
      // "monte-cristo-the-york-theatre-company-off-broadway" where a URL containing
      // just "monte-cristo" wouldn't match the full slug.
      const baseTitle = (other.title || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '')
        .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // Skip common URL-path words that would false-positive on nearly every URL
      const URL_PATH_STOPWORDS = new Set(['broadway', 'musical', 'theater', 'theatre', 'review', 'reviews', 'london', 'west-end', 'off-broadway']);
      if (baseTitle.length >= 6 && !URL_PATH_STOPWORDS.has(baseTitle)
          && baseTitle !== idSlug
          && !idSlug.startsWith(baseTitle) && !baseTitle.startsWith(idSlug)
          && urlPath.includes(baseTitle)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
    }
  } catch {}
  return null;
}

module.exports = {
  slugify,
  CROSS_SHOW_SLUG_EXCLUDE,
  buildShowSlugIndex,
  getShowSlugIndex,
  detectCrossShowUrlMismatch,
};
