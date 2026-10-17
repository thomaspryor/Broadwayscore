'use strict';

/**
 * WhatsOnStage public WordPress REST API: West End show listings and review
 * posts (BRO-4851, WE historical backfill plan v3.1).
 *
 * The ONLY module that knows the WOS REST shape — the `market=83` (London)
 * taxonomy id, the `acf.*` date fields, the venue/genre
 * id lookups, and the "X at the Venue – review" title convention. If WOS
 * changes its API, this is the one file to touch.
 *
 * Not to be confused with lib/whatsonstage-parser.js, which parses the WOS
 * *Awards* from Wikipedia.
 *
 * Endpoints (verified live 2026-10-07; robots.txt only disallows /wp-admin/):
 *   /wp-json/wp/v2/shows?market[terms]=83&market[include_children]=true
 *     ~11,500 London listings, acf.{preview,opening,closing}_date (YYYYMMDD).
 *     NOT market=98 (west-end-theatre, 2,721): WOS files the National Theatre,
 *     Old Vic and Royal Court under off-west-end-theatre (85), so 98 alone
 *     misses most subsidised-house productions. And NOT a bare market=83:
 *     the REST filter does not include child terms unless asked, so 83 alone
 *     returns only rows tagged London directly (9,072, with no West End
 *     venues at all). Callers filter by our own isWestEndVenue().
 *   /wp-json/wp/v2/venue?include=…   venue id → name
 *   /wp-json/wp/v2/genre             genre id → slug
 *   /wp-json/wp/v2/news?categories=63,69&after=&before=   review posts
 *
 * Free JSON API, no scraping provider: a direct fetch() with a timeout is
 * the right tool (same as the Wikipedia API helpers in precursor-wikipedia.js);
 * routing it through fetchPage() would spend proxy credits for nothing.
 */

// venue-write-guard-ok: parses WOS API rows into plain objects; callers that write shows.json sanitize the venue.

const WOS_API_BASE ='https://www.whatsonstage.com/wp-json/wp/v2';
const LONDON_MARKET_ID = 83;
const REVIEW_CATEGORY_IDS = [63, 69];
const USER_AGENT = 'BroadwayScorecardBot/1.0 (+https://broadwayscorecard.com; historical listings)';
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20000;
const POLITE_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ENTITY_MAP = {
  '&amp;': '&', '&#038;': '&', '&#8217;': '’', '&#8216;': '‘', '&#039;': "'",
  '&rsquo;': '’', '&lsquo;': '‘', '&#8211;': '–', '&ndash;': '–',
  '&#8212;': '—', '&mdash;': '—', '&#8220;': '“', '&#8221;': '”',
  '&quot;': '"', '&nbsp;': ' ', '&#8230;': '…',
};

