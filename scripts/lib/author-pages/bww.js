'use strict';
/**
 * bww.js — Fetch critic review listings from BroadwayWorld's reviews-critics pages.
 *
 * Paginates https://www.broadwayworld.com/reviews-critics/{slug}?page=N up to
 * MAX_PAGES. Early-stops on empty page or repeated first URL (BWW wraps/repeats
 * on out-of-bounds pages).
 *
 * Exported from scripts/lib/author-pages/ so S1-T7 can dedupe across sources
 * via the `source` field.
 */

const path = require('path');
const { fetchPage } = require(path.join(__dirname, '../scraper.js'));

const MAX_PAGES = 10;

// Spam domains to exclude (mirrors muckrack.js)
const SPAM_DOMAINS = /msn\.com|gossipbucket|flipboard|google\.com|aol\.com|yahoo\.com|inkl\.com|ourcommunitynow|thepoke/;

/**
 * Convert M/D/YYYY date string to ISO YYYY-MM-DD.
 * Returns null if the input doesn't match.
 * @param {string} raw  e.g. "3/31/2026"
 * @returns {string|null}
 */
function toIsoDate(raw) {
  const m = raw && raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, dy, yr] = m;
  return `${yr}-${mo.padStart(2, '0')}-${dy.padStart(2, '0')}`;
}

/**
 * Parse review items from one page of HTML.
 *
 * Each review on the page is wrapped in a <div class="one-feed"> block that
 * contains:
 *   - <p style="font-weight:bold...">TITLE</p>
 *   - <strong>From:</strong> OUTLET &nbsp;|&nbsp; <strong>Date:</strong> M/D/YYYY
 *   - <a ... class="review-action-btn review-action-primary">Read This Review</a>
 *     with the actual outlet review URL (not a BWW /article/ URL)
 *
 * We match the outer one-feed block with dotAll, then extract the three fields
 * from each block individually.
 *
 * @param {string} html
 * @returns {Array<{url:string, title:string, date:string|null, outlet:string, source:'bww'}>}
 */
function parseReviews(html) {
  const results = [];

  // Match each one-feed block (dotAll mode so . spans newlines)
  const blockRe = /<div class="one-feed">([\s\S]*?)<\/div>\s*(?=<div class="one-feed"|<\/div>\s*<\/div>\s*(?:<!--|<script|<div class="pagination))/g;

  // Wider pattern to capture full one-feed blocks: from open tag to next sibling open tag
  // Use a simpler approach: split on the one-feed class boundary
  const chunks = html.split('<div class="one-feed">');
  chunks.shift(); // discard everything before the first one-feed

  for (const chunk of chunks) {
    // Extract title — inside <p style="font-weight:bold...">...</p>
    const titleMatch = chunk.match(/<p\s+style="font-weight:bold[^"]*"[^>]*>([^<]{3,300})<\/p>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/\s+/g, ' ').trim();

    // Extract outlet and date — "From:</strong> OUTLET &nbsp;|&nbsp; <strong>Date:</strong> M/D/YYYY"
    const metaMatch = chunk.match(/<strong>From:<\/strong>\s*(.*?)\s*&nbsp;\|&nbsp;\s*<strong>Date:<\/strong>\s*([\d\/]+)/);
    if (!metaMatch) continue;
    const outlet = metaMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    const date = toIsoDate(metaMatch[2].trim());

    // Extract the primary review URL (actual outlet link, not a BWW /reviews/ link)
    const urlMatch = chunk.match(/<a\s+href="(https?:\/\/[^"]+)"\s+target="_blank"[^>]*class="review-action-btn review-action-primary"/);
    if (!urlMatch) continue;
    const url = urlMatch[1];

    if (!url || !title) continue;
    if (SPAM_DOMAINS.test(url)) continue;

    results.push({ url, title, date, outlet, source: 'bww' });
  }

  return results;
}

/**
 * Detect a BWW soft-404: they return HTTP 200 with homepage content for
 * missing critic pages. Check <title> for generic content.
 * @param {string} html
 * @returns {boolean}
 */
function isSoft404(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!titleMatch) return false;
  const title = titleMatch[1].toLowerCase();
  // Critic pages have "— Theater Critic Reviews | BroadwayWorld"
  // Homepage / generic pages just have "BroadwayWorld" or "Broadway World"
  return !title.includes('theater critic') && !title.includes('theatre critic') && !title.includes('reviews');
}

/**
 * Fetch reviews from a BWW critic profile page (all pages up to MAX_PAGES).
 *
 * @param {string} bwwSlug  e.g. 'Elysa-Gardner'
 * @returns {Promise<Array<{url:string, title:string, date:string|null, outlet:string, source:'bww'}>>}
 */
async function fetch(bwwSlug) {
  const all = [];
  let lastFirstUrl = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = `https://www.broadwayworld.com/reviews-critics/${bwwSlug}?page=${page}`;
    let html;
    try {
      const r = await fetchPage(pageUrl, { timeout: 30000 });
      html = r && r.content;
    } catch {
      break; // network error — return what we have
    }

    // Empty-page early stop (mirrors Muckrack pattern)
    if (!html || html.length < 5000) break;

    // Soft-404 early stop
    if (isSoft404(html)) break;

    const items = parseReviews(html);
    if (items.length === 0) break;

    // Last-URL-stop: BWW pagination wraps on out-of-bounds pages
    const firstUrl = items[0] && items[0].url;
    if (firstUrl && firstUrl === lastFirstUrl) break;
    lastFirstUrl = firstUrl;

    all.push(...items);
  }

  return all;
}

module.exports = { fetch };
