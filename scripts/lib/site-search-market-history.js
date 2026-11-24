'use strict';
/**
 * Paid site-search renders in markets the outlet has never covered (BRO-8268).
 *
 * The JS site-search tier (deadline, THR, ew, timeout, ...) pays a ScrapingBee
 * render (5 credits; ew tries 1 Scrapingdog credit first) for every missing
 * outlet on every poll tick, in every market. Ledger 2026-11-22..24: 420 of
 * 1,811 such renders (2,100 credits, ~9% of all ScrapingBee use) were for an
 * outlet website with ZERO reviews in that show category across all of
 * reviews.json: deadline.com on West End shows (126), ew.com on West End,
 * off-West-End, regional and tour shows (132), hollywoodreporter.com on
 * regional, tour and off-West-End shows (72), timeout.com on tours (11). The
 * ScrapingBee plan ($49.99 / 250k) ran out after 18 days that cycle and
 * auto-renewed early, so these credits cost real money.
 *
 * Rule: skip the PAID render when the endpoint's website has no review at all
 * in the show's category, and the category is big enough for "none" to mean
 * something. Counted by review URL hostname, not outletId, because one search
 * page can serve two outlet ids (timeout.com is Time Out New York and Time Out
 * London). The free WordPress search still runs, SERP discovery still covers
 * the outlet, and a small random audit sample still pays for the render, so a
 * first-ever review in a new market is still found and opens the gate.
 *
 * Fails open: unreadable data, unknown category, small category, or a domain
 * we cannot normalise all mean "render as before".
 * Kill switch: SITE_SEARCH_MARKET_HISTORY_GATE=0.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_CATEGORY_REVIEWS = 500;
const DEFAULT_AUDIT_RATE = 0.05;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function normaliseHost(h) {
  return String(h || '').toLowerCase().replace(/^www\./, '');
}

function hostOfUrl(url) {
  try { return normaliseHost(new URL(url).hostname); } catch { return ''; }
}

/**
 * @param {Array<{showId: string, url?: string}>} reviews
 * @param {(showId: string) => string|null} categoryOfShow
 * @returns {{byCategory: Map<string, Map<string, number>>, totals: Map<string, number>}}
 */
function buildDomainCategoryCounts(reviews, categoryOfShow) {
  const byCategory = new Map();
  const totals = new Map();
  for (const r of reviews || []) {
    if (!r || !r.url) continue;
    const category = categoryOfShow(r.showId);
    if (!category) continue;
    const host = hostOfUrl(r.url);
    if (!host) continue;
    totals.set(category, (totals.get(category) || 0) + 1);
    if (!byCategory.has(category)) byCategory.set(category, new Map());
    const m = byCategory.get(category);
    m.set(host, (m.get(host) || 0) + 1);
  }
  return { byCategory, totals };
}

/** Reviews in this category whose host is the domain or one of its subdomains. */
function domainCount(hostCounts, domain) {
  if (!hostCounts) return 0;
  const d = normaliseHost(domain);
  let n = 0;
  for (const [host, c] of hostCounts) {
    if (host === d || host.endsWith('.' + d)) n += c;
  }
  return n;
}

/**
 * Pure decision.
 * @returns {{skip: boolean, reason: string, count: number|null}}
 */
function neverCoveredMarketDecision({ domain, category, counts, minCategoryReviews = DEFAULT_MIN_CATEGORY_REVIEWS, env = process.env }) {
  if (env && env.SITE_SEARCH_MARKET_HISTORY_GATE === '0') return { skip: false, reason: 'disabled', count: null };
  if (!counts || !counts.byCategory || !counts.totals) return { skip: false, reason: 'no-data', count: null };
  if (!category || !domain) return { skip: false, reason: 'unknown-category-or-domain', count: null };
  const total = counts.totals.get(category) || 0;
  if (total < minCategoryReviews) return { skip: false, reason: 'small-category', count: null };
  const count = domainCount(counts.byCategory.get(category), domain);
  return count === 0
    ? { skip: true, reason: 'never-covered', count }
    : { skip: false, reason: 'covered', count };
}

/** SITE_SEARCH_MARKET_HISTORY_AUDIT: share of skips that still render (0..1). */
function resolveAuditRate(env = process.env) {
  const v = env && env.SITE_SEARCH_MARKET_HISTORY_AUDIT;
  if (v === undefined || v === '') return DEFAULT_AUDIT_RATE;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_AUDIT_RATE;
}

let _cache; // undefined = not loaded yet, null = unavailable (fail open)
/** Reads reviews.json + shows.json once per process; null when either is unreadable. */
function loadDomainCategoryCounts(dataDir = DATA_DIR) {
  if (_cache !== undefined && dataDir === DATA_DIR) return _cache;
  let out = null;
  try {
    const reviewsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
    const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : reviewsRaw.reviews;
    const showsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
    const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
    if (Array.isArray(reviews) && reviews.length && Array.isArray(shows) && shows.length) {
      const cat = new Map(shows.map(s => [s.id, s.category || null]));
      out = buildDomainCategoryCounts(reviews, id => cat.get(id) || null);
    }
  } catch {
    out = null;
  }
  if (dataDir === DATA_DIR) _cache = out;
  return out;
}

function _resetCacheForTests() { _cache = undefined; }

module.exports = {
  DEFAULT_MIN_CATEGORY_REVIEWS,
  DEFAULT_AUDIT_RATE,
  buildDomainCategoryCounts,
  domainCount,
  neverCoveredMarketDecision,
  resolveAuditRate,
  loadDomainCategoryCounts,
  _resetCacheForTests,
};
