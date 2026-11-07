'use strict';

const cheerio = require('cheerio');
const { cleanSearchTitle } = require('./title-normalization');
const INDEX_URL = 'http://www.lightingandsoundamerica.com/news/';
const normalize = text => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function indexDate(text) {
  const m = text.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso ? iso : null;
}

// Story IDs are opaque. Match the editorial headline and take dates from the
// same index card, never from the ID or the date used to request an archive.
function parseLightingSoundAmericaIndex(html, showTitle, show = {}) {
  const $ = cheerio.load(html || '');
  const title = normalize(showTitle);
  if (!title) return [];
  const start = show.previewsStartDate || show.openingDate;
  if (!start || !Number.isFinite(Date.parse(start))) return []; // Cannot attribute an unknown production safely.
  const earliest = show.previewsStartDate || new Date(Date.parse(start) - 14 * 86400000).toISOString().slice(0, 10);
  const latest = show.closingDate || null;
  const results = new Map();
  $('a[href]').each((_, el) => {
    const anchor = $(el);
    const headline = anchor.text().replace(/\s+/g, ' ').trim();
    if (!/^theat(?:re|er) in review:/i.test(headline)) return;
    // Match the title portion, not the parenthesized venue or story excerpt.
    const subject = normalize(cleanSearchTitle(headline.replace(/^theat(?:re|er) in review:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '')));
    // Same cleaning as the search title (& -> and, Shakespeare's, : The Musical).
    if (subject !== title) return;
    let url;
    try { url = new URL(anchor.attr('href'), INDEX_URL); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?lightingandsoundamerica\.com$/i.test(url.hostname)
        || !/^\/news\/story\.asp$/i.test(url.pathname) || !url.searchParams.get('ID')) return;
    let publishDate = null;
    // Nested layout tables are common. Use the smallest ancestor row with a
    // date and exactly one story, so another card's date cannot bleed in.
    for (const row of anchor.parents('tr').toArray()) {
      const card = $(row);
      const ids = new Set(card.find('a[href]').toArray().map(a => $(a).attr('href')).filter(href => /story\.asp\?ID=/i.test(href)));
      if (ids.size !== 1) continue;
      publishDate = indexDate(card.text());
      if (publishDate) break;
      const previous = card.prev('tr');
      if (!previous.find('a[href]').length) publishDate = indexDate(previous.text());
      if (publishDate) break;
    }
    if (!publishDate || publishDate < earliest || (latest && publishDate > latest)) return;
    url.hash = '';
    results.set(url.href, { url: url.href, publishDate, dateSource: 'outlet-news-index' });
  });
  return [...results.values()];
}

async function discoverLightingSoundAmerica(showTitle, show, fetchImpl) {
  const urls = new Set([INDEX_URL]);
  const opening = show.openingDate;
  const nextMonth = opening && Number.isFinite(Date.parse(opening))
    ? new Date(Date.UTC(Number(opening.slice(0, 4)), Number(opening.slice(5, 7)), 1)).toISOString().slice(0, 10)
    : null;
  // The rolling index covers the current month. Archive pages are fetched only
  // for earlier months (previews/opening month, so a month-boundary review is
  // not lost); the current or a future month would be a wasted paid fetch.
  const thisMonth = new Date().toISOString().slice(0, 7);
  for (const date of [show.previewsStartDate, opening, nextMonth]) {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date.slice(0, 7) < thisMonth) {
      urls.add(`${INDEX_URL}archive.asp?m=${Number(date.slice(5, 7))}&y=${date.slice(0, 4)}`);
    }
  }
  const found = new Map();
  for (const url of urls) {
    try {
      const html = await fetchImpl(url);
      if (!html || !/story\.asp\?ID=/i.test(html)) throw new Error('index returned no story links');
      for (const review of parseLightingSoundAmericaIndex(html, showTitle, show)) found.set(review.url, review);
    } catch (error) {
      // A missing archive must not discard a review from the rolling index.
      console.warn(`Lighting & Sound America discovery: ${url}: ${error.message}`);
    }
  }
  return [...found.values()];
}

// Each gather costs up to 4 paid fetches (index + 3 archive months), so only
// fire for shows whose review window is open: previews/opening within the
// last 60 days or the next 21. Older shows' reviews were found at the time.
const DAY = 86400000;
function appliesToShow(show, now = Date.now()) {
  // LSA only reviews NYC productions: skip tours, regional, West End, opera.
  if (!show || show.type === 'opera' || !['broadway', 'off-broadway'].includes(show.category)) return false;
  const opening = Date.parse(show.openingDate);
  if (!Number.isFinite(opening)) return false;
  const previews = Date.parse(show.previewsStartDate);
  const start = Number.isFinite(previews) ? Math.min(previews, opening) : opening;
  return now >= start - 21 * DAY && now <= opening + 60 * DAY;
}

module.exports = { parseLightingSoundAmericaIndex, discoverLightingSoundAmerica, appliesToShow };
