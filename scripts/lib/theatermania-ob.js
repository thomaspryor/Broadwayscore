/**
 * TheaterMania Off-Broadway listings (BRO-4381).
 *
 * Off-Broadway discovery leaned on TodayTix, Playbill's OB schedule article
 * and a subset of venue-page scrapers. A diff against BroadwayWorld and
 * TheaterMania (BRO-4377, 2026-09-29) found 16 current OB productions we were
 * missing, most at venues we already classify (HERE, 59E59, Cherry Lane,
 * Theatre Row, Axis, Flea, A.R.T./New York...). TheaterMania lists them with
 * structured dates through its public WordPress REST API:
 *
 *   GET /wp-json/wp/v2/shows?market=98&orderby=modified&order=desc
 *     market 98 = Off-Broadway (99 = Off-Off-Broadway, out of scope)
 *     acf.preview_date / opening_date / closing_date = 'YYYYMMDD' or ''
 *     acf.the_venue = [venueId]  → /wp-json/wp/v2/venue?include=...
 *     genre = [genreId]          → /wp-json/wp/v2/genre?include=...
 *
 * The market holds ~7,900 rows back to the 2000s. Ordered by `modified`, the
 * current ones sit in the first two pages (measured 2026-09-29: 77 on page 1,
 * 14 on page 2, 0 on page 3), so we page until a page carries no current row.
 *
 * Everything here except the fetch helpers is pure and fixture-tested
 * (scripts/lib/theatermania-ob.test.mjs, CLAUDE.md §15). discover-new-shows.js
 * and check-off-broadway-source-coverage.js both consume it.
 */

'use strict';

const https = require('https');
const { decodeHtmlEntities } = require('./text-cleaning');
const { foldDiacritics } = require('./title-match');
const { sanitizeVenueForWrite, isNonNycVenue, isKnownOffBroadwayVenue } = require('./venue-classification');

const TM_BASE = 'https://www.theatermania.com/wp-json/wp/v2';
const TM_OB_MARKET_ID = 98;
const TM_PAGE_SIZE = 100;
const TM_MAX_PAGES = 5;
const TM_USER_AGENT = 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0; +https://broadwayscorecard.com)';
const TM_FIELDS = 'id,title,link,modified,genre,acf.preview_date,acf.opening_date,acf.closing_date,acf.the_venue,acf.synopsis';

// An open-ended row (no closing_date) counts as current only if it started
// within this window. Older open-ended rows are long-runners we already carry
// (Gazillion Bubble Show, 2007) or stale listings nobody closed out: live on
// 2026-09-29, "A Woman Among Women" (closed June 28, no closing_date on TM)
// and a one-night May dance evening both sat at 130+ days.
const OPEN_ENDED_LOOKBACK_DAYS = 120;

