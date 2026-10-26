'use strict';

// venue-write-guard-ok: venue fields go to audit candidate rows and matching only; promote-historical-we.js writes through sanitizeVenueForWrite.

/**
 * WE historical seasons from archived Official London Theatre listings
 * (BRO-6343). Pure: parsed OLT pages + second-source signals + shows.json
 * -> candidate rows in the we-historical-candidates shape, each with a
 * decideWeHistoricalPromotion() verdict, for promote-historical-we.js.
 *
 * OLT (run by SOLT) is the dated listing: venue, previews, press night,
 * closing. Each row still needs a second, independent dated source naming
 * the same production before it is promotable:
 *   - tr-az:       Theatre Record A-Z entry, same title, press night within
 *                  [first preview - 7 days, OLT press night + 14 days], venue
 *                  agreeing when TR gives one
 *   - wos-review:  a WhatsOnStage review in the run window
 *   - olivier-YYYY: an Olivier nomination naming the title at that venue
 *   - tr-page:     a Theatre Record production page (we-historical-tr-resolve
 *                  lookups) for the title at that venue, in a TR volume of the
 *                  run's years, its A-Z date within the run window
 *
 * The closing date must be confirmed: the newest archived snapshot has to
 * be dated on or after the closing it shows. A page captured before the
 * close shows the then-scheduled date, which extensions and early closures
 * change, so such a row is held back (not persistent: a later snapshot can
 * confirm it).
 */

const { normalizeTitle } = require('./title-match');
const { titlesMatch } = require('./title-normalization');
const { isWestEndVenue } = require('./venue-classification');
const { isDateInSeason } = require('./we-seasons');
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./venue-title-dedup-pool');
const { venuesMatch } = require('./deduplication');
const { cleanOltTitle } = require('./olt-archive-parse');
const { venueFamily, signalMatchesListing, decideWeHistoricalPromotion } = require('./we-historical-corroboration');
const { parseTrHeaderDates } = require('./we-review-led-candidates');

const DAY_MS = 86400000;
const AZ_EARLY_DAYS = 7;
const AZ_LATE_DAYS = 14;
const AZ_SEASON_SLACK_DAYS = 2;
// Same title + venue: OLT item ids within this many days are one production.
const COLLAPSE_DAYS = 30;
// A shows.json row this close in start date is the same production. Wider
// would swallow a return season (Cats, Palladium: Dec 2014 and Oct 2015).
const EXISTING_WITHIN_YEARS = 0.5;
// A run opening this soon after the same title closed at another house is a
// transfer leg of that production, not a new one.
const TRANSFER_GAP_DAYS = 21;

// OLT genre labels -> the WOS-style slugs decideWeHistoricalPromotion screens.
const GENRE_SLUGS = {
  play: 'play', musical: 'musical', comedy: 'comedy', opera: 'opera', dance: 'dance', ballet: 'ballet',
  'children\'s': 'children', children: 'children', family: 'family', concert: 'concert', pantomime: 'pantomime',
  'entertainment': 'event', 'special event': 'special-event', circus: 'circus', cabaret: 'cabaret',
};

function genreSlugs(genre) {
  if (!genre) return [];
  return String(genre).toLowerCase().split(/\s*[,/&]\s*|\s+and\s+/).map(g => g.trim())
    // "Musical comedy", "Rock musical", ... are musicals.
    .map(g => GENRE_SLUGS[g] || (/\bmusical\b/.test(g) ? 'musical' : g.replace(/\s+/g, '-'))).filter(Boolean);
}

const sameVenue = (a, b) => venuesMatch(a, b) || venueFamily(a) === venueFamily(b);

/**
 * TR A-Z title row ({title, venue, opened, seasonFrom}) naming this OLT
 * listing's production? A limited run in the 2015 A-Z layout carries
 * "season dd.mm-dd.mm.yy" instead of an opened date; its first performance
 * falls in the same previews-to-press-night window.
 */
