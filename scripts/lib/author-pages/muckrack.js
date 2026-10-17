'use strict';
/**
 * muckrack.js — Fetch articles from a critic's Muckrack profile page.
 *
 * Exported from scripts/lib/author-pages/ so S1-T7 can dedupe across sources
 * via the `source` field.
 */
const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

module.exports = { fetch };

/**
 * Fetch articles listed on a critic's Muckrack profile.
 *
 * @param {string} slug  — Muckrack URL slug (e.g. 'jesse-green')
 * @param {number} maxPages — max pages to scrape (default 2)
 * @returns {Promise<Array<{url: string, title: string, source: string}>>}
 */
async function fetch(slug, maxPages = 2) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1
      ? `https://muckrack.com/${slug}/articles`
      : `https://muckrack.com/${slug}/articles?page=${p}`;
    let html;
    try { const r = await fetchPage(url, { timeout: 30000 }); html = r && r.content; } catch { html = null; }
    if (!html || html.length < 5000) break;
    const matches = [...html.matchAll(/<h\d[^>]*>\s*<a[^>]+href="(https?:[^"]+)"[^>]*>([^<]{6,200})<\/a>/g)];
    let foundOnPage = 0;
    for (const m of matches) {
      const u = m[1];
      const title = m[2].replace(/\s+/g,' ').trim();
      if (/msn\.com|gossipbucket|flipboard|google\.com|aol\.com|yahoo\.com|inkl\.com|ourcommunitynow|thepoke/.test(u)) continue;
      all.push({ url: u, title, source: 'muckrack' });
      foundOnPage++;
    }
    if (foundOnPage < 10) break;
  }
  return all;
}