// NYC boroughs as TheaterMania writes them in venue acf.city. An empty city is
// common (Marjorie S. Deane Little Theater) and is NOT treated as non-NYC.
const NYC_CITIES = new Set(['new york', 'new york city', 'nyc', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island', 'manhattan', 'long island city', 'astoria']);

// Genre names that mark a staged production. Checked before the non-staged
// set: "Music" or "Concert" on a row also tagged "Play" is still a play.
const STAGED_GENRES = new Set([
  'play', 'musical', 'theater', 'play with music', 'drama', 'comedy',
  'solo performance', 'puppetry', 'immersive/interactive', 'interactive / immersive',
  'thriller', 'horror', 'parody', 'performance art', 'family', 'family/kids', 'family / kids',
]);
// Rows tagged ONLY with these are concerts / cabaret / opera, not the staged
// productions the site covers. Mapped to TodayTix's 'Concerts' category so
// isNonTheaterContent() rejects them through its existing Gate 1b.
const NON_STAGED_GENRES = new Set(['concert', 'cabaret', 'music', 'song cycle', 'opera', 'drag']);

/** 'YYYYMMDD' → 'YYYY-MM-DD', or null for blank/malformed/impossible values. */
function parseTmDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

// Straight quotes: TheaterMania emits &#8217; (’), shows.json titles use ' by
// ~10:1, and checkForDuplicate's exact-title check compares literally.
function cleanText(raw) {
  return decodeHtmlEntities(String(raw || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Map TheaterMania dates onto our fields.
 *   preview + opening (preview <= opening) → previewsStartDate + openingDate
 *     with openingDateSource 'theatermania' (unconfirmed: Playbill, IBDB,
 *     review-inference may overwrite it, see date-source-confidence.js).
 *   opening only → TheaterMania often fills just opening_date with the first
 *     performance, so it becomes previewsStartDate and openingDate stays null.
 *   preview after opening (bad data: live 2026-09-29, "Beautiful Jolie Gabor"
 *     had a 2027-06-11 preview, a 2026-06-27 opening and a 2027-07-18
 *     closing) → `inconsistent: true` and no dates. Either reading could be
 *     the typo, and a wrong past date would flip the show to previews and
 *     open review collection a year early, so the row waits for TM to fix it.
 */
function mapTmDates(acf) {
  const preview = parseTmDate(acf && acf.preview_date);
  const opening = parseTmDate(acf && acf.opening_date);
  const closing = parseTmDate(acf && acf.closing_date);
  if (preview && opening && preview > opening) {
    return { previewsStartDate: null, openingDate: null, openingDateSource: null, closingDate: null, inconsistent: true };
  }
  if (preview && opening) {
    return { previewsStartDate: preview, openingDate: opening, openingDateSource: 'theatermania', closingDate: closing };
  }
  return { previewsStartDate: preview || opening || null, openingDate: null, openingDateSource: null, closingDate: closing };
}

/**
 * Is this row a current or upcoming production as of todayIso?
 * Closing today or later, or open-ended and started within the lookback.
 */
function isCurrentTmRow(row, todayIso) {
  const acf = (row && row.acf) || {};
  const closing = parseTmDate(acf.closing_date);
  if (closing) return closing >= todayIso;
  const first = [parseTmDate(acf.preview_date), parseTmDate(acf.opening_date)].filter(Boolean).sort()[0];
  if (!first) return false;
  return first >= addDaysIso(todayIso, -OPEN_ENDED_LOOKBACK_DAYS);
}

/** TodayTix-style category from TM genre names, or null when unknown. */
function categoryFromGenres(genreNames) {
  const names = (genreNames || []).map(n => cleanText(n).toLowerCase()).filter(Boolean);
  if (names.includes('musical') || names.includes('play with music')) return 'Musicals';
  if (names.some(n => STAGED_GENRES.has(n))) return 'Plays';
  if (names.some(n => NON_STAGED_GENRES.has(n))) return 'Concerts';
  return null;
}

/**
 * Pick the row's venue. Multi-venue rows name the producing company and the
 * house ("Roundabout Theatre" + "Laura Pels Theatre at the ..."); the last
 * listed is the house in every live example, so prefer it.
 * @returns {{ name: string|null, city: string }}
 */
function resolveTmVenue(row, venuesById) {
  const ids = Array.isArray(row && row.acf && row.acf.the_venue) ? row.acf.the_venue : [];
  const venues = ids.map(id => venuesById && venuesById.get(Number(id))).filter(Boolean);
  if (venues.length === 0) return { name: null, city: '' };
  const v = venues[venues.length - 1];
  return {
    name: cleanText(v.title && v.title.rendered !== undefined ? v.title.rendered : v.title) || null,
    city: cleanText(v.acf && v.acf.city),
  };
}

function isNycCity(city) {
  const c = String(city || '').trim().toLowerCase();
  return !c || NYC_CITIES.has(c);
}

/**
 * One TheaterMania row → the TodayTix-shaped object the discovery gates read
 * (isNonTheaterContent / isOneNightShow) plus the discovery-pipeline
 * candidate, or a skip reason. Venue goes through sanitizeVenueForWrite here
 * so no caller can write a placeholder (card #994).
 *
 * @returns {{ skip: string } | { gateShape: object, candidate: object }}
 */
function parseTmOffBroadwayRow(row, { venuesById = new Map(), genresById = new Map() } = {}) {
  const title = cleanText(row && row.title && row.title.rendered);
  if (!title) return { skip: 'no title' };

  const { name: rawVenue, city } = resolveTmVenue(row, venuesById);
  if (!isNycCity(city)) return { skip: `venue city "${city}" is outside NYC` };
  if (rawVenue && isNonNycVenue(rawVenue)) return { skip: `venue "${rawVenue}" is outside NYC` };
  const venue = sanitizeVenueForWrite(rawVenue);
  if (!venue) return { skip: `venue "${rawVenue || ''}" is a placeholder/blank` };

  const dates = mapTmDates(row.acf || {});
  if (dates.inconsistent) return { skip: 'preview_date is after opening_date' };
  if (!dates.previewsStartDate && !dates.openingDate) return { skip: 'no dates' };

  const genreNames = (row.genre || []).map(id => genresById.get(Number(id))).filter(Boolean);
  const category = categoryFromGenres(genreNames);
  const description = cleanText(row.acf && row.acf.synopsis).slice(0, 1000);

  const gateShape = {
    displayName: title,
    name: title,
    subcategories: [{ name: 'Off Broadway' }],
    category: category ? { name: category } : undefined,
    venue: { name: venue },
    description,
    startDate: dates.previewsStartDate || dates.openingDate,
    endDate: dates.closingDate || undefined,
  };

  const candidate = {
    title,
    venue,
    slug: foldDiacritics(title.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    openingDate: dates.openingDate,
    openingDateSource: dates.openingDateSource,
    previewsStartDate: dates.previewsStartDate,
    closingDate: dates.closingDate,
    category: 'off-broadway',
    description,
    source: 'theatermania-ob',
    // Same rule as the TodayTix venue fallback (obFallbackFlags in
    // discover-new-shows.js): a row at a venue we already classify as
    // Off-Broadway needs no extra check; one at a venue we don't know goes
    // through validate-show-venue.js --all-provisional for a Playbill
    // cross-check. Nothing clears `provisional`, and that sweep spends paid
    // SERP/fetch credits daily, so flagging every TM row would grow the pool
    // by ~15 shows a week for no gain (second-opinion review).
    ...(isKnownOffBroadwayVenue(venue) ? {} : { provisional: true }),
    discoverySource: 'theatermania-ob',
    theatermaniaUrl: row.link || null,
    theatermaniaId: row.id || null,
  };
  return { gateShape, candidate };
}

/**
 * Coverage diff for check-off-broadway-source-coverage.js: the current,
 * gate-passing TheaterMania OB productions that match nothing in shows.json
 * (NYC pool) or in a pending-fix add-show plan.
 *
 * `gates` are discover-new-shows.js's isNonTheaterContent / isOneNightShow,
 * passed in so this module never loads the discovery script.
 *
 * @returns {{ gaps: object[], parsedCount: number, skippedCount: number, gatedCount: number }}
 */
function findTmCoverageGaps({ rows, venuesById, genresById, shows, pendingShows = [], gates }) {
  const { buildShowTitleIndex, findUnmatchedCandidates } = require('./reverse-discovery');
  const parsed = [];
  let skippedCount = 0;
  for (const row of rows || []) {
    const r = parseTmOffBroadwayRow(row, { venuesById, genresById });
    if (r.skip) { skippedCount++; continue; }
    parsed.push(r);
  }
  const kept = parsed.filter(({ gateShape }) =>
    !(gates && gates.isNonTheaterContent && gates.isNonTheaterContent(gateShape)) &&
    !(gates && gates.isOneNightShow && gates.isOneNightShow(gateShape)));
  const index = buildShowTitleIndex([...(shows || []), ...(pendingShows || [])], 'nyc');
  const items = kept.map(({ candidate }) => ({
    title: candidate.title,
    source: 'theatermania-ob',
    url: candidate.theatermaniaUrl || 'https://www.theatermania.com/shows/new-york-city-theater/off-broadway/',
    venue: candidate.venue, // venue-write-guard-ok: audit report row; candidate.venue already went through sanitizeVenueForWrite
    date: candidate.openingDate || candidate.previewsStartDate || null,
    closingDate: candidate.closingDate || null,
  }));
  // allowClosedRevival: TheaterMania's current rows are live productions, so
  // a title matching only a closed catalogued run (a revival, a return
  // engagement) is still a gap, same as the Broadway guard.
  const titleGaps = findUnmatchedCandidates(items, index, { allowClosedRevival: true });
  // Then drop titles discovery's own matcher ties to a LIVE row ("Drunk
  // Dracula" ≡ "Drunk Dracula NYC", "Atlantic for Kids: Finn" ≡ "Finn" at the
  // same venue): alerting on those would name shows we already carry. A
  // match to a closed row does not count, for the reason above.
  const { checkForDuplicate } = require('./deduplication');
  const live = [...(shows || []), ...(pendingShows || [])].filter(s => s && s.title && typeof s.slug === 'string' && s.status !== 'closed' &&
    !(s.closingDate && s.closingDate < new Date().toISOString().slice(0, 10)));
  const byTitle = new Map(kept.map(({ candidate }) => [candidate.title, candidate]));
  const all = [...(shows || []), ...(pendingShows || [])].filter(s => s && s.title && typeof s.slug === 'string');
  const gaps = [];
  for (const g of titleGaps) {
    const cand = byTitle.get(g.title) || g;
    if (checkForDuplicate(cand, live).isDuplicate) continue;
    if (findTmSameTitleShow(cand, all)) continue; // discovery's TM fallback: same verdict here
    // Discovery skips a row that matches a closed catalogued run (it reads
    // as the same show), so it can never close this gap on its own: name the
    // closed row so the alert says what a human has to do.
    const closed = checkForDuplicate(cand, all);
    gaps.push(closed.isDuplicate && closed.existingShow ? { ...g, closedMatch: closed.existingShow.id } : g);
  }
  return { gaps, parsedCount: parsed.length, skippedCount, gatedCount: parsed.length - kept.length };
}

/**
 * Same-title fallback for TheaterMania candidates (ship-check review).
 * TM names venues coarsely ("Theatre Row" for our "Theatre Row, Theatre 5",
 * "Culture Club" for "The Night Egg at the Culture Club"), and
 * checkForDuplicate reads a different venue as a different production, so a
 * show we already carry could be re-minted once its id year or slug drifts.
 * TodayTix has its id index for this; TM rows get an exact-title match in
 * the NYC pool instead, limited to a row that is still running or whose
 * dates are within a year of the candidate's. A same-title revival years
 * later is still treated as new.
 *
 * @returns {object|null} the existing show this candidate duplicates
 */
function findTmSameTitleShow(candidate, shows) {
  const { getMarketPool } = require('./venue-classification');
  const key = titleKeyLoose(candidate.title);
  if (!key) return null;
  const candDate = candidate.openingDate || candidate.previewsStartDate || null;
  for (const s of shows || []) {
    if (!s || !s.title || getMarketPool(s.category) !== 'nyc') continue;
    if (titleKeyLoose(s.title) !== key) continue;
    if (['open', 'previews', 'upcoming', 'announced'].includes(s.status)) return s;
    const sDate = s.openingDate || s.previewsStartDate || s.unconfirmedStartDate || null;
    if (candDate && sDate && Math.abs(Date.parse(candDate) - Date.parse(sDate)) <= 366 * 86400000) return s;
  }
  return null;
}

// Case, punctuation, diacritics and articles removed. Exact match on this key
// only; no prefix or fuzzy step (that is checkForDuplicate's job).
function titleKeyLoose(title) {
  return foldDiacritics(String(title || '').toLowerCase())
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure decision: is the coverage guard blind this run? A fetch that returned
 * rows but none current means the date fields moved (parser rot); zero rows
 * means the API changed or emptied. Either way "0 gaps" would be a lie.
 */
function decideTmCoverageOutcome({ rawCount, currentCount }) {
  if (!rawCount) return { blind: true, exitCode: 1, writeGaps: false, reason: 'no rows returned' };
  if (!currentCount) return { blind: true, exitCode: 1, writeGaps: false, reason: `${rawCount} rows but none current (date fields changed?)` };
  return { blind: false, exitCode: 0, writeGaps: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Fetch helpers (network; not unit-tested — exercised by the dry-run).
// ---------------------------------------------------------------------------

function fetchTmJson(pathAndQuery, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${TM_BASE}${pathAndQuery}`;
    const req = https.get(url, { headers: { 'User-Agent': TM_USER_AGENT, Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`TheaterMania API HTTP ${res.statusCode} for ${pathAndQuery}`));
        return;
      }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Failed to parse TheaterMania API response')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('TheaterMania API request timed out')); });
    req.on('error', reject);
  });
}

async function fetchTaxonomyById(kind, ids) {
  const out = new Map();
  const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const fields = kind === 'venue' ? 'id,title,acf.city' : 'id,name';
    const rows = await fetchTmJson(`/${kind}?include=${chunk.join(',')}&per_page=100&_fields=${fields}`);
    for (const r of rows || []) out.set(Number(r.id), kind === 'venue' ? r : cleanText(r.name));
  }
  return out;
}

/**
 * Fetch the current Off-Broadway rows plus the venue/genre lookups they need.
 * @returns {Promise<{ rows: object[], venuesById: Map, genresById: Map, pagesFetched: number, rawCount: number }>}
 */
async function fetchTmOffBroadway({ todayIso = new Date().toISOString().slice(0, 10), maxPages = TM_MAX_PAGES } = {}) {
  const rows = [];
  let pagesFetched = 0;
  let rawCount = 0;
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchTmJson(`/shows?market=${TM_OB_MARKET_ID}&per_page=${TM_PAGE_SIZE}&orderby=modified&order=desc&page=${page}&_fields=${TM_FIELDS}`);
    pagesFetched++;
    if (!Array.isArray(batch) || batch.length === 0) break;
    rawCount += batch.length;
    const current = batch.filter(r => isCurrentTmRow(r, todayIso));
    rows.push(...current);
    if (current.length === 0) break;
  }
  const venuesById = await fetchTaxonomyById('venue', rows.flatMap(r => (r.acf && r.acf.the_venue) || []));
  const genresById = await fetchTaxonomyById('genre', rows.flatMap(r => r.genre || []));
  return { rows, venuesById, genresById, pagesFetched, rawCount };
}

module.exports = {
  TM_OB_MARKET_ID,
  OPEN_ENDED_LOOKBACK_DAYS,
  parseTmDate,
  mapTmDates,
  isCurrentTmRow,
  categoryFromGenres,
  resolveTmVenue,
  parseTmOffBroadwayRow,
  findTmCoverageGaps,
  findTmSameTitleShow,
  decideTmCoverageOutcome,
  fetchTmOffBroadway,
};
