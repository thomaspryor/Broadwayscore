// Page evidence, never AI confidence, determines whether a figure is reported.
const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');
const { normalizeSources } = require('./commercial-sources');

function pageText(page) {
  return String(page || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(totalAmountSold|totalOfferingAmount)>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function verifyFigure(figure, page, context = {}) {
  const text = pageText(page);
  let pattern;
  if (typeof figure === 'number' && Number.isFinite(figure) && figure > 0) {
    pattern = /(?<![\w.,])\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(million|billion|[mb]\b)?(?![\w,]|\.\d)/gi;
  } else if (typeof figure === 'string' && /^\d{4}(-(?:0[1-9]|1[0-2]))?$/.test(figure)) {
    const [year, month] = figure.split('-');
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    pattern = month ? new RegExp(`\\b(?:${months[Number(month) - 1]}|${months[Number(month) - 1].slice(0, 3)}\\.?)\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?${year}\\b`, 'gi') : new RegExp(`\\b${year}\\b`, 'g');
  } else return { found: false, quote: null };

  for (const match of text.matchAll(pattern)) {
    if (typeof figure === 'number') {
      const scale = (match[2] || '').toLowerCase();
      const value = Number(match[1].replace(/,/g, '')) * (scale.startsWith('m') ? 1e6 : scale.startsWith('b') ? 1e9 : 1);
      if (Math.abs(value - figure) > 0.01) continue;
    }
    const quote = text.slice(Math.max(0, match.index - 180), match.index + match[0].length + 180).trim();
    if (typeof figure === 'number' && !match[0].includes('$') && !match[2] && !/totalAmountSold|totalOfferingAmount/i.test(quote)) continue;
    const normalized = quote.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const title = String(context.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (title && !(` ${normalized} `).includes(` ${title} `)) continue;
    if (context.year && !new RegExp(`\\b${context.year}\\b`).test(quote)) continue;
    if (context.field === 'capitalization' && !/capitaliz|budget|investment|cost to (?:mount|produce)|rais(?:ed|ing)|offering|amount sold|totalAmountSold|totalOfferingAmount/i.test(quote)) continue;
    if (context.field === 'weeklyRunningCost' && !/weekly|running cost|per week|a week/i.test(quote)) continue;
    return { found: true, quote };
  }
  return { found: false, quote: null };
}

function createSourceVerifier({ fetchPage = (...args) => require('./scraper').fetchPage(...args), maxFetches = 20 } = {}) {
  const cache = new Map();
  return async function verifyEntry(entry, show) {
    const evidence = {};
    const sources = normalizeSources(entry.sources);
    for (const field of ['capitalization', 'weeklyRunningCost']) {
      if (entry[field] == null) continue;
      for (const source of sources) {
        let host;
        try { const url = new URL(source.url); if (url.protocol !== 'https:') continue; host = url.hostname.replace(/^www\./, ''); } catch { continue; }
        const sec = host === 'sec.gov' || host.endsWith('.sec.gov');
        if (!sec && !TRUSTED_RECOUPMENT_HOSTS.has(host)) continue;
        // No usable production context means no promotion to fact.
        const year = (show?.openingDate || show?.previewsStartDate || '').slice(0, 4);
        if (!show?.title || !/^\d{4}$/.test(year)) continue;
        if (!cache.has(source.url)) {
          if (cache.size >= maxFetches) continue;
          cache.set(source.url, Promise.resolve().then(() => fetchPage(source.url)).then(r => r?.content || '').catch(() => ''));
        }
        const result = verifyFigure(entry[field], await cache.get(source.url), { title: show.title, year, field });
        if (result.found) { evidence[field] = { ...result, source }; break; }
      }
    }
    return evidence;
  };
}

module.exports = { pageText, verifyFigure, createSourceVerifier };
