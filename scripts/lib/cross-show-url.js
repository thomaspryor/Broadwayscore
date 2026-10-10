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
const { foldDiacritics } = require('./title-match');

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

const _genericCache = new Map();
const URL_WORD_TITLES = new Set(['broadway', 'west-end']);
/**
 * {id, title, slug, generic: true} for a show titled with a bare URL path
 * word ("Broadway"), which the index leaves out; else null.
 */
function getGenericTitleShow(showId, showsPath = DEFAULT_SHOWS_PATH) {
  if (!_genericCache.has(showsPath)) {
    const m = new Map();
    try {
      const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      for (const s of showsData.shows || showsData) {
        const slug = slugify(s.title);
        // Only titles that ARE a URL path word. Other excluded titles ("The
        // Visit": reviews say "visit-review-...-chita-rivera") keep the old
        // behaviour; widening to them flagged real reviews.
        if (URL_WORD_TITLES.has(slug)) m.set(s.id, { id: s.id, title: s.title, slug, generic: true });
      }
    } catch {}
    _genericCache.set(showsPath, m);
  }
  return _genericCache.get(showsPath).get(showId) || null;
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
    let thisShow = index.find(s => s.id === showId);
    // A show whose title is itself a generic URL word ("Broadway", 1987) is
    // left out of the index, which used to switch this guard off for it
    // entirely: seven reviews of The Heart of Rock and Roll (".../the-heart-
    // of-rock-and-roll-broadway-review") sat live on Broadway (1987), BRO-4977.
    // Look such a show up anyway; its own generic slug just can't vouch.
    if (!thisShow && !opts.index) {
      const generic = getGenericTitleShow(showId, opts.showsPath || DEFAULT_SHOWS_PATH);
      if (generic) thisShow = generic;
    }
    if (!thisShow) return null;
    const ownSlugVouches = !thisShow.generic;

    // Check if URL contains this show's slug — if yes, no mismatch
    if (ownSlugVouches && urlPath.includes(thisShow.slug)) return null;

    // Also check the show ID slug (without year/market suffix) for partial matches
    const idSlug = showId.replace(/-(?:west-end|off-west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');
    if (ownSlugVouches && idSlug.length >= 8 && urlPath.includes(idSlug)) return null;

    // Normalize connectors (and/the/or) so "romeo-and-juliet" ≈ "romeo-juliet" and
    // "school-girls-or-the-african-mean-girls-play" ≈ "school-girls-african-mean-girls-play"
    // (the URL slugs outlets build drop those connector words; BRO-4267).
    const stripConnectors = s => s.replace(/-(?:and|the|or)(?=-)/g, '');
    const idSlugNorm = stripConnectors(idSlug);
    if (idSlugNorm !== idSlug && idSlugNorm.length >= 8 && urlPath.includes(idSlugNorm)) return null;
    const slugNorm = stripConnectors(thisShow.slug);
    if (slugNorm !== thisShow.slug && slugNorm.length >= 8 && urlPath.includes(slugNorm)) return null;

    // Tokens of THIS show's title that can vouch for a URL when another show's title is
    // contained in this one (see the containment carve-out below). Generic words never vouch.
    const GENERIC_TOKENS = new Set(['and', 'the', 'or', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for',
      'play', 'musical', 'show', 'review', 'reviews', 'broadway', 'theater', 'theatre', 'london', 'west', 'end', 'new', 'live']);
    const thisTokens = new Set([...thisShow.slug.split('-'), ...idSlug.split('-')]
      .filter(t => t.length >= 4 && !GENERIC_TOKENS.has(t)));
    // Skip common URL-path words that would false-positive on nearly every URL
    const URL_PATH_STOPWORDS = new Set(['broadway', 'musical', 'theater', 'theatre', 'review', 'reviews', 'london', 'west-end', 'off-broadway']);

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
      // Containment: the other show's title sits INSIDE this show's title ("Mean Girls" inside
      // "School Girls; Or, The African Mean Girls Play"), so a URL for this show naturally
      // carries the other show's slug. Only call it a mismatch when the URL carries none of
      // this show's own distinctive tokens. School Girls opening night 2026-09-28 lost the
      // Guardian, Culture Sauce and Chicago Tribune reviews to this (BRO-4267).
      const contained = thisShow.slug.includes(other.slug) || idSlug.includes(otherIdSlug) || idSlugNorm.includes(otherIdSlugNorm);
      if (contained) {
        const otherTokens = new Set([...other.slug.split('-'), ...otherIdSlug.split('-')]);
        const vouching = [...thisTokens].filter(t => !otherTokens.has(t));
        // Whole path words only: "school" must not match "preschool".
        const hasWord = t => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(urlPath);
        const present = vouching.filter(hasWord);
        // One word is not enough: a real Mean Girls review whose slug happens to say
        // "high-school" must still be caught. Two of this show's own words (or all of
        // them when it has only one) have to appear before the URL is trusted...
        const needed = Math.min(2, vouching.length);
        if (needed > 0 && present.length >= needed) continue;
        // ...unless the URL reproduces this show's own phrase around the contained
        // title: the word that sits right next to the other show's title in THIS slug,
        // kept together the same way ("african-mean-girls" is School Girls' subtitle;
        // "mean-girls-high-school" and "mean-girls-school-edition" are not).
        if (present.length > 0) {
          const phrases = [];
          for (const [container, part] of [[thisShow.slug, other.slug], [idSlug, otherIdSlug], [idSlugNorm, otherIdSlugNorm]]) {
            const at = part ? container.indexOf(part) : -1;
            if (at < 0) continue;
            const before = container.slice(0, at).split('-').filter(Boolean).pop();
            const after = container.slice(at + part.length).split('-').filter(Boolean)[0];
            if (before && present.includes(before)) phrases.push(`${before}-${part}`);
            if (after && present.includes(after)) phrases.push(`${part}-${after}`);
          }
          if (phrases.some(p => urlPath.includes(p))) continue;
        }
      }
      if (urlPath.includes(other.slug)) {
        return { matchedShowId: other.id, matchedTitle: other.title, showTitle: thisShow.title };
      }
      // Also check a base-title slug (first significant words of the title, without
      // parentheticals or subtitles). Catches shows with long qualified slugs like
      // "monte-cristo-the-york-theatre-company-off-broadway" where a URL containing
      // just "monte-cristo" wouldn't match the full slug.
      const baseTitle = (other.title || '').replace(/\s*\(.*?\)/g, '').replace(/:\s.*$/, '')
        .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
