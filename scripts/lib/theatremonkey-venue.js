'use strict';

/**
 * Theatremonkey venue resolution (S4-T5, 2026 data audit BRO-4204).
 *
 * theatremonkey.com/shows/ lists titles only; the venue lives on each show's
 * own page. discover-new-shows.js's Theatremonkey source therefore skipped
 * every candidate since card #1060 closed the `venue: 'TBA'` leak ("skipped
 * 80 candidates — index has no venue data" on every run, 0 shows contributed
 * for 23 consecutive CI runs). This module is the per-show-page fetch that
 * comment asked for — bounded and cached so it costs a handful of fetches per
 * run, not 80:
 *
 *   - parseTheatremonkeyIndex(html)       index page → [{ title, slug, url }]
 *   - extractTheatremonkeyVenue(html)     show page  → venue name (text, never
 *                                          the URL — CLAUDE.md §3)
 *   - extractTheatremonkeyDates(html)     show page  → { showingFrom, showingTo }
 *   - planVenueFetches(entries, cache, …) pure: which pages to fetch this run
 *   - loadVenueCache / saveVenueCache     data/audit/theatremonkey-venue-cache.json
 *   - parseVenuePageBudget(argv, env)     --tm-page-budget=N / TM_VENUE_PAGE_BUDGET
 *
 * Why fetch pages rather than borrow a venue from an OLT/TodayTix title
 * match: Theatremonkey is the THIRD West End source in dedup priority, so a
 * title OLT or TodayTix also lists is already covered by them — waiving the
 * venue requirement only for those titles would still let Theatremonkey
 * contribute nothing. The titles that matter are the ones ONLY Theatremonkey
 * carries, and for those there is no cross-source venue to borrow. The show
 * page is the only place a real venue exists for them.
 *
 * Cache shape (keyed by the show page URL, the one stable identifier the
 * index gives us — used only as a key, no metadata is read out of it):
 *   { version: 1, updatedAt, entries: { [url]: { title, venue, status, fetchedAt, error? } } }
 *   status: 'ok' | 'no-venue' | 'not-found' | 'error'
 * Entries expire per status (CACHE_TTL_MS) so a page that gains a venue, or
 * a transient fetch error, is retried without burning the budget every run.
 *
 * venue-write-guard-ok: this module never writes shows.json — it caches and
 * replays venue text in memory; the single write site
 * (discover-new-shows.js fetchShowsFromTheatremonkey) sanitizes with
 * sanitizeVenueForWrite BEFORE recordVenueResult and again before the
 * candidate push, then applies the London non-theatre / receiving-house gate.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { foldDiacritics } = require('./title-match');

const TM_INDEX_URL = 'https://www.theatremonkey.com/shows/';
const TM_SHOW_URL_PREFIX = 'https://www.theatremonkey.com/show/';
const DEFAULT_CACHE_PATH = process.env.TM_VENUE_CACHE_PATH
  || path.join(__dirname, '..', '..', 'data', 'audit', 'theatremonkey-venue-cache.json');
const DEFAULT_VENUE_PAGE_BUDGET = 20;
const VENUE_PAGE_BUDGET_FLAG = '--tm-page-budget';
const VENUE_PAGE_BUDGET_ENV = 'TM_VENUE_PAGE_BUDGET';

const DAY_MS = 24 * 60 * 60 * 1000;
// A venue rarely changes for a slug (a transfer gets a new slug on TM), so
// 'ok' is long-lived; the negative outcomes are short so a page that is
// briefly down or mid-edit is retried, but not every run.
const CACHE_TTL_MS = {
  ok: 60 * DAY_MS,
  'no-venue': 7 * DAY_MS,
  'not-found': 7 * DAY_MS,
  error: 1 * DAY_MS,
};

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(?:rsquo;|#8217;|#x2019;)/gi, '’')
    .replace(/&(?:lsquo;|#8216;|#x2018;)/gi, '‘')
    .replace(/&(?:rdquo;|#8221;)/gi, '”')
    .replace(/&(?:ldquo;|#8220;)/gi, '“')
    .replace(/&(?:quot;|#34;)/gi, '"')
    .replace(/&(?:apos;|#39;|#039;)/gi, "'")
    .replace(/&(?:ndash;|#8211;)/gi, '–')
    .replace(/&(?:mdash;|#8212;)/gi, '—')
    .replace(/&amp;/gi, '&');
}

function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Same title key the WE divergence log uses (lower, alnum, no leading
 * article), with diacritics folded FIRST so "Les Misérables" keys as
 * "les miserables" rather than "les misrables" (task #648 / #781 guard).
 */
