'use strict';
/**
 * check-critic-coverage.js — Pure coverage-diff logic shared by
 * audit-critic-coverage.js (BRO-52).
 *
 * Given a critic's own reviews.json URLs and a list of externally-discovered
 * articles (Muckrack + native outlet author pages: BWW, NY Sun, NYSR, NYT,
 * The New Yorker, Vulture), this computes which external review-looking
 * articles we have NOT captured — the per-critic coverage gate.
 *
 * Extracted so the diff logic is unit-testable without hitting the network
 * (CLAUDE.md §15 — extract pure decision functions to scripts/lib/, require()
 * the real function from tests instead of copying the logic).
 */

const { looksLikeReview } = require('./author-pages/headline-classifier.js');

module.exports = { urlKey, ourUrlsFor, mergeArticlesBySource, computeCriticCoverage };

/**
 * Normalize a URL to a host+path key for cross-source dedup/matching.
 * Strips protocol, `www.`, trailing slash, and query string.
 *
 * @param {string} u
 * @returns {string|null}
 */
function urlKey(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '').split('?')[0];
  } catch {
    return null;
  }
}

/**
 * Build the set of URL keys we already have on file for a critic, from our
 * own reviews.json.
 *
 * @param {Array<{criticName?: string, url?: string}>} reviews
 * @param {string} criticName
 * @returns {Set<string>}
 */
function ourUrlsFor(reviews, criticName) {
  const set = new Set();
  for (const r of reviews) {
    if (r.criticName !== criticName) continue;
    const k = urlKey(r.url);
    if (k) set.add(k);
  }
  return set;
}

/**
 * Merge externally-discovered articles (possibly from multiple sources) by
 * URL key, keeping every source that surfaced each URL and the most recent
 * known publish date.
 *
 * @param {Array<{url:string, title:string, date?:string|null, source:string}>} articles
 * @returns {Map<string, {url:string, title:string, date?:string|null, source:string, sources:string[]}>}
 */
function mergeArticlesBySource(articles) {
  const map = new Map();
  for (const a of articles) {
    const k = urlKey(a.url);
    if (!k) continue;
    if (map.has(k)) {
      const existing = map.get(k);
      if (!existing.sources.includes(a.source)) existing.sources.push(a.source);
      if (a.date && (!existing.date || a.date > existing.date)) existing.date = a.date;
    } else {
      map.set(k, { ...a, sources: [a.source] });
    }
  }
  return map;
}

/**
 * Compute the coverage gap for one critic: external review-looking articles
 * that don't appear in our reviews.json under that critic's name.
 *
 * @param {Array<Object>} reviews - our reviews.json `reviews` array
 * @param {string} criticName - exact criticName as stored in reviews.json
 * @param {Array<{url:string, title:string, date?:string|null, source:string}>} externalArticles
 *   - raw articles gathered from all author-page sources for this critic
 * @returns {{externalCount:number, ourCount:number, missingCount:number, missing:Array<Object>}}
 */
function computeCriticCoverage(reviews, criticName, externalArticles) {
  const ours = ourUrlsFor(reviews, criticName);
  const extMap = mergeArticlesBySource(externalArticles);

  const missing = [];
  for (const [k, a] of extMap) {
    if (ours.has(k)) continue;
    if (!looksLikeReview(a.title, a.url)) continue;
    missing.push(a);
  }

  return {
    externalCount: extMap.size,
    ourCount: ours.size,
    missingCount: missing.length,
    missing,
  };
}
