'use strict';

// BRO-7428: exact opening-night evidence from the venue, independently of
// Playbill's 30-day tolerance. Audit only; this module never writes show data.
const cheerio = require('cheerio');
const { normalizeTitle } = require('./title-match');
const { OB_VENUE_CONFIGS } = require('./venue-listing-discover');
const { parseDateRangeText } = require('./ob-listing-platforms');
// venue-write-guard-ok: validation report rows only; never writes shows.json.

const DAY_MS = 86400000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function isVenueOpeningCandidate(show, todayIso = new Date().toISOString().slice(0, 10)) {
  if (show.category !== 'off-broadway' || !String(show.discoverySource || '').startsWith('venue-page:')
      || !['upcoming', 'announced', 'previews', 'open'].includes(show.status)
      || !isoDate(show.openingDate) || !isoDate(todayIso)) return false;
  const days = (Date.parse(show.openingDate) - Date.parse(todayIso)) / DAY_MS;
  return days >= 0 && days <= 10;
}

// Keep the audit's existing rotation order within each group. A previously
// clean show about to open must be reached before a large historical backlog.
function prioritizeVenueOpeningChecks(shows, todayIso) {
  return [...shows.filter(s => isVenueOpeningCandidate(s, todayIso)),
    ...shows.filter(s => !isVenueOpeningCandidate(s, todayIso))];
}

function textOf($, node) {
  const copy = $(node).clone();
  copy.find('br').replaceWith(' ');
  return copy.text().replace(/\s+/g, ' ').trim();
}

/** Pure parser. Only a labelled key-date row counts, never a run's first
 * performance, on-sale date, calendar badge, URL or a related show's date.
 * A yearless key date needs a dated run on the page, not a guessed year.
 */
