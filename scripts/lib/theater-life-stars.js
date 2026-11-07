'use strict';
/**
 * theater-life-stars.js — read a Theater Life (theaterlife.com, WordPress)
 * star rating. Shared by scrape-wp-theater-blogs.js and
 * recover-explicit-ratings.js (phase 2) so the two never drift (BRO-305).
 *
 * Theater Life prints the rating in the WP post title ("The Dinosaurs ** 1/2")
 * and again on the review's own footer line under the photo ("The Dinosaurs
 * ** 1/2  Playwrights Horizons, ..."). On a combined multi-show column the
 * title carries one show's star for all of them while each show keeps its own
 * footer line (card #396, BRO-434), so the footer line naming THIS show wins.
 * A title-only star is a fallback labelled 'wp-api-title', the
 * corroboration-gated source the rebuild drops when the ensemble contradicts
 * it (star-reliability.js isUncorroboratedGenericStar, which reads
 * originalScoreSource; the scraper's writer leaves scoreSource alone). The scraper used to stamp it 'wp-api', which no
 * gate knew, so a wrong title star bound the score as if outlet-verified.
 */

const { foldDiacritics } = require('./title-match');
const { decodeHtmlEntities } = require('./text-cleaning');

// Stars may be split by a stray space or tag ("War Paint * **1/2") and may end
// in a fraction: half stars mostly, quarter stars sometimes ("Sets **** 1/4").
const STARS = '([*★](?:\\s?[*★]){0,4})';
const FRACTION = '(?:\\s*(1\\/2|1\\/4|3\\/4|½|¼|¾))?';
// On a footer line the venue follows with no space after a fraction
// ("** 1/2Laura Pels Theatre"), so only a digit or slash ends a fraction there.
const FOOTER_FRACTION = '(?:\\s*([1I]\\/2|1\\/4|3\\/4|½|¼|¾)(?![\\d/]))?';
const TITLE_STARS_RE = new RegExp(`\\s+${STARS}${FRACTION}\\s*$`);
const FRACTION_VALUE = { '1/2': 0.5, 'I/2': 0.5, '½': 0.5, '1/4': 0.25, '¼': 0.25, '3/4': 0.75, '¾': 0.75 };

function toRating(stars, fraction) {
  const n = stars.replace(/\s/g, '').length + (FRACTION_VALUE[fraction] || 0);
  return `${n}/5 stars`;
}

/** "Show Name *** 1/2" -> { cleanTitle: 'Show Name', rating: '3.5/5 stars' }; no stars -> rating null. */
function parseTitleStars(title) {
  const t = String(title || '');
  const m = t.match(TITLE_STARS_RE);
  if (!m) return { cleanTitle: t.trim(), rating: null };
  return { cleanTitle: t.replace(TITLE_STARS_RE, '').trim(), rating: toRating(m[1], m[2]) };
}

function normTitle(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Loose equality: "Gotta Dance!" vs "Gotta Dance", "The Music Man" vs "Music Man". */
function sameTitle(a, b) {
  const x = normTitle(a).replace(/^the /, '');
  const y = normTitle(b).replace(/^the /, '');
  return !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The rating on a "<title> ** 1/2" line in the review body, for one of the
 * given titles (the post title without stars, the matched show's title).
 * A combined column has one such line per show, so only a line naming one of
 * these titles counts. Two different ratings for the same titles -> null.
 */
function footerStars(text, titles) {
  const body = String(text || '');
  if (!body) return null;
  const found = new Set();
  for (const raw of titles || []) {
    const title = String(raw || '').trim();
    if (title.length < 3) continue;
    const pat = escapeRe(title).replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?:^|[\\s"“”'‘’(])${pat}\\s+${STARS}(?![*★])${FOOTER_FRACTION}`, 'gi');
    let m;
    while ((m = re.exec(body)) !== null) {
      // A lowercase word next means prose ("like Cats * the original"), not a
      // footer line. Checked here because the title match is case-insensitive.
      if (!m[2] && /^[ \t\u00a0]+[a-z]/.test(body.slice(re.lastIndex))) continue;
      found.add(toRating(m[1], m[2]));
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * @param {{title: string, text?: string, showTitles?: string[]}} post
 * @returns {{cleanTitle: string, rating: string|null, source: 'wp-api-footer'|'wp-api-title'|null}}
 */
function resolveTheaterLifeStars({ title, text, showTitles = [] }) {
  const { cleanTitle, rating: titleRating } = parseTitleStars(decodeHtmlEntities(String(title || '')));
  const shows = showTitles.map(t => decodeHtmlEntities(String(t || ''))).filter(t => t.trim());
  // The post title names this show's footer only on a single-show post that is
  // about this show; on a combined column it names another show's line.
  const titleIsThisShow = !/[*★]/.test(cleanTitle)
    && (shows.length === 0 || shows.some(t => sameTitle(t, cleanTitle)));
  const footer = footerStars(decodeHtmlEntities(String(text || '')), titleIsThisShow ? [cleanTitle, ...shows] : shows);
  if (footer) {
    // Same whole stars, half only in the title: the footer lost its fraction to
    // a separate tag or a typo the pattern does not read, so keep the half.
    const f = parseFloat(footer);
    const t = titleRating ? parseFloat(titleRating) : NaN;
    const rating = Number.isInteger(f) && Math.floor(t) === f && t > f ? titleRating : footer;
    return { cleanTitle, rating, source: 'wp-api-footer' };
  }
  if (titleRating) return { cleanTitle, rating: titleRating, source: 'wp-api-title' };
  return { cleanTitle, rating: null, source: null };
}

module.exports = { parseTitleStars, footerStars, resolveTheaterLifeStars, decodeEntities: (s) => decodeHtmlEntities(String(s || '')) };
