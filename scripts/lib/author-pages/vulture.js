'use strict';
/**
 * vulture.js — Fetch a critic's article listing from their Vulture author
 * page (vulture.com/author/{slug}).
 *
 * Each item is an `<li class="article ...">` block carrying a
 * `data-track-headline="..."` attribute plus a `<time class="paginate-time">`
 * and an `<a href="https://www.vulture.com/article/{slug}.html">`. Single
 * page — Vulture's author page paginates via infinite-scroll API, not a
 * query param.
 *
 * Exported from scripts/lib/author-pages/ so audit-critic-coverage.js can
 * dedupe across sources via the `source` field.
 */

const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

/**
 * Convert Vulture's "Jan. 8, 2026" date text to ISO YYYY-MM-DD.
 * Returns null if unparseable.
 * @param {string} raw
 * @returns {string|null}
 */
function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function cleanTitle(raw) {
  return raw
    .replace(/&lt;[^&]*&gt;/g, '') // strip escaped inline tags like &lt;em&gt;
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse review-listing items from one page of Vulture author-page HTML.
 *
 * @param {string} html
 * @returns {Array<{url:string, title:string, date:string|null, source:'vulture'}>}
 */
function parseArticles(html) {
  const results = [];
  const seen = new Set();

  // Split on each list-item's opening tag; discard everything before the first one.
  const chunks = html.split(/<li\s+class="article/);
  chunks.shift();

  for (const chunk of chunks) {
    const hedMatch = chunk.match(/data-track-headline="([^"]*)"/);
    const urlMatch = chunk.match(/href="(https:\/\/www\.vulture\.com\/article\/[a-z0-9-]+\.html)"/);
    if (!hedMatch || !urlMatch) continue;

    const url = urlMatch[1];
    if (seen.has(url)) continue;
    seen.add(url);

    const title = cleanTitle(hedMatch[1]);
    const dateMatch = chunk.match(/<time class="paginate-time">([^<]+)<\/time>/);
    const date = dateMatch ? toIsoDate(dateMatch[1].trim()) : null;

    if (!url || !title) continue;
    results.push({ url, title, date, source: 'vulture' });
  }

  return results;
}

/**
 * Fetch reviews from a Vulture critic's author page.
 *
 * @param {string} vultureSlug  e.g. 'sara-holdren'
 * @returns {Promise<Array<{url:string, title:string, date:string|null, source:'vulture'}>>}
 */
async function fetch(vultureSlug) {
  const url = `https://www.vulture.com/author/${vultureSlug}/`;
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