function parseVenueOpeningNight(html, show) {
  if (!html || !isoDate(show.openingDate)) return null;
  const $ = cheerio.load(html);
  $('script, style, nav, footer, aside, [hidden], [aria-hidden="true"]').remove();
  const heading = $('h1').first().text().trim() || $('title').text().split('|')[0].trim();
  if (!heading || normalizeTitle(heading) !== normalizeTitle(show.title)) return null;

  const ranges = [];
  $('.date-summary, .event-details__date').each((_, node) => {
    const text = textOf($, node);
    if (!/\b20\d{2}\b/.test(text)) return;
    const range = parseDateRangeText(text, { todayIso: show.openingDate });
    if (range.firstDate && range.lastDate) ranges.push(range);
  });
  // An archived page for a prior run of the same title is not this production.
  const runStart = isoDate(show.previewsStartDate) ? show.previewsStartDate : show.openingDate;
  const runEnd = isoDate(show.closingDate) ? show.closingDate : show.openingDate;
  if (ranges.length && !ranges.some(r => r.firstDate <= runEnd && r.lastDate >= runStart)) return null;

  const snippets = new Set();
  $('span, strong, b, dt, th, h2, h3, h4, p, li, div, td').each((_, node) => {
    const text = textOf($, node);
    if (/^opening night\b/i.test(text) && text.length <= 180) snippets.add(text);
    if (/^opening night\s*:?$/i.test(text)) {
      snippets.add(`Opening Night ${textOf($, $(node).next())}`);
    }
  });

  const dates = new Map();
  for (const snippet of snippets) {
    const match = snippet.match(/^opening night\s*:?\s*(?:private event\s*)?(?:on\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?([a-z]+)\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?(?=\s|$|,)/i);
    if (!match) continue;
    const month = MONTHS.findIndex(m => m === match[1].toLowerCase()
      || m.slice(0, 3) === match[1].toLowerCase());
    if (month < 0) continue;
    const year = Number(show.openingDate.slice(0, 4));
    const years = match[3] ? [Number(match[3])] : [year - 1, year, year + 1];
    const candidates = years.map(y => `${y}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`)
      .filter(isoDate)
      .filter(date => (!ranges.length && !!match[3])
        || ranges.some(r => date >= r.firstDate && date <= r.lastDate));
    if (candidates.length === 1) dates.set(candidates[0], snippet);
  }
  if (dates.size !== 1) return null;
  const [[openingDate, evidence]] = dates;
  return { openingDate, evidence };
}

function venueConfig(show) {
  return OB_VENUE_CONFIGS.find(v => show.discoverySource
    === `venue-page:${v.name.toLowerCase().replace(/\s+/g, '-')}`);
}

function venueUrl(value, base) {
  try {
    const url = new URL(value, base);
    const host = u => u.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || host(url) !== host(new URL(base))) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

async function checkVenueOpening(show, { fetchPage, log }) {
  const venue = venueConfig(show);
  if (!venue) return { result: 'unverified', reason: 'unknown-venue' };
  // URL paths are used only to avoid home/listing pages, never as metadata.
  const isDetail = url => url && new URL(url).pathname !== '/'
    && new URL(url).pathname.replace(/\/$/, '') !== new URL(venue.url).pathname.replace(/\/$/, '');
  const known = [show.officialUrl, ...(show.ticketLinks || [])
    .filter(t => t.platform === 'Venue Box Office').map(t => t.url)]
    .filter(Boolean).map(u => venueUrl(u, venue.url)).find(isDetail);
  let url = known;
  try {
    if (!url) {
      // Discovery already knows this house. Resolve the show's page by link
      // TEXT on that listing, with no SERP and no title inference from slugs.
      const listing = await fetchPage(venue.url, { timeout: 30000 });
      const $ = cheerio.load(listing?.content || '');
      const links = new Set();
      $('a[href]').each((_, a) => {
        if (normalizeTitle($(a).text().trim()) !== normalizeTitle(show.title)) return;
        const candidate = venueUrl($(a).attr('href'), venue.url);
        if (isDetail(candidate)) links.add(candidate);
      });
      if (links.size !== 1) return { result: 'unverified', reason: 'no-unique-show-page', sourceUrl: venue.url };
      [url] = links;
    }
    log(`  Venue opening-night page: ${url}`);
    const response = await fetchPage(url, { timeout: 30000 });
    const parsed = parseVenueOpeningNight(response?.content, show);
    if (!parsed) return { result: 'unverified', reason: 'no-unambiguous-opening-night', sourceUrl: url };
    return { ...parsed, sourceUrl: url,
      result: parsed.openingDate === show.openingDate ? 'match' : 'mismatch' };
  } catch (_) {
    return { result: 'unverified', reason: 'fetch-error', sourceUrl: url || venue.url };
  }
}

// Wired ahead of the ordinary venue validator so a missing Playbill page
// cannot conceal a venue's explicit postponement. The existing audit writer,
// --fail-on-mismatch exit and daily workflow notification handle the finding.
async function validateWithVenueOpeningNight(show, {
  fetchPage, validateFallback, log = () => {}, todayIso,
}) {
  if (!isVenueOpeningCandidate(show, todayIso)) return validateFallback(show);
  const venueOpeningNight = await checkVenueOpening(show, { fetchPage, log });
  if (venueOpeningNight.result === 'mismatch') {
    return {
      id: show.id, title: show.title, venue: show.venue, result: 'mismatch',
      sourceUrl: venueOpeningNight.sourceUrl, playbillUrl: null, parsed: null,
      venueOpeningNight,
      mismatches: [{ field: 'openingDate', shows: show.openingDate,
        // Legacy audit consumers display this key as the external date.
        playbill: venueOpeningNight.openingDate, source: 'venue-opening-night',
        sourceUrl: venueOpeningNight.sourceUrl,
        deltaDays: Math.abs(Date.parse(show.openingDate) - Date.parse(venueOpeningNight.openingDate)) / DAY_MS }],
    };
  }
  if (venueOpeningNight.result === 'unverified') {
    log(`::warning::${show.id}: venue opening night unverified (${venueOpeningNight.reason})`);
  }
  return { ...await validateFallback(show), venueOpeningNight };
}

module.exports = { isVenueOpeningCandidate, prioritizeVenueOpeningChecks,
  parseVenueOpeningNight, validateWithVenueOpeningNight };