function azMatchesListing(az, l) {
  const when = az?.opened || az?.seasonFrom;
  if (!when || !az.title || !titlesMatch(az.title, l.title)) return false;
  if (az.venue && !sameVenue(az.venue, l.venue)) return false;
  const first = Date.parse(l.previewsStartDate || l.openingDate || '');
  const press = Date.parse(l.openingDate || l.previewsStartDate || '');
  const d = Date.parse(when);
  if ([first, press, d].some(Number.isNaN)) return false;
  if (az.opened) return d >= first - AZ_EARLY_DAYS * DAY_MS && d <= press + AZ_LATE_DAYS * DAY_MS;
  // A season row has no venue in the 2015 layout and the A-Z covers the
  // fringe, so a same-title fringe season must not pass: its first
  // performance has to fall in previews-to-press-night and its last within
  // AZ_LATE_DAYS of the OLT close.
  if (d < first - AZ_SEASON_SLACK_DAYS * DAY_MS || d > press) return false;
  const to = Date.parse(az.seasonTo || '');
  const close = Date.parse(l.closingDate || '');
  return !Number.isNaN(to) && !Number.isNaN(close) && Math.abs(to - close) <= AZ_LATE_DAYS * DAY_MS;
}

/**
 * TR production-page lookup ({review: {title, date}, tr: {title, venue, link}})
 * naming this OLT listing's production? The volume year must be a year the
 * run touches (volume 35 = 2015): an older production of the title at the
 * same house sits in an older volume.
 */
function trPageMatchesListing(lookup, l) {
  const tr = lookup?.tr;
  if (!tr?.title || !tr.venue || !tr.link) return false;
  const vol = /\/archive\/volume\/(\d+)\//.exec(tr.link);
  if (!vol) return false;
  const year = 1980 + Number(vol[1]);
  const startYear = Number(String(l.previewsStartDate || l.openingDate || '').slice(0, 4));
  const endYear = Number(String(l.closingDate || '').slice(0, 4)) || startYear;
  if (!startYear || year < startYear || year > endYear) return false;
  return signalMatchesListing({ title: tr.title, venue: tr.venue, date: lookup.review?.date || null }, l);
}

/**
 * One production can sit under several OLT item ids, sometimes with dates a
 * few days apart; keep the most recent snapshot of each title + venue +
 * start within COLLAPSE_DAYS.
 */
function collapseItems(pages) {
  const kept = [];
  const startOf = p => Date.parse(p.openingDate || p.previewsStartDate || '');
  for (const p of pages) {
    const key = `${normalizeTitle(p.title)}|${venueFamily(p.venue)}`;
    const i = kept.findIndex(k => k.key === key && Math.abs(startOf(k.page) - startOf(p)) <= COLLAPSE_DAYS * DAY_MS);
    if (i < 0) kept.push({ key, page: p });
    else if (String(p.snapshot) > String(kept[i].page.snapshot)) kept[i].page = p;
  }
  return kept.map(k => k.page);
}

/**
 * The closing date a Theatre Record production header states outright
 * ("Closes 17 Sep 2016", "Until ..."). A bare "12 - 25 February 2016" line
 * is the TR issue's review period, not the run, so it is ignored.
 */
function trStatedClosing(header) {
  if (!/\b(?:closes|closing|until|final performance|ends)\b/i.test(String(header || ''))) return null;
  return parseTrHeaderDates(header).closingDate;
}

/** The listing an OLT run transferred from: same title, another house, closed just before it opened. */
function transferredFrom(l, listings) {
  if (l.previewsStartDate) return null;
  const start = Date.parse(l.openingDate || '');
  return listings.find(o => o !== l && o.closingDate && titlesMatch(o.title, l.title) && !sameVenue(o.venue, l.venue)
    && start - Date.parse(o.closingDate) >= 0 && start - Date.parse(o.closingDate) <= TRANSFER_GAP_DAYS * DAY_MS) || null;
}

/**
 * @param {{season: string, pages: Array<{item: string, url: string, snapshot: string, title: string, venue: string|null,
 *          genre?: string|null, previewsStartDate: string|null, openingDate: string|null, closingDate: string|null}>,
 *          azTitles?: Array<{title: string, venue?: string|null, opened?: string|null}>,
 *          trPages?: Array<{review?: {title: string, date?: string|null}, tr?: {title: string, venue: string, link: string}|null}>,
 *          reviews?: Array, oliviers?: Array, shows: Array, today?: string}} input
 */
