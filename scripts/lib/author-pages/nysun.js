'use strict';

const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

/**
 * Fetches page 1 of an NY Sun author page and returns article links.
 *
 * NY Sun pagination is broken — page 1 only (~12 most-recent articles).
 *
 * @param {string} nysunSlug  e.g. 'elysa-gardner'
 * @returns {Promise<Array<{url: string, title: string, date: string, source: string}>>}
 */
async function fetch(nysunSlug) {
  const url = `https://www.nysun.com/author/${nysunSlug}`;

  let result;
  try {
    result = await fetchPage(url, { js: false });
  } catch (_err) {
    return [];
  }

  const html = result && result.content;
  if (!html || html.length < 5000) return [];

  // Soft-404 detection: author pages have "AUTHOR NAME | The New York Sun"
  // The homepage title is just "The New York Sun" (no pipe-separated prefix).
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1] : '';
  if (!pageTitle.includes('|')) return [];

  // Extract article slugs — each article is wrapped in <article class="group/article-teaser">
  // with <a href="/article/{slug}"> immediately inside.
  const articleHrefs = [];
  const hrefRe = /href="(\/article\/[^"]+)"/g;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    articleHrefs.push(m[1]);
  }

  // Extract H3 titles (one per article block, same order as hrefs).
  const titles = [];
  const h3Re = /<h3[^>]*>([^<]+)<\/h3>/g;
  while ((m = h3Re.exec(html)) !== null) {
    // Decode common HTML entities
    const raw = m[1]
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    titles.push(raw);
  }

  // Extract ISO datetimes from <time dateTime="..."> elements (one per article, same order).
  const dates = [];
  const dateRe = /dateTime="([^"]+)"/g;
  while ((m = dateRe.exec(html)) !== null) {
    // Convert ISO 8601 → YYYY-MM-DD
    dates.push(m[1].slice(0, 10));
  }

  const count = Math.min(articleHrefs.length, titles.length, dates.length);
  const articles = [];
  for (let i = 0; i < count; i++) {
    articles.push({
      url: `https://www.nysun.com${articleHrefs[i]}`,
      title: titles[i],
      date: dates[i],
      source: 'nysun',
    });
  }

  return articles;
}

module.exports = { fetch };
