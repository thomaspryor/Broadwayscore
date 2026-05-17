'use strict';
/**
 * nysr.js — Fetch critic review listings from New York Stage Review author pages.
 *
 * Fetches https://nystagereview.com/author/{slug}/ and paginates via
 * /author/{slug}/page/N/ up to MAX_PAGES. Each page shows 10 articles.
 * Full archive available — not capped like BWW.
 *
 * Exported from scripts/lib/author-pages/ so S1-T7 can dedupe across sources
 * via the `source` field.
 */

const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

const MAX_PAGES = 10;

/**
 * Extract YYYY-MM-DD from a NYSR URL path like
 * https://nystagereview.com/2026/01/12/slug-here/
 * Returns null if no match.
 * @param {string} url
 * @returns {string|null}
 */
function dateFromUrl(url) {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Parse review items from one page of NYSR HTML.
 *
 * Each review is wrapped in an <article ...> tag containing:
 *   - <h2 class="entry-title ..."><a class="entry-title-link" href="URL">Title</a></h2>
 *   - <time class="entry-time ...">Month DD, YYYY</time>  (first time tag = date)
 *
 * Date is extracted from the article URL path (/YYYY/MM/DD/) as primary source
 * (more reliable than parsing the human-readable time element).
 *
 * @param {string} html
 * @returns {Array<{url:string, title:string, date:string|null, source:'nysr'}>}
 */
function parseReviews(html) {
  const results = [];

  // Split on <article opening tags; discard everything before the first one
  const chunks = html.split(/<article\s/);
  chunks.shift();

  for (const chunk of chunks) {
    // Extract the title-link: <a class="entry-title-link" ... href="URL">Title</a>
    const linkMatch = chunk.match(/<a\s[^>]*class="entry-title-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if (!linkMatch) continue;

    const url = linkMatch[1].trim();
    const title = linkMatch[2]
      .replace(/&#8217;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"')
      .replace(/&#8211;/g, '–')
      .replace(/&#8212;/g, '—')
      .replace(/&#038;/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    if (!url || !title) continue;
    // Sanity check — URL must be a NYSR article
    if (!url.startsWith('https://nystagereview.com/')) continue;

    const date = dateFromUrl(url);

    results.push({ url, title, date, source: 'nysr' });
  }

  return results;
}

/**
 * Detect a NYSR soft-404 or "no posts found" page.
 * Missing author pages typically return a page with "No posts found."
 * @param {string} html
 * @returns {boolean}
 */
function isEmptyPage(html) {
  return /no posts found/i.test(html);
}

/**
 * Fetch reviews from a NYSR author page (all pages up to MAX_PAGES).
 *
 * @param {string} nysrSlug  e.g. 'elysa'
 * @returns {Promise<Array<{url:string, title:string, date:string|null, source:'nysr'}>>}
 */
async function fetch(nysrSlug) {
  const all = [];
  let lastFirstUrl = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1
      ? `https://nystagereview.com/author/${nysrSlug}/`
      : `https://nystagereview.com/author/${nysrSlug}/page/${page}/`;

    let html;
    try {
      const r = await fetchPage(pageUrl, { timeout: 30000 });
      html = r && r.content;
    } catch {
      break; // network error — return what we have
    }

    // Short-page early stop (likely error or empty)
    if (!html || html.length < 5000) break;

    // Soft-404 / no posts found
    if (isEmptyPage(html)) break;

    const items = parseReviews(html);
    if (items.length === 0) break;

    // Wrap-guard: stop if first URL repeats (pagination out of bounds)
    const firstUrl = items[0] && items[0].url;
    if (firstUrl && firstUrl === lastFirstUrl) break;
    lastFirstUrl = firstUrl;

    all.push(...items);

    // If the page has no "next" link, we're on the last page
    if (!html.includes(`/author/${nysrSlug}/page/${page + 1}/`)) break;
  }

  return all;
}

module.exports = { fetch };