function buildOltCandidates({ season, pages, azTitles = [], trPages = [], reviews = [], oliviers = [], shows, today }) {
  // Pages cached before cleanOltTitle existed still carry "Duration 2h30".
  const inSeason = collapseItems(pages.map(p => ({ ...p, title: cleanOltTitle(p.title) || null })).filter(p => {
    const start = p.openingDate || p.previewsStartDate;
    return p.title && start && p.venue && isWestEndVenue(p.venue) && isDateInSeason(start, season);
  }));
  const pool = buildVenueTitlePool(shows);
  const westEndIds = new Set(shows.filter(s => s.market === 'west-end').map(s => s.id));
  const candidates = [];
  for (const l of inSeason) {
    const signals = [];
    const az = azTitles.find(a => azMatchesListing(a, l));
    if (az) signals.push('tr-az');
    const trPage = trPages.find(t => trPageMatchesListing(t, l));
    if (trPage) signals.push('tr-page');
    const review = reviews.find(r => signalMatchesListing(r, l));
    if (review) signals.push('wos-review');
    for (const o of oliviers) {
      if (signalMatchesListing(o, l) && !signals.includes(`olivier-${o.year}`)) signals.push(`olivier-${o.year}`);
    }
    const startDate = l.openingDate || l.previewsStartDate;
    const dupOpts = { withinYears: EXISTING_WITHIN_YEARS, startDate, venueEquals: sameVenue };
    const existing = findExactDuplicate(pool, l.title, l.venue, dupOpts)
      || pool.find(s => s.startDate && westEndIds.has(s.id) && normalizeTitle(s.title) === normalizeTitle(l.title)
        && Math.abs(Date.parse(s.startDate) - Date.parse(startDate)) <= 7 * DAY_MS);
    const subtitleOf = !existing && findSubtitleDuplicateTitle(pool, l.title, l.venue, dupOpts);
    const snapshotDay = /^\d{8}/.test(String(l.snapshot)) ? `${l.snapshot.slice(0, 4)}-${l.snapshot.slice(4, 6)}-${l.snapshot.slice(6, 8)}` : null;
    const candidate = {
      title: l.title,
      venue: l.venue,
      previewsStartDate: l.previewsStartDate || null,
      openingDate: l.openingDate || null,
      openingDateSource: 'official-london-theatre',
      closingDate: l.closingDate || null,
      genres: genreSlugs(l.genre),
      season,
      signals,
      origin: 'olt',
      snapshotDate: snapshotDay,
      sourceUrls: {
        olt: `https://web.archive.org/web/${l.snapshot}/${l.url}`,
        ...(review ? { wosReview: review.url } : {}),
        ...(trPage ? { theatreRecord: trPage.tr.link } : {}),
      },
      ...(az ? { trAz: { title: az.title, venue: az.venue || null, opened: az.opened || null, ...(az.seasonFrom ? { seasonFrom: az.seasonFrom } : {}) } } : {}),
      inShowsJson: existing ? (existing.id || existing.title) : (subtitleOf || null),
    };
    const trClosing = trPage && trStatedClosing(trPage.header);
    const transfer = transferredFrom(l, inSeason);
    if (candidate.inShowsJson) {
      candidate.decision = { promotable: false, persistent: true, reason: `already in shows.json: ${candidate.inShowsJson}` };
    } else if (transfer) {
      candidate.decision = { promotable: false, persistent: true, reason: `transfer leg of the ${transfer.venue} run (closed ${transfer.closingDate})` };
    } else if (trClosing && candidate.closingDate && trClosing !== candidate.closingDate) {
      candidate.decision = { promotable: false, persistent: false, reason: `closing conflict: OLT ${candidate.closingDate}, Theatre Record ${trClosing}` };
    } else if (candidate.closingDate && (!snapshotDay || snapshotDay < candidate.closingDate)) {
      candidate.decision = { promotable: false, persistent: false, reason: `closing ${candidate.closingDate} unconfirmed: newest OLT snapshot ${snapshotDay} predates it` };
    } else {
      candidate.decision = decideWeHistoricalPromotion(candidate, { today });
    }
    candidates.push(candidate);
  }
  candidates.sort((a, b) => String(a.openingDate || a.previewsStartDate).localeCompare(String(b.openingDate || b.previewsStartDate)));
  return candidates;
}

module.exports = { buildOltCandidates, azMatchesListing, trPageMatchesListing, collapseItems, genreSlugs, trStatedClosing, transferredFrom };
