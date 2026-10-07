'use strict';

/**
 * outlet-ground-truth.js — pure logic for the outlet-listing ground-truth
 * audit (scripts/audit-outlet-ground-truth.js, BRO-4431).
 *
 * The existing coverage audits reason from aggregators (Playbill Verdict, BWW
 * roundups) and from files we already have. Neither sees a review that no
 * aggregator cited and no poller discovered: TheaterMania on Beyond the
 * Stardust, New York Theater on Brooklyn's Bridge, the Reviews Hub and FT on
 * Cleansed. This audit asks the OUTLETS themselves what they reviewed, through
 * listings that answer a plain request (verified from a cloud session and CI
 * runners 2026-09-30): WordPress search APIs (TheaterMania and WhatsOnStage
 * expose reviews as the `news` post type), the NYT daily sitemap pages, and
 * theatre.reviews round-ups (which also list paywalled Times/FT/i reviews,
 * with their star ratings, that have no public link).
 */

const { findMatchingShows } = require('./outlet-listing-helpers');
const { canonicalizeUrlForDedup } = require('./review-guards');
const { normalizeCritic } = require('./review-normalization');

const DAY_MS = 86400000;

// Outlets whose own site we can list. linkFilter keeps review posts only.
const WP_SEARCH_SOURCES = [
  { id: 'theatermania', outletId: 'theatermania', api: 'https://www.theatermania.com/wp-json/wp/v2/news', market: 'nyc', linkFilter: /theatermania\.com\/news\/review-/ },
  { id: 'whatsonstage', outletId: 'whatsonstage', api: 'https://www.whatsonstage.com/wp-json/wp/v2/news', market: 'london', linkFilter: /whatsonstage\.com\/news\/[^/]*-review_\d+/ },
  { id: 'nysr', outletId: 'nysr', api: 'https://nystagereview.com/wp-json/wp/v2/posts', market: 'nyc', linkFilter: /nystagereview\.com\/\d{4}\/\d{2}\/\d{2}\// },
  { id: 'newyorktheater', outletId: 'nyt-theater', api: 'https://newyorktheater.me/wp-json/wp/v2/posts', market: 'nyc', linkFilter: /newyorktheater\.me\/\d{4}\/\d{2}\/\d{2}\/[^/]*-review\/?$/ },
];

function marketOf(category) {
  const c = String(category || '').toLowerCase();
  if (c === 'broadway' || c === 'off-broadway') return 'nyc';
  if (c === 'west-end' || c === 'off-west-end') return 'london';
  return null;
}

/**
 * Shows the audit covers: opened within the last `days` (or opening in the
 * next day, for reviews that drop the night before), in a covered market.
 */
function eligibleShows(shows, { now = Date.now(), days = 21, onlyShow = null } = {}) {
  return shows.filter((s) => {
    if (!s || !s.id || !s.title) return false;
    if (onlyShow) return s.id === onlyShow;
    if (!marketOf(s.category)) return false;
    const od = Date.parse(s.openingDate || '');
    if (!od) return false;
    return od >= now - days * DAY_MS && od <= now + DAY_MS;
  });
}

function wpSearchUrl(api, showTitle, afterIso) {
  const q = String(showTitle || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[:–—].*$/, '').trim();
  const params = new URLSearchParams({ search: q, per_page: '20', _fields: 'link,date,title,excerpt,slug' });
  if (afterIso) params.set('after', afterIso);
  return `${api}?${params.toString()}`;
}

function _strip(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&#8217;|&#8216;|&rsquo;/g, "'").replace(/&#8211;|&#8212;/g, '-')
    .replace(/&amp;|&#038;/g, '&').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Review posts in a WP search response that are about `show`. */
function reviewPostsForShow(posts, show, source) {
  if (!Array.isArray(posts)) return [];
  const out = [];
  for (const p of posts) {
    const link = p && typeof p.link === 'string' ? p.link : '';
    if (!link || !source.linkFilter.test(link)) continue;
    const headline = `${_strip(p.title && p.title.rendered)} ${_strip(p.excerpt && p.excerpt.rendered)}`;
    let slug = '';
    try { slug = new URL(link).pathname; } catch { slug = link; }
    if (findMatchingShows(headline, slug, [show]).length === 0) continue;
    out.push({ url: link, date: p.date ? String(p.date).slice(0, 10) : null, headline: _strip(p.title && p.title.rendered) });
  }
  return out;
}

/** Theater review URLs on an NYT daily sitemap page (https://www.nytimes.com/sitemap/YYYY/MM/DD/). */
function parseNytSitemapDay(html) {
  const seen = new Set();
  const out = [];
  const re = /href="(https:\/\/www\.nytimes\.com\/(\d{4})\/(\d{2})\/(\d{2})\/theater\/([^"#?]+?\.html))"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const slug = m[5];
    // Reviews carry "review" in the slug; Critic's Pick columns too.
    if (!/(^|-)reviews?(-|\.html)/.test(slug)) continue;
    out.push({ url, date: `${m[2]}-${m[3]}-${m[4]}`, slug });
  }
  return out;
}

/** Which of `shows` an NYT review slug is about (single match only). */
function nytShowsForSlug(slug, shows) {
  const cleaned = String(slug || '').replace(/\.html$/, '').replace(/-review(s)?(-|$)/, ' ');
  const matches = findMatchingShows('', cleaned, shows);
  // An ambiguous slug (two shows) is not a ground truth for either.
  return matches.length === 1 ? matches : [];
}

/**
 * Do we already hold this review? `files` are the show's review-texts records.
 * A listed URL matches by canonical URL (incl. previous/alternate URLs). A
 * listing row without a URL (theatre.reviews paywalled entries) matches the
 * same outlet with the same critic, or the same outlet with an unnamed critic.
 */
function _canon(u) {
  const c = canonicalizeUrlForDedup(u) || String(u || '');
  return c.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

function hasReviewFor(files, { url, outletId, critic }) {
  const want = url ? _canon(url) : null;
  for (const f of files || []) {
    if (!f) continue;
    if (want) {
      const urls = [f.url, f.previousUrl, ...(Array.isArray(f.alternateUrls) ? f.alternateUrls : [])];
      if (urls.some((u) => u && _canon(u) === want)) return true;
    }
    // A URL-listed row (outlet's own listing) is only matched by URL; a row
    // naming its critic (theatre.reviews) also matches that critic's file,
    // which may hold no URL (Theatre Record text) or another URL form.
    if (want && !critic) continue;
    if (!outletId || f.outletId !== outletId) continue;
    const fc = normalizeCritic(f.criticName || '');
    const wc = normalizeCritic(critic || '');
    if (!wc || wc === 'unknown' || !fc || fc === 'unknown' || fc === wc) return true;
  }
  return false;
}

module.exports = {
  WP_SEARCH_SOURCES,
  marketOf,
  eligibleShows,
  wpSearchUrl,
  reviewPostsForShow,
  parseNytSitemapDay,
  nytShowsForSlug,
  hasReviewFor,
};
