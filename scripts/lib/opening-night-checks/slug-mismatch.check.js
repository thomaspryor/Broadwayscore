'use strict';

const { titleToSlug, KNOWN_ALIASES } = require('../show-matching.js');

const name = 'slug-mismatch';
const description = 'Review URL slug does not mention show slug or any known alias (cross-show contamination)';

// Known Broadway/WE shows whose slugs we should flag when they appear in another show's URL.
// This is the "positive mismatch" case: if a review URL for schmigadoon-2026 contains
// "every-brilliant-thing", that's a red flag even beyond "doesn't mention schmigadoon."
// We derive the list dynamically from shows.json at run time via context.
const STOPWORDS = new Set([
  'review', 'broadway', 'show', 'musical', 'play', 'the', 'a', 'and', 'or',
  'west-end', 'london', 'nyc', 'opens', 'opening', 'stars', 'starring',
  'world', 'premiere', 'tryout', 'tickets',
]);

/**
 * Extract the last "meaningful" path segment(s) from a review URL and return
 * a lowercase slug-style string to search within.
 * e.g., "https://x.com/reviews/some-show-title-on-broadway-2026" → "some-show-title-on-broadway-2026"
 */
function urlSearchSlug(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\.(html?|php|aspx?)$/i, '').replace(/\/$/, '');
    const segments = path.split('/').filter(Boolean);
    return segments.join(' ').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Collect candidate slugs that, if present in the URL, indicate the review is
 * CORRECTLY about this show: the title-derived slug, shows.json slug, alias slugs,
 * and the show id without trailing year suffix.
 */
function buildAcceptSlugs(show) {
  const titleSlug = titleToSlug(show.title || '');
  const slugs = new Set();
  if (show.slug) slugs.add(show.slug.toLowerCase());
  if (titleSlug) slugs.add(titleSlug);
  if (show.id) slugs.add(show.id.replace(/-\d{4}$/, '').toLowerCase());

  // Add aliases that map TO this show (reverse KNOWN_ALIASES lookup)
  const target = (show.slug || titleSlug || '').toLowerCase();
  for (const [alias, canonical] of Object.entries(KNOWN_ALIASES)) {
    if (canonical.toLowerCase() === target) {
      slugs.add(titleToSlug(alias));
    }
  }

  // Per-show URL-slug allowlist for revivals/renamed productions. Example:
  // shows.json can declare `urlAliases: ['the-giant', 'giant-musical']` so a
  // URL like `/giant-musical-review-broadway` is accepted even though the
  // derived slug is `giant`.
  if (Array.isArray(show.urlAliases)) {
    for (const alias of show.urlAliases) {
      if (typeof alias === 'string' && alias.trim()) {
        slugs.add(titleToSlug(alias));
        slugs.add(alias.toLowerCase());
      }
    }
  }

  // Add meaningful single-word tokens from the title (length>=4, not stopwords).
  // This catches "schmigadoon" in longer URLs even if our slug is "schmigadoon".
  for (const token of (show.title || '').toLowerCase().split(/\s+/)) {
    const clean = token.replace(/[^a-z0-9]/g, '');
    if (clean.length >= 4 && !STOPWORDS.has(clean)) slugs.add(clean);
  }

  return Array.from(slugs).filter(Boolean);
}

/**
 * Return true if any accept-slug appears as a whole token in the URL search slug.
 */
// Escape regex metacharacters so a slug (which may contain hyphens and unusual
// punctuation via future aliases) can be embedded literally. The previous
// version had `[\\]` which closed the char class early — `_` and friends were
// left unescaped, and `$`/`|`/`(` in an alias would blow up the RegExp ctor.
function escapeRegex(s) {
  return s.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&');
}

function urlMentionsAnySlug(urlSlug, acceptSlugs) {
  for (const slug of acceptSlugs) {
    // Word-boundary match against slug tokens (hyphen/space-delimited)
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(slug)}($|[^a-z0-9])`, 'i');
    if (re.test(urlSlug)) return true;
  }
  return false;
}

function run(show, context) {
  const reviews = context.reviewsDoc[show.id] || [];
  if (reviews.length === 0) {
    return { ok: true, severity: 'ok', message: 'No reviews yet — skipping slug check' };
  }

  const acceptSlugs = buildAcceptSlugs(show);
  if (acceptSlugs.length === 0) {
    return { ok: true, severity: 'ok', message: 'Could not derive show slugs — skipping' };
  }

  const mismatches = [];
  for (const review of reviews) {
    if (!review.url) continue;
    const urlSlug = urlSearchSlug(review.url);
    if (urlMentionsAnySlug(urlSlug, acceptSlugs)) continue;
    mismatches.push({
      outletId: review.outletId,
      criticName: review.criticName,
      url: review.url,
      urlSlug,
    });
  }

  if (mismatches.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All ${reviews.length} review URL(s) mention show slug`,
    };
  }

  return {
    ok: false,
    severity: 'error',
    message: mismatches.map(m =>
      `Review URL for ${m.outletId}/${m.criticName} does not mention show slug (checked: ${acceptSlugs.join(', ')}): ${m.url}`
    ).join('\n'),
    details: { mismatches, acceptSlugs, showId: show.id },
  };
}

module.exports = { name, description, run, urlSearchSlug, buildAcceptSlugs, urlMentionsAnySlug };