function titleKey(title) {
  return foldDiacritics(String(title || ''))
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/^(the|a|an) /, '')
    .trim();
}

/**
 * Index page → [{ title, slug, url }], first occurrence per slug, in page
 * order. Mirrors the selector discover-new-shows.js has used since the
 * source was added (a[href*="/show/"], skip "Read more"/"Show Details"
 * links, strip the "Disney's " prefix for matching consistency).
 */
function parseTheatremonkeyIndex(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const seen = new Set();
  const entries = [];
  $('a[href*="/show/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/show\/([^/?#]+)\/?(?:[?#].*)?$/);
    if (!match) return;
    const slug = match[1];
    if (slug === 'shows' || seen.has(slug)) return;
    const title = collapseWhitespace(decodeEntities($(el).text()));
    if (title.length < 2 || /^(Read more|Show Details|Reviews)/i.test(title)) return;
    seen.add(slug);
    entries.push({
      title: title.replace(/^Disney['’]s\s+/i, ''),
      slug,
      url: `${TM_SHOW_URL_PREFIX}${slug}/`,
    });
  });
  return entries;
}

function cleanVenueText(raw) {
  if (!raw) return null;
  let v = collapseWhitespace(decodeEntities(raw));
  v = v.replace(/[\s.,;:–—-]+$/g, '').trim();
  if (v.length < 3 || v.length > 120 || /[<>]/.test(v)) return null;
  return v;
}

/**
 * Show page → venue name, or null. Two text anchors on every show page
 * (verified 2026-09-28 on /show/amadeus/): the "About <venue>" accordion body
 * starts `Venue: <name><br/>Address: …`, and the seating-plan button reads
 * "Find out where to sit and where to avoid in <venue>". The venue link's
 * href (/venue/<slug>/) is deliberately NOT used — CLAUDE.md §3, never
 * extract metadata from URLs.
 */
function extractTheatremonkeyVenue(html) {
  if (!html) return null;
  const body = html.match(/Venue:\s*([^<\n]{2,160}?)\s*<br\s*\/?>/i);
  const fromBody = body && cleanVenueText(body[1]);
  if (fromBody) return fromBody;
  const button = html.match(/where to avoid in\s+([^<\n]{2,160}?)\s*(?:<|$)/i);
  const fromButton = button && cleanVenueText(button[1]);
  if (fromButton) return fromButton;
  return null;
}

/** "20th May 2026" → "2026-05-20" (day required; sane year window). */
function parseBritishDate(text, now = new Date()) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = parseInt(m[3], 10);
  const currentYear = now.getFullYear();
  if (year < currentYear - 2 || year > currentYear + 3) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

/**
 * Show page → { showingFrom, showingTo } from the "Showing from Wed, 20th May
 * 2026 to Sat, 17th April 2027" line (either side may be missing). These are
 * performance dates, not the press night — London discovery keeps
 * openingDate null and puts the start in previewsStartDate (see the
 * IMPORTANT note atop discover-new-shows.js).
 */
function extractTheatremonkeyDates(html, now = new Date()) {
  const out = { showingFrom: null, showingTo: null };
  if (!html) return out;
  const text = collapseWhitespace(decodeEntities(html.replace(/<[^>]+>/g, ' ')));
  const m = text.match(/Showing from\s+(?:[A-Za-z]+,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})(?:\s+(?:to|until|-|–)\s+(?:[A-Za-z]+,\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}))?/i);
  if (!m) return out;
  out.showingFrom = parseBritishDate(m[1], now);
  out.showingTo = m[2] ? parseBritishDate(m[2], now) : null;
  return out;
}

/**
 * How many show pages one run may fetch. `--tm-page-budget=N` wins over the
 * TM_VENUE_PAGE_BUDGET env var, which wins over the default (20). 0 is legal
 * (cache-only run); anything unparseable falls back to the default.
 */
