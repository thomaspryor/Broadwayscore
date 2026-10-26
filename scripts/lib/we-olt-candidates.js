'use strict';

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
const { venueFamily, signalMatchesListing, decideWeHistoricalPromotion } = require('./we-historical-corroboration');

const DAY_MS = 86400000;
const AZ_EARLY_DAYS = 7;
const AZ_LATE_DAYS = 14;

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

/** TR A-Z title row ({title, venue, opened}) naming this OLT listing's production? */
function azMatchesListing(az, l) {
  if (!az?.opened || !az.title || !titlesMatch(az.title, l.title)) return false;
  if (az.venue && !sameVenue(az.venue, l.venue)) return false;
  const first = Date.parse(l.previewsStartDate || l.openingDate || '');
  const press = Date.parse(l.openingDate || l.previewsStartDate || '');
  const d = Date.parse(az.opened);
  if ([first, press, d].some(Number.isNaN)) return false;
  return d >= first - AZ_EARLY_DAYS * DAY_MS && d <= press + AZ_LATE_DAYS * DAY_MS;
}

/** One production can sit under several OLT item ids; keep the most recent snapshot. */
function collapseItems(pages) {
  const byKey = new Map();
  for (const p of pages) {
    const key = `${normalizeTitle(p.title)}|${venueFamily(p.venue)}|${p.openingDate || p.previewsStartDate}`;
    const prev = byKey.get(key);
    if (!prev || String(p.snapshot) > String(prev.snapshot)) byKey.set(key, p);
  }
  return [...byKey.values()];
}

/**
 * @param {{season: string, pages: Array<{item: string, url: string, snapshot: string, title: string, venue: string|null,
 *          genre?: string|null, previewsStartDate: string|null, openingDate: string|null, closingDate: string|null}>,
 *          azTitles?: Array<{title: string, venue?: string|null, opened?: string|null}>,
 *          reviews?: Array, oliviers?: Array, shows: Array, today?: string}} input
 */
function buildOltCandidates({ season, pages, azTitles = [], reviews = [], oliviers = [], shows, today }) {
  const inSeason = collapseItems(pages.filter(p => {
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
    const review = reviews.find(r => signalMatchesListing(r, l));
    if (review) signals.push('wos-review');
    for (const o of oliviers) {
      if (signalMatchesListing(o, l) && !signals.includes(`olivier-${o.year}`)) signals.push(`olivier-${o.year}`);
    }
    const startDate = l.openingDate || l.previewsStartDate;
    const dupOpts = { withinYears: 1, startDate, venueEquals: sameVenue };
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
      },
      ...(az ? { trAz: { title: az.title, venue: az.venue || null, opened: az.opened } } : {}),
      inShowsJson: existing ? (existing.id || existing.title) : (subtitleOf || null),
    };
    if (candidate.inShowsJson) {
      candidate.decision = { promotable: false, persistent: true, reason: `already in shows.json: ${candidate.inShowsJson}` };
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

module.exports = { buildOltCandidates, azMatchesListing, collapseItems, genreSlugs };
