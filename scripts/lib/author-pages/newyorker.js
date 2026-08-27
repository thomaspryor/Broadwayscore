'use strict';
/**
 * newyorker.js — Fetch a critic's article listing from their New Yorker
 * contributor page (newyorker.com/contributors/{slug}).
 *
 * The page embeds each listed item's headline + link as a JSON blob in a
 * `data-item="{...}"` attribute (HTML-entity-escaped), not plain anchor text,
 * so this parses that JSON rather than scraping visible markup. Single page —
 * the contributor page paginates via infinite-scroll API, not a query param.
 *
 * Exported from scripts/lib/author-pages/ so audit-critic-coverage.js can
 * dedupe across sources via the `source` field.
 */

const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

/**
 * Extract YYYY-MM-DD from a New Yorker URL path when present
 * (e.g. /magazine/2025/12/29/tartuffe-theatre-review). Goings-on/postscript
 * pieces don't carry a date in the URL — returns null for those.
 * @param {string} urlPath
 * @returns {string|null}
 */
function dateFromUrlPath(urlPath) {
  const m = urlPath.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Strip inline tags (e.g. <em>Bug</em>) and decode entities from a headline.
 * @param {string} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse contributor-page items out of `data-item="{...}"` JSON blobs.
 *
 * @param {string} html
 * @returns {Array<{url:string, title:string, date:string|null, source:'newyorker'}>}
 */
function parseArticles(html) {
  const results = [];
  const seen = new Set();
  const blobRe = /data-item="({.*?})"/g;
  let m;
  while ((m = blobRe.exec(html)) !== null) {
    let obj;
    try {
      const unescaped = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      obj = JSON.parse(unescaped);
    } catch {
      continue;
    }
    const link = obj && obj.hotelLink;
    const hed = obj && obj.dangerousHed;
    if (!link || !hed) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    results.push({
      url: `https://www.newyorker.com${link}`,
      title: cleanTitle(hed),
      date: dateFromUrlPath(link),
      source: 'newyorker',
    });
  }
  return results;
}

/**
 * Fetch bylined articles from a New Yorker critic's contributor page.
 *
 * @param {string} newyorkerSlug  e.g. 'helen-shaw'
 * @returns {Promise<Array<{url:string, title:string, date:string|null, source:'newyorker'}>>}
 */
async function fetch(newyorkerSlug) {
  const url = `https://www.newyorker.com/contributors/${newyorkerSlug}`;
  let html;
  try {
    const r = await fetchPage(url, { timeout: 30000 });
    html = r && r.content;
  } catch {
    return [];
  }
  if (!html || html.length < 5000) return [];
  return parseArticles(html);
}

module.exports = { fetch };
