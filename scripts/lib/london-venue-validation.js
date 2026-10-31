'use strict';

// London production evidence for validate-show-venue (BRO-5178). URLs locate
// sources only: titles, venues and dates always come from the fetched page.
const { JSDOM } = require('jsdom');
const { normalizeTitle } = require('./title-match');
const { normalizeVenueName } = require('./venue-classification');
const { venuesMatch } = require('./deduplication');
const { parseJsonLd, hasJsonLdType } = require('./jsonld');
const { parseDateRangeText } = require('./ob-listing-platforms');
const { compareShow, classifyComparison } = require('./venue-date-compare');
// venue-write-guard-ok: validation report rows only; never writes shows.json.

const LONDON_LISTINGS = ['londontheatre.co.uk', 'officiallondontheatre.com'];
// These two houses have no dated reader in OWE_VENUE_CONFIGS. Searching their
// own pages avoids treating a short international visit as a Playbill miss.
const EXTRA_VENUES = [
  { name: 'Barbican Theatre', url: 'https://www.barbican.org.uk/whats-on/theatre-dance' },
  { name: 'Coronet Theatre', url: 'https://www.thecoronettheatre.com/whats-on/' },
];

function isLondonShow(show) {
  return ['west-end', 'off-west-end'].includes(show.category)
    || (!show.category && show.market === 'west-end');
}

// Keep the existing Playbill implementation intact for every other region.
function routeVenueValidation(show, { london, playbill }) {
  return (isLondonShow(show) ? london : playbill)(show);
}

function londonSources(show) {
  const { OWE_VENUE_CONFIGS } = require('./venue-listing-discover');
  const key = normalizeVenueName(show.venue);
  const venue = [...OWE_VENUE_CONFIGS, ...EXTRA_VENUES].find(c =>
    [c.name, ...(c.coversVenues || []), ...(c.coverageExact || [])]
      .some(name => normalizeVenueName(name) === key));
  return [...new Set([...(venue ? [new URL(venue.url).hostname.replace(/^www\./, '')] : []), ...LONDON_LISTINGS])];
}

function allowedSource(url, domains) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && domains.includes(u.hostname.replace(/^www\./, ''))
      && !/\.(?:pdf|jpe?g|png)$/i.test(u.pathname);
  } catch { return false; }
}

function titleMatches(title, expected) {
  // Venue headings sometimes include a producing company and author credit,
  // e.g. "Berliner Ensemble: De Profundis By Oscar Wilde". No fuzzy substring
  // match: "Hamlet" must not certify "Hamletmachine" or a related-show card.
  const names = [String(title || ''), ...String(title || '').split(/:\s+/)];
  return names.some(name => [name, name.replace(/\s+by\s+.+$/i, '')]
    .some(t => normalizeTitle(t) === normalizeTitle(expected)));
}

function isoDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^\d{4}-\d{2}-\d{2}(?=$|T)/);
  if (!m) return null;
  const date = new Date(`${m[0]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === m[0] ? m[0] : null;
}

function eventNodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(eventNodes);
  const own = ['Event', 'TheaterEvent', 'PerformingArtsEvent'].some(t => hasJsonLdType(value, t)) ? [value] : [];
  return [...own, ...eventNodes(value['@graph']), ...eventNodes(value.mainEntity)];
}

function parsedEvidence(title, venue, start, end) {
  return {
    titleParse: { rawTitle: title, market: 'London', venue, year: null },
    dates: { openingDate: start, closingDate: end },
    tagLine: null,
  };
}

function parseLondonEvidence(html, show) {
  const dom = new JSDOM(html);
  try {
    const doc = dom.window.document;
    const events = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      for (const ev of eventNodes(parseJsonLd(script.textContent))) {
        if (!titleMatches(ev.name, show.title)) continue;
        const start = isoDate(ev.startDate);
        const end = isoDate(ev.endDate);
        if (!start || !end || end < start) continue;
        // A same-day Event is one performance (OLT lists the first date), not the run's
        // end: stick-man and speculations read as closing on their opening day (BRO-5975).
        const runEnd = end === start && show.closingDate && show.closingDate !== start ? null : end;
        const locations = Array.isArray(ev.location) ? ev.location : [ev.location];
        const venue = locations.map(l => typeof l === 'string' ? l : l?.name).find(Boolean) || null;
        events.push(parsedEvidence(ev.name, venue, start, runEnd));
      }
    }
    // Preserve separate runs; never merge same-title events across years or
    // venues. Prefer the requested house and closest date when a listing has
    // several runs, while retaining a wrong-house candidate as a mismatch.
    if (events.length) {
      const rank = e => (venuesMatch(e.titleParse.venue || '', show.venue || '') ? 0 : 1e7)
        + (show.openingDate ? Math.abs(Date.parse(e.dates.openingDate) - Date.parse(show.openingDate)) / 86400000 : 0);
      return events.sort((a, b) => rank(a) - rank(b))[0];
    }

    // Venue event pages also publish UK date ranges as visible text. Only
    // read the production heading and its nearby date block, never the URL,
    // footer year, publication date, or a season's related-show cards.
    for (const el of doc.querySelectorAll('script, style, nav, footer, aside')) el.remove();
    const heading = doc.querySelector('main h1, article h1, h1');
    if (!heading || !titleMatches(heading.textContent.trim(), show.title)) return null;
    const root = heading.closest('main, article') || doc.body;
    for (const el of root.querySelectorAll('p, div, br, h1, h2, h3, time')) {
      el.before(doc.createTextNode(' '));
      el.after(doc.createTextNode(' '));
    }
    const text = root.textContent.replace(/\s+/g, ' ').trim();
    const headingText = heading.textContent.replace(/\s+/g, ' ').trim();
    const offset = text.indexOf(headingText) + headingText.length;
    let nearby = text.slice(offset, offset + 400);
    const nextHeading = [...root.querySelectorAll('h1, h2, h3')]
      .find(el => el !== heading && (heading.compareDocumentPosition(el) & 4)
        && /related|also like|you may|other productions?|other events|more events/i.test(el.textContent));
    if (nextHeading) {
      const boundary = nearby.indexOf(nextHeading.textContent.replace(/\s+/g, ' ').trim());
      if (boundary >= 0) nearby = nearby.slice(0, boundary);
    }
    // An explicit year is mandatory; parseDateRangeText's nearest-year
    // inference is suitable for discovery, not cross-validating a revival.
    const range = nearby.match(/(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+)?\b\d{1,2}(?:st|nd|rd|th)?(?:\s+[A-Za-z]+)?\s*[-\u2013\u2014]\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+)?\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}\b/i);
    if (!range) return null;
    const dates = parseDateRangeText(range[0], { dayFirst: true });
    if (!dates.firstDate || !dates.lastDate) return null;
    // A page's visible production venue can confirm the house. Its host alone
    // cannot: the Barbican and National Theatre each have several auditoria.
    const venueNode = root.querySelector('[itemprop="location"], .event-venue, .venue, .location');
    const venueText = venueNode?.textContent.replace(/\s+/g, ' ').trim();
    const venue = venueText && nearby.includes(venueText) ? venueText : null;
    return parsedEvidence(heading.textContent.trim(), venue, dates.firstDate, dates.lastDate);
  } finally { dom.window.close(); }
}

async function validateLondonShow(show, {
  fetchPage = require('./scraper').fetchPage,
  serpQuery = require('./url-discovery').serpQuery,
  log = () => {},
} = {}, budget) {
  const domains = londonSources(show);
  const base = { id: show.id, title: show.title, venue: show.venue, validationSource: 'london', playbillUrl: null, mismatches: [], parsed: null };
  const tried = new Set();
  let anyQueryCompleted = false;
  let fetchFailed = false;
  let fallback = null;
  const outOfTime = () => budget?.exceeded() === true;
  // Maximum three page fetches per show, including existing evidence links.
  // No LLM calls, no per-performance requests, and no Playbill cache writes.
  async function check(url) {
    if (outOfTime() || !allowedSource(url, domains) || tried.has(url) || tried.size >= 3) return null;
    tried.add(url);
    log(`  London source: ${url}`);
    try {
      const response = await fetchPage(url, { timeout: 30000 });
      const parsed = parseLondonEvidence(response.content || '', show);
      if (!parsed) return null;
      // Empty URL intentionally: compareShow's Playbill URL-year heuristic
      // must never derive London metadata from a URL.
      const comparison = compareShow({ ...show, category: show.category || 'west-end' }, parsed, '');
      // Undated provisional rows still name a production year. Read that
      // year from the record ID, and the source year from the actual event
      // date. Numeric titles must not supply the record's production year.
      if (!show.openingDate) {
        // The announced previews date beats the id year: an id minted in 2026 for a
        // run that starts 2027-03-30 (bluebirds-off-west-end-2026) is not a wrong year.
        const idYear = show.id?.match(/(?:^|-)((?:19|20)\d{2})$/)?.[1];
        const previewsYear = typeof show.previewsStartDate === 'string' && /^\d{4}-/.test(show.previewsStartDate)
          ? show.previewsStartDate.slice(0, 4) : null;
        // Only the id year or the next: a previews date copied from an old page must not mask a stale id.
        const expectedYear = previewsYear && idYear && (Number(previewsYear) - Number(idYear) === 1) ? previewsYear : (idYear || previewsYear);
        const sourceYear = parsed.dates.openingDate.slice(0, 4);
        if (expectedYear && expectedYear !== sourceYear) {
          comparison.mismatches.push({ field: 'opening-year', shows: Number(expectedYear), playbill: Number(sourceYear) });
        }
      }
      const row = { ...base, ...comparison, parsed, sourceUrl: url, urlSource: 'london', result: classifyComparison(comparison) };
      if (row.result === 'match') return row;
      // A second source may expose the venue or describe the correct run.
      if (!fallback || (fallback.result === 'mismatch' && row.result === 'venue-unverified')) fallback = row;
    } catch (e) {
      fetchFailed = true;
      log(`  London fetch failed: ${e.message}`);
    }
    return null;
  }
  for (const url of [show.officialUrl, ...(show.evidenceUrls || [])].filter(Boolean)) {
    if (outOfTime()) break;
    const row = await check(url);
    if (row) return row;
  }
  for (const domain of domains) {
    if (outOfTime() || tried.size >= 3) break;
    const query = `site:${domain} "${show.title}" "${show.venue || ''}"`;
    let results;
    try { results = await serpQuery(query, { nbResults: 5 }); }
    catch (e) { log(`  London search failed: ${e.message}`); continue; }
    if (!Array.isArray(results)) continue;
    anyQueryCompleted = true;
    for (const result of results) {
      if (outOfTime()) break;
      const row = await check(result.url);
      if (row) return row;
    }
  }
  return fallback || { ...base, result: outOfTime() ? 'budget-exhausted' : fetchFailed ? 'fetch-error' : anyQueryCompleted ? 'no-london-url' : 'serp-error' };
}

module.exports = { isLondonShow, routeVenueValidation, londonSources, parseLondonEvidence, validateLondonShow };
