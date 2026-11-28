'use strict';
/**
 * BRO-6487: free candidate discovery for West End historical review slots from
 * an outlet's monthly article sitemaps (no search spend). The Evening Standard
 * publishes /sitemaps/sitemap-articles-YYYY-MM.xml back to 2012; its theatre
 * reviews carry slugs like "the-scottsboro-boys-young-vic-theatre-review-8912729".
 * Candidates only: every URL still goes through ingest-review-from-url.js with
 * the show's date window, --require-publish-date and the title-in-body guard.
 * Pure, no I/O (CLAUDE.md §15): we-sitemap-candidates.test.mjs.
 */
const { norm, addDays } = require('./we-major-recovery.js');

const STOP = new Set(['theatre', 'review', 'west', 'end', 'london', 'the', 'a', 'an', 'at', 'of', 'and', 'musical', 'play', 'new']);
const words = (s) => norm(s).split(' ').filter(Boolean);

/** Months (YYYY-MM) touched by [lo, hi] (YYYY-MM-DD). */
function monthsBetween(lo, hi) {
  const out = [];
  let [y, m] = lo.slice(0, 7).split('-').map(Number);
  const [ey, em] = hi.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** The <loc> URLs of a sitemap document that look like Standard theatre reviews. */
function standardReviewUrls(xml) {
  const urls = [];
  for (const m of String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const u = m[1].trim();
    if (/^https:\/\/www\.standard\.co\.uk\/(culture\/theatre|going-out\/theatre|theatre)\/[^/]*-review[^/]*-[a-z]?\d+\.html$/.test(u)) urls.push(u);
  }
  return urls;
}

/**
 * Slug -> { titleHit, rest } when the slug starts with the show's title words.
 * rest = the words between the title and "theatre review" (usually the venue).
 */
function slugParts(url, show) {
  const slug = url.split('/').pop().replace(/-[a-z]?\d+\.html$/, '').replace(/-(theatre-)?review(-.*)?$/, '').replace(/-review-.*$/, '');
  const sw = words(slug.replace(/-/g, ' '));
  const tw = words(show.title);
  if (tw.length === 0 || sw.length < tw.length) return null;
  for (let i = 0; i < tw.length; i++) if (sw[i] !== tw[i]) return null;
  return { rest: sw.slice(tw.length).filter((w) => !STOP.has(w)) };
}

const venueWords = (v) => words(v).filter((w) => !STOP.has(w));

/** The slug's venue and the show's venue name the same place: equal, or one contains the other (a long-enough name). A shared word is not enough (Old Vic / Young Vic). */
function venueSlugAgrees(slugKey, venueKey) {
  if (!slugKey || !venueKey) return false;
  if (slugKey === venueKey) return true;
  const [short, long] = slugKey.length <= venueKey.length ? [slugKey, venueKey] : [venueKey, slugKey];
  return short.length >= 7 && long.includes(short);
}

/** Headline-form slugs carry no venue, so the fetched article body must name the show's venue. */
function bodyNamesVenue(body, venue) {
  const v = venueWords(venue).join(' ');
  return !v || norm(body).includes(v);
}

/**
 * Candidate URLs for one show from the sitemap URLs of the months its window
 * touches. A slug naming a venue must agree with the show's venue (a same-titled
 * production elsewhere is another production). A bare-title slug is kept only as
 * the single title hit; two same-title reviews in the window are ambiguous.
 */
function matchStandardSlugs(show, urls) {
  if (!show || !show.title || norm(show.title).length < 3) return [];
  const venueKey = venueWords(show.venue).join('');
  const confirmed = [];
  const bare = [];
  for (const u of urls) {
    const p = slugParts(u, show);
    if (!p) continue;
    if (!p.rest.length) bare.push(u);
    else if (venueSlugAgrees(p.rest.join(''), venueKey)) confirmed.push(u);
  }
  if (confirmed.length) return confirmed.length <= 3 ? confirmed : [];
  // Headline-form slugs (2015+) carry no venue: keep one only when it is the sole title hit (same rule as the WoS matcher).
  return bare.length === 1 ? bare : [];
}

/** Date window the candidates are drawn from (matches the Guardian rule, first performance based). */
function candidateWindow(show) {
  const first = show.previewsStartDate || show.openingDate;
  return first ? { lo: addDays(first, -14), hi: addDays(first, 75) } : null;
}

module.exports = { venueSlugAgrees, bodyNamesVenue, monthsBetween, standardReviewUrls, slugParts, matchStandardSlugs, candidateWindow };
