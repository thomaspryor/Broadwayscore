// Page evidence, never AI confidence, determines whether a figure is reported.
const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');
const { normalizeSources } = require('./commercial-sources');
const { foldDiacritics } = require('./title-match');

function pageText(page) {
  return String(page || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(totalAmountSold|totalOfferingAmount)>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

// Characters either side of a figure searched for the production's opening year and title.
const YEAR_WINDOW = 300;
const TITLE_WINDOW = 400;

const key = (v) => foldDiacritics(String(v || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Text of the page's <title> and <h1> tags: a page about this show names it there.
function headText(page) {
  const out = [];
  for (const m of String(page || '').matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1>/gi)) out.push(m[2].replace(/<[^>]+>/g, ' '));
  return key(out.join(' '));
}

// A quote for public display: whole words only, no tag or nav debris at the edges.
function tidyQuote(text, from, to) {
  let q = text.slice(Math.max(0, from), to);
  if (from > 0) q = q.replace(/^\S*\s+/, '');
  if (to < text.length) q = q.replace(/\s+\S*$/, '');
  return q.trim();
}

/** True when `year` appears within YEAR_WINDOW of the figure and no other year is closer to it. */
function nearestYearIs(text, start, end, year) {
  const lo = Math.max(0, start - YEAR_WINDOW);
  const slice = text.slice(lo, end + YEAR_WINDOW);
  let best = null;
  for (const m of slice.matchAll(/\b(?:19|20)\d{2}\b/g)) {
    const at = lo + m.index;
    const dist = at < start ? start - (at + 4) : at - end;
    if (!best || dist < best.dist) best = { year: m[0], dist };
  }
  return best !== null && best.year === year;
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

  const title = key(context.title);
  const headKey = ` ${headText(page)} `;
  for (const match of text.matchAll(pattern)) {
    if (typeof figure === 'number') {
      const scale = (match[2] || '').toLowerCase();
      const value = Number(match[1].replace(/,/g, '')) * (scale.startsWith('m') ? 1e6 : scale.startsWith('b') ? 1e9 : 1);
      if (Math.abs(value - figure) > 0.01) continue;
    }
    // Another currency is not this figure.
    if (/[£€]\s*$/.test(text.slice(Math.max(0, match.index - 3), match.index))) continue;
    const end = match.index + match[0].length;
    const quote = tidyQuote(text, match.index - 180, end + 180);
    if (typeof figure === 'number' && !match[0].includes('$') && !match[2] && !/totalAmountSold|totalOfferingAmount/i.test(quote)) continue;
    // Same production: the title is in the page's own <title>/<h1> or close to the figure (a roundup
    // page naming other shows does not count just because the title appears in its nav), and the opening
    // year is the nearest year to the figure (an earlier production's year closer by fails closed).
    if (title) {
      const around = key(text.slice(Math.max(0, match.index - TITLE_WINDOW), end + TITLE_WINDOW));
      if (!(` ${around} `).includes(` ${title} `) && !headKey.includes(` ${title} `)) continue;
    }
    if (context.year && !nearestYearIs(text, match.index, end, context.year)) continue;
    if (context.field === 'capitalization' && !/capitaliz|budget|investment|cost to (?:mount|produce)|\braised\b|offering|amount sold|totalAmountSold|totalOfferingAmount/i.test(quote)) continue;
    if (context.field === 'weeklyRunningCost' && (!/running costs?|operating costs?|weekly (?:nut|budget|expenses?|costs?)|costs? [^.]{0,40}(?:per|a) week/i.test(quote) || /gross/i.test(quote))) continue;
    return { found: true, quote };
  }
  return { found: false, quote: null };
}

function createSourceVerifier({ fetchPage = (...args) => require('./scraper').fetchPage(...args), maxFetches = 60 } = {}, budget = null) {
  const cache = new Map();
  return async function verifyEntry(entry, show) {
    const evidence = {};
    // Set when a cited page was not read because the per-run fetch cap was reached: the caller
    // leaves that entry pending for the next run instead of landing it as an unverified estimate.
    let capped = false;
    let fieldCapped = false;
    let fetchFailed = false;
    let sawFetchFailure = false;
    const sources = normalizeSources(entry.sources);
    for (const field of ['capitalization', 'weeklyRunningCost']) {
      if (entry[field] == null) continue;
      fieldCapped = false;
      sawFetchFailure = false;
      for (const source of sources) {
        let host;
        try { const url = new URL(source.url); if (url.protocol !== 'https:') continue; host = url.hostname.replace(/^www\./, ''); } catch { continue; }
        const sec = host === 'sec.gov' || host.endsWith('.sec.gov');
        if (!sec && !TRUSTED_RECOUPMENT_HOSTS.has(host)) continue;
        // No usable production context means no promotion to fact.
        const year = (show?.openingDate || show?.previewsStartDate || '').slice(0, 4);
        if (!show?.title || !/^\d{4}$/.test(year)) continue;
        if (!cache.has(source.url)) {
          // Out of fetches or out of wall-clock budget (scripts/lib/run-budget.js): do not start another page read.
          if (cache.size >= maxFetches || (budget && budget.exceeded())) { fieldCapped = true; continue; }
          // A fetch that THROWS (network, 403, 429, missing credentials) is not the same as a page that loaded
          // and does not state the figure: record it so the caller can leave the entry pending instead of
          // downgrading a figure nobody actually checked.
          cache.set(source.url, Promise.resolve().then(() => fetchPage(source.url)).then(
            (r) => ({ content: r?.content || '', failed: !r || !r.content }),
            () => ({ content: '', failed: true }),
          ));
        }
        const page = await cache.get(source.url);
        const result = verifyFigure(entry[field], page.content, { title: show.title, year, field });
        if (result.found) { evidence[field] = { ...result, source }; fieldCapped = false; sawFetchFailure = false; break; }
        if (page.failed) sawFetchFailure = true;
      }
      if (fieldCapped) capped = true;
      if (sawFetchFailure && !evidence[field]) fetchFailed = true;
    }
    if (capped) evidence.capped = true;
    if (fetchFailed) evidence.fetchFailed = true;
    return evidence;
  };
}

// A pending entry whose cited pages could not be fetched is left pending and retried on the next run, but only
// this many times: an entry whose page is permanently unreachable must not burn scraper credits every week
// forever (the BRO-4765 shape). After the last attempt it applies as an estimate.
const SOURCE_VERIFY_MAX_ATTEMPTS = 3;

/** Pure: given a pending entry whose fetch failed, say whether to leave it pending and what to record. */
function nextVerifyAttempt(entry, max = SOURCE_VERIFY_MAX_ATTEMPTS) {
  const attempts = (Number.isInteger(entry && entry.sourceVerifyAttempts) ? entry.sourceVerifyAttempts : 0) + 1;
  return { attempts, leavePending: attempts < max };
}

module.exports = { pageText, verifyFigure, createSourceVerifier, nextVerifyAttempt, SOURCE_VERIFY_MAX_ATTEMPTS };