/** Decode the HTML entities WordPress puts in rendered titles, strip tags. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[#a-z0-9]+;/gi, m => ENTITY_MAP[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** ACF date "YYYYMMDD" → "YYYY-MM-DD", or null when absent/malformed. */
function wosDate(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * WOS venue names → the names shows.json already uses for the same building,
 * so isWestEndVenue() and dedup see them. WOS splits the National Theatre's
 * stages as "Olivier (National Theatre)" and calls both Royal Court spaces
 * "Royal Court – Jerwood Theatre …".
 */
const WOS_VENUE_CANONICAL = [
  [/^olivier\s*\(national theatre\)$/i, 'Olivier Theatre'],
  [/^lyttelton\s*\(national theatre\)$/i, 'Lyttelton Theatre'],
  [/^dorfman(?: theatre)?\s*\(national theatre\)$/i, 'Dorfman Theatre'],
  [/^royal court\b.*$/i, 'Royal Court Theatre'],
];

function canonicalWosVenue(name) {
  // Straight apostrophes: shows.json writes "Wyndham's Theatre", WOS "Wyndham’s".
  const v = decodeEntities(name).replace(/[\u2018\u2019]/g, "'");
  for (const [re, canonical] of WOS_VENUE_CANONICAL) if (re.test(v)) return canonical;
  return v;
}

/**
 * One /shows row → normalized listing.
 * @param {object} raw WOS REST show object
 * @param {Map<number,string>|object} venueById
 * @param {Map<number,string>|object} genreById
 */
function parseWosShow(raw, venueById, genreById) {
  const get = (m, k) => (m instanceof Map ? m.get(k) : m?.[k]);
  const acf = raw?.acf || {};
  const venueId = Array.isArray(acf.the_venue) ? acf.the_venue[0] : acf.the_venue;
  return {
    wosId: raw?.id ?? null,
    title: decodeEntities(raw?.title?.rendered),
    venue: venueId != null ? canonicalWosVenue(get(venueById, venueId) || '') || null : null,
    venueId: venueId ?? null,
    previewsStartDate: wosDate(acf.preview_date),
    openingDate: wosDate(acf.opening_date),
    closingDate: wosDate(acf.closing_date),
    genres: (raw?.genre || []).map(id => get(genreById, id)).filter(Boolean),
    url: raw?.link || null,
  };
}

/**
 * Review post title → {title, venue}. WOS review titles follow
 *   "Brace Brace at the Royal Court – review"
 *   "The Fear of 13 review – Adrien Brody is sensational in …"
 * The second form carries no venue in the title; a venue is taken from the
 * teaser's "at the X Theatre" when present. Returns null when the title is
 * not a review title at all.
 */
function parseWosReviewTitle(rawTitle, rawTeaser) {
  const t = decodeEntities(rawTitle);
  const teaser = decodeEntities(rawTeaser);
  // Pre-2020 house style: "Review: <em>Wise Children</em> (The Old Vic)".
  const old = t.match(/^review:\s*(.+?)\s*\(([^()]+)\)\s*$/i);
  if (old) return { title: cleanReviewedTitle(old[1]), venue: old[2].replace(/^the\s+/i, '').trim() };
  // Greedy title: the venue follows the LAST " at " ("Breakfast at
  // Tiffany's at the Theatre Royal Haymarket – review").
  let m = t.match(/^(?:review:\s*)?(.+) at (?:the )?(.+?)\s*[–—-]\s*review\b/i)
    || t.match(/^(?:review:\s*)?(.+) at (?:the )?(.+?)\s+review\b/i);
  if (m) return { title: cleanReviewedTitle(m[1]), venue: m[2].trim() };
  m = t.match(/^(?:review:\s*)?(.+?)\s+review\b/i);
  if (!m) return null;
  const v = teaser.match(/\bat (?:the )?([A-Z@][\w'’ .&-]*?(?:Theatre|Palladium|Vic|Warehouse|Coliseum|sohoplace|Court|Playhouse))\b/);
  return { title: cleanReviewedTitle(m[1]), venue: v ? v[1].trim() : null };
}

/**
 * WOS review titles decorate the show title: "Unicorn West End", "Retrograde
 * in the West End –", "Evita with Rachel Zegler", "Coriolanus starring David
 * Oyelowo", "The Devil Wears Prada musical", "Robin Hood pantomime". Strip
 * those so the title matches the listing. "with" is only stripped before a
 * capitalised name ("A Room with a View" survives).
 */
function cleanReviewedTitle(s) {
  let t = String(s || '').trim();
  let prev;
  do {
    prev = t;
    t = t
      .replace(/\s*[–—-]\s*$/, '')
      .replace(/\s+(?:in\s+the\s+)?West\s+End$/i, '')
      .replace(/\s+starring\s+.+$/i, '')
      // "An Evening with Gary Lineker" keeps its name.
      .replace(/^(?!(?:an?\s+evening|a\s+night|in\s+conversation)\s+with\b)(.+?)\s+with\s+(?:[A-Z][\w'’.-]+\s+){1,3}?[A-Z][\w'’.-]+(?:\s+and\s+.+)?$/i, '$1')
      .replace(/\s+(?:musical|pantomime|panto)$/, '')
      .trim();
  } while (t !== prev);
  return t;
}

async function wosGet(pathAndQuery, { retries = 3 } = {}) {
  const url = `${WOS_API_BASE}${pathAndQuery}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt >= retries) throw new Error(`WOS fetch failed (${url}): ${e.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new Error(`WOS HTTP ${res.status} on ${url}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    // WP returns 400 rest_post_invalid_page_number past the last page.
    if (res.status === 400) return { json: [], totalPages: 0 };
    if (!res.ok) throw new Error(`WOS HTTP ${res.status} on ${url}`);
    const json = await res.json();
    const totalPages = Number(res.headers.get('x-wp-totalpages')) || 1;
    return { json, totalPages };
  }
}

async function wosGetAllPages(basePathAndQuery) {
  const sep = basePathAndQuery.includes('?') ? '&' : '?';
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const r = await wosGet(`${basePathAndQuery}${sep}per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(r.json)) throw new Error(`WOS returned non-array for ${basePathAndQuery} page ${page}`);
    out.push(...r.json);
    totalPages = r.totalPages;
    page++;
    if (page <= totalPages) await sleep(POLITE_DELAY_MS);
  } while (page <= totalPages);
  return out;
}

async function fetchGenreMap() {
  const rows = await wosGetAllPages('/genre?_fields=id,slug');
  return new Map(rows.map(g => [g.id, g.slug]));
}

async function fetchVenueMap(venueIds) {
  const ids = [...new Set(venueIds.filter(v => v != null))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const chunk = ids.slice(i, i + PAGE_SIZE);
    const r = await wosGet(`/venue?include=${chunk.join(',')}&per_page=${PAGE_SIZE}&_fields=id,title`);
    for (const v of r.json || []) map.set(v.id, decodeEntities(v.title?.rendered));
    await sleep(POLITE_DELAY_MS);
  }
  return map;
}

/**
 * Every WOS London listing incl. West End + Off-West End children (all
 * years), normalized. ~115 requests.
 * @returns {Promise<Array<ReturnType<typeof parseWosShow>>>}
 */
async function fetchWosLondonListings() {
  const raw = await wosGetAllPages(
    `/shows?market%5Bterms%5D=${LONDON_MARKET_ID}&market%5Binclude_children%5D=true&_fields=id,link,title,genre,acf.the_venue,acf.preview_date,acf.opening_date,acf.closing_date`
  );
  const venueIds = raw.map(r => (Array.isArray(r.acf?.the_venue) ? r.acf.the_venue[0] : r.acf?.the_venue));
  const [venueById, genreById] = [await fetchVenueMap(venueIds), await fetchGenreMap()];
  return raw.map(r => parseWosShow(r, venueById, genreById));
}

/**
 * WOS review posts published in [after, before) (YYYY-MM-DD), parsed.
 * Posts whose title is not a review title are dropped.
 */
async function fetchWosReviews({ after, before }) {
  const raw = await wosGetAllPages(
    `/news?categories=${REVIEW_CATEGORY_IDS.join(',')}&after=${after}T00:00:00&before=${before}T00:00:00&_fields=id,date,link,title,market,acf.teaser,acf.review_rating`
  );
  const out = [];
  for (const r of raw) {
    const parsed = parseWosReviewTitle(r.title?.rendered, r.acf?.teaser);
    if (!parsed) continue;
    out.push({
      ...parsed,
      date: String(r.date || '').slice(0, 10) || null,
      url: r.link || null,
      rating: r.acf?.review_rating ?? null,
      market: r.market || [],
    });
  }
  return out;
}

module.exports = {
  LONDON_MARKET_ID,
  decodeEntities,
  canonicalWosVenue,
  wosDate,
  parseWosShow,
  parseWosReviewTitle,
  cleanReviewedTitle,
  fetchWosLondonListings,
  fetchWosReviews,
};
