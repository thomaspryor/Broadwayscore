'use strict';

const cheerio = require('cheerio');
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
    const subject = normalize(headline.replace(/^theat(?:re|er) in review:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, ''));
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
  // Reviews can land across a month boundary. Include previews, opening,
  // and the following month so archived backfills keep working.
  for (const date of [show.previewsStartDate, opening, nextMonth]) {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
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

module.exports = { parseLightingSoundAmericaIndex, discoverLightingSoundAmerica };
