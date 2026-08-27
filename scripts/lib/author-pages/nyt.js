'use strict';
/**
 * nyt.js — Fetch a critic's article listing from their NYT "by" author page
 * (nytimes.com/by/{slug}).
 *
 * Single page only — NYT's "by" page loads further history via an infinite-
 * scroll API call, not a query-param page N, so this covers the ~15-20 most
 * recent bylined pieces (mirrors nysun.js's single-page limitation). Callers
 * (audit-critic-coverage.js) filter to theater/review pieces via
 * looksLikeReview — this returns every bylined article, not just theater.
 *
 * Exported from scripts/lib/author-pages/ so audit-critic-coverage.js can
 * dedupe across sources via the `source` field.
 */

const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

/**
 * Extract YYYY-MM-DD from an NYT URL path like /2026/06/07/theater/slug.html.
 * @param {string} url
 * @returns {string|null}
 */
function dateFromUrl(url) {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Parse bylined article links + headlines from an NYT "by" page.
 *
 * Each article is an `<a href="/YYYY/MM/DD/section/slug.html">` wrapping an
 * `<h3>Headline</h3>` (or `<h2>` for the lead item).
 *
 * @param {string} html
 * @returns {Array<{url:string, title:string, date:string|null, source:'nyt'}>}
 */
function parseArticles(html) {
  const results = [];
  const seen = new Set();
  const linkRe = /<a[^>]+href="(\/\d{4}\/\d{2}\/\d{2}\/[a-z-]+\/[^"]+\.html)"[^>]*>\s*<h[23][^>]*>([^<]{3,300})<\/h[23]>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const path_ = m[1];
    if (seen.has(path_)) continue;
    seen.add(path_);
    const title = m[2]
      .replace(/&#x27;/g, "'")
      .replace(/&rsquo;|&#8217;/g, "’")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    results.push({
      url: `https://www.nytimes.com${path_}`,
      title,
      date: dateFromUrl(path_),
      source: 'nyt',
    });
  }
  return results;
}

/**
 * Fetch bylined articles from an NYT critic's "by" author page.
 *
 * @param {string} nytSlug  e.g. 'jesse-green'
 * @returns {Promise<Array<{url:string, title:string, date:string|null, source:'nyt'}>>}
 */
async function fetch(nytSlug) {
  const url = `https://www.nytimes.com/by/${nytSlug}`;
  let html;
  try {
    const r = await fetchPage(url, { timeout: 30000 });
    html = r && r.content;
  } catch {
    return [];
  }
  if (!html || html.length < 5000) return [];
  const articles = parseArticles(html);
  if (articles.length === 0) {
    console.warn(`  [nyt] WARN: ${url} returned ${html.length} bytes but 0 bylined articles parsed — possible slug/structural drift, or the critic genuinely has no recent bylines`);
  }
  return articles;
}

module.exports = { fetch };