function parseVenuePageBudget(argv = [], env = process.env) {
  const flag = (argv || []).find(a => typeof a === 'string' && a.startsWith(VENUE_PAGE_BUDGET_FLAG + '='));
  const raw = flag ? flag.slice(VENUE_PAGE_BUDGET_FLAG.length + 1) : (env && env[VENUE_PAGE_BUDGET_ENV]);
  if (raw === undefined || raw === null || raw === '') return DEFAULT_VENUE_PAGE_BUDGET;
  const n = Number.parseInt(String(raw), 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_VENUE_PAGE_BUDGET;
}

function emptyCache() {
  return { version: 1, updatedAt: null, entries: {} };
}

/** Missing or corrupt file → empty cache (a bad cache costs fetches, never a crash). */
function loadVenueCache(file = DEFAULT_CACHE_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') return emptyCache();
    return { version: 1, updatedAt: data.updatedAt || null, entries: { ...data.entries } };
  } catch {
    return emptyCache();
  }
}

/** Deterministic (sorted keys) so the tracked file diffs stay reviewable. */
function saveVenueCache(cache, file = DEFAULT_CACHE_PATH, now = new Date()) {
  const entries = {};
  for (const key of Object.keys(cache.entries || {}).sort()) entries[key] = cache.entries[key];
  const out = { version: 1, updatedAt: now.toISOString(), entries };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return out;
}

/** True when a cache entry is still within its status TTL. */
function cacheEntryUsable(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return false;
  const ttl = CACHE_TTL_MS[entry.status];
  if (!ttl) return false;
  const fetchedAt = new Date(entry.fetchedAt).getTime();
  if (!Number.isFinite(fetchedAt)) return false;
  return nowMs - fetchedAt < ttl;
}

/**
 * Pure: split the index into venues we already know, pages to fetch now, and
 * pages deferred to a later run.
 *
 *   fromCache    [{ ...entry, venue }]  usable 'ok' cache hits
 *   toFetch      [entry]                up to `budget`, `prioritize(entry)` hits first
 *                                       (index order otherwise — stable, so the deferred
 *                                       tail is reached on later runs)
 *   deferred     [entry]                needed a fetch but over budget this run
 *   knownNoVenue number                 fresh negative cache entries (skipped, no fetch)
 */
function planVenueFetches(indexEntries, cache, { budget = DEFAULT_VENUE_PAGE_BUDGET, now = Date.now(), prioritize = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const entries = (cache && cache.entries) || {};
  const fromCache = [];
  const needsFetch = [];
  let knownNoVenue = 0;
  for (const entry of indexEntries || []) {
    const hit = entries[entry.url];
    if (cacheEntryUsable(hit, nowMs)) {
      if (hit.status === 'ok' && hit.venue) fromCache.push({ ...entry, venue: hit.venue });
      else knownNoVenue++;
      continue;
    }
    needsFetch.push(entry);
  }
  let ordered = needsFetch;
  if (typeof prioritize === 'function') {
    const first = needsFetch.filter(e => prioritize(e));
    const rest = needsFetch.filter(e => !prioritize(e));
    ordered = [...first, ...rest];
  }
  const cap = Number.isInteger(budget) && budget >= 0 ? budget : DEFAULT_VENUE_PAGE_BUDGET;
  return {
    fromCache,
    toFetch: ordered.slice(0, cap),
    deferred: ordered.slice(cap),
    knownNoVenue,
  };
}

/** Record one show-page outcome in the cache (mutates `cache`, returns the entry). */
function recordVenueResult(cache, entry, { status, venue = null, error = null, now = new Date() }) {
  if (!CACHE_TTL_MS[status]) throw new Error(`theatremonkey-venue: unknown cache status "${status}"`);
  const record = {
    title: entry.title,
    venue: status === 'ok' ? venue : null,
    status,
    fetchedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  if (error) record.error = String(error).slice(0, 200);
  cache.entries[entry.url] = record;
  return record;
}

module.exports = {
  TM_INDEX_URL,
  TM_SHOW_URL_PREFIX,
  DEFAULT_CACHE_PATH,
  DEFAULT_VENUE_PAGE_BUDGET,
  VENUE_PAGE_BUDGET_FLAG,
  VENUE_PAGE_BUDGET_ENV,
  CACHE_TTL_MS,
  titleKey,
  parseTheatremonkeyIndex,
  extractTheatremonkeyVenue,
  extractTheatremonkeyDates,
  parseBritishDate,
  parseVenuePageBudget,
  loadVenueCache,
  saveVenueCache,
  cacheEntryUsable,
  planVenueFetches,
  recordVenueResult,
};
