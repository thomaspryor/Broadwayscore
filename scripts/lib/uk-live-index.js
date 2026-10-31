'use strict';
/**
 * BRO-6692: live review-index readers for UK hub shows under the scoreable bar.
 *
 * The generic SERP pass never surfaces WhatsOnStage, British Theatre Guide or The Reviews Hub
 * for regional shows, so these read each outlet's own index instead:
 *   - WhatsOnStage: WordPress REST, custom post type `news`, category 63 (reviews), searched per
 *     title inside the show's run window.
 *   - The Reviews Hub: WordPress REST `posts` (headline "Title – Venue, City"), same window.
 *   - British Theatre Guide: /reviews?q=<title> listing (title, venue, run dates, slug).
 * Each reader returns census-shaped items { url, headline, publishDate, outletId } so
 * scripts/lib/uk-regional-census-match.js decides which show an item reviews (title, house and run
 * window), the same gate the census backfill used. Parsers are pure; fetchers take an injected
 * `get(url) -> text` so tests never touch the network.
 */

const DAY = 86400000;
const WOS = 'https://www.whatsonstage.com/wp-json/wp/v2/news';
const HUB = 'https://thereviewshub.com/wp-json/wp/v2/posts';
const BTG = 'https://www.britishtheatreguide.info/reviews';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

/** Search terms for a show: the title with quotes stripped, plus the pre-colon part as a fallback. */
function searchTerms(title) {
  const clean = String(title || '').replace(/[’'`"]/g, '').replace(/\s+/g, ' ').trim();
  const terms = [clean];
  const head = clean.split(/[:–—-]\s/)[0].trim();
  if (head && head !== clean && head.length >= 4) terms.push(head);
  return terms;
}

function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

/** Publish window for a show's reviews: 60 days before previews/opening to 60 days after closing (or 150 after opening). */
function reviewWindow(show) {
  const t = (d) => { const v = Date.parse(String(d || '').slice(0, 10)); return Number.isNaN(v) ? null : v; };
  const starts = [t(show.previewsStartDate), t(show.openingDate)].filter((v) => v !== null);
  if (!starts.length) return null;
  const close = t(show.closingDate);
  const end = close !== null ? close + 60 * DAY : Math.max(...starts) + 150 * DAY;
  return { after: iso(Math.min(...starts) - 60 * DAY), before: iso(end + DAY) };
}

function parseWpItems(body, outletId) {
  let rows;
  try { rows = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.link && r.title && r.date)
    .map((r) => ({ url: r.link, headline: decodeEntities(r.title.rendered), publishDate: String(r.date).slice(0, 10), outletId }));
}

/** British Theatre Guide listing → items. The listing shows the production's run, so the run start stands in for the review date. */
function parseBtgListing(html) {
  const out = [];
  const blocks = String(html || '').split(/<div id="review_\d+"/).slice(1);
  for (const b of blocks) {
    const href = (/href="(\/reviews\/[a-z0-9-]+-\d+)"/.exec(b) || [])[1];
    const title = (/<h3>([^<]+)<\/h3>/.exec(b) || [])[1];
    const start = (/<time datetime="(\d{4}-\d{2}-\d{2})"/.exec(b) || [])[1];
    if (!href || !title || !start) continue;
    out.push({ url: `https://www.britishtheatreguide.info${href}`, headline: decodeEntities(title), publishDate: start, outletId: 'british-theatre' });
  }
  return out;
}

async function wpItems(base, outletId, show, get, extra = '') {
  const w = reviewWindow(show);
  if (!w) return [];
  const seen = new Map();
  for (const term of searchTerms(show.title)) {
    const url = `${base}?search=${encodeURIComponent(term)}&after=${w.after}T00:00:00&before=${w.before}T00:00:00&per_page=30&_fields=link,date,title${extra}`;
    for (const it of parseWpItems(await get(url), outletId)) seen.set(it.url, it);
  }
  return [...seen.values()];
}

async function wosItems(show, get) { return wpItems(WOS, 'whatsonstage', show, get, '&categories=63'); }
async function hubItems(show, get) { return wpItems(HUB, 'thereviewshub', show, get); }

async function btgItems(show, get) {
  const seen = new Map();
  for (const term of searchTerms(show.title)) {
    for (const it of parseBtgListing(await get(`${BTG}?q=${encodeURIComponent(term)}`))) seen.set(it.url, it);
  }
  return [...seen.values()];
}

module.exports = { searchTerms, reviewWindow, parseWpItems, parseBtgListing, decodeEntities, wosItems, hubItems, btgItems };
