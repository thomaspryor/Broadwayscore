#!/usr/bin/env node
/**
 * Off-Broadway Date Enrichment Script
 *
 * Sibling of scripts/enrich-west-end-dates.js. Same shape, OB-specific sources.
 *
 * Why this exists:
 *   IBDB (our default date source for new shows added by update-show-status.yml)
 *   conflates first-preview date with opening date for off-Broadway productions.
 *   23 of 30 recent open OB shows had openingDate === previewsStartDate as a
 *   result. The opening-night-orchestrator's 2-day lookback window then
 *   silently skipped real press nights weeks later. KENREX 2026-04-26 lost
 *   ~7 critic reviews this way before manual recovery.
 *
 *   See memory/feedback_off_broadway_opening_date_gap.md.
 *
 * Sources:
 *   1. Playbill "Schedule of Upcoming Off-Broadway Shows" article (primary).
 *      The article lists First Preview / Opens / Closes for each show, parsed
 *      via the same shape as the WE script's Playbill London handling.
 *   2. Lortel.org currently-playing page (secondary, only for shows at the
 *      Lucille Lortel Theatre — these have authoritative dates from the venue).
 *   3. Playbill per-show production page (tertiary, gap-filler for shows the
 *      schedule article doesn't list — typically already-running OB shows that
 *      came in via IBDB with openingDate==previewsStartDate). SERP-discovery
 *      per show, page-title validation, then parses the bsp-list-promo blocks
 *      (First Preview / Opening Date / Closing Date) on
 *      playbill.com/production/{slug}.
 *
 *   Two-source agreement = high-confidence auto-mutation.
 *   Single-source = audit-only entry (no shows.json write), EXCEPT when the
 *   same-date-fix bypass kicks in (openingDate==previewsStartDate from an
 *   unconfirmed source like ibdb): single-source playbill is enough to write,
 *   because the existing data is provably wrong.
 *
 * Usage:
 *   node scripts/enrich-off-broadway-dates.js [options]
 *
 * Options:
 *   --dry-run            Report changes without writing shows.json
 *   --show=ID            Only process a specific show by id or slug
 *   --verify             Compare dates vs shows.json (no writes, no API calls
 *                        beyond fetch — same as a forced dry-run)
 *   --force              Overwrite existing dates even when source is trusted
 *   --fix-unconfirmed    Process shows with unconfirmed openingDateSource
 *                        (todaytix, showscore, unknown, ibdb-for-OB) — daily cron
 *   --initial-backfill   Bypass the change-stability guard once (first run only)
 *   --phase3-broad       Phase 3 probes ALL eligible candidates (not just the
 *                        same-date class). Use for one-time catalog audits
 *                        only — burns ~120 SERP+fetch on a daily cron. Default
 *                        Phase 3 scope is openingDate==previewsStartDate or
 *                        missing openingDate (the auto-apply class).
 *
 * Audit output: data/audit/date-enrichment-corrections.json (per-script entries
 * appended each run; uniform schema across WE + OB scripts).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { fetchPage } = require('./lib/scraper');
const { matchTitleToShow, titleWordsMatch } = require('./lib/show-matching');
const { isUnconfirmedDateSource } = require('./lib/date-source-confidence');
const { validateChangeStability } = require('./lib/change-stability-guard');
const { serpQuery } = require('./lib/url-discovery');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const PLAYBILL_OB_URL = 'https://playbill.com/article/schedule-of-upcoming-off-broadway-shows-2';
const LORTEL_URL = 'https://lortel.org/currently-playing/';
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'date-enrichment-corrections.json');
const ABORT_SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'audit', 'enrich-off-broadway-dates-aborted.json');
const PLAYBILL_URL_CACHE_PATH = path.join(__dirname, '..', 'data', 'playbill-urls.json');

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07',
  aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const force = args.includes('--force');
const fixUnconfirmed = args.includes('--fix-unconfirmed');
const initialBackfill = args.includes('--initial-backfill');
// Phase 3 (per-show production-page lookup) defaults to ONLY same-date-class
// candidates (openingDate==previewsStartDate) so the daily cron stays cheap —
// 0–3 SERP+fetch per day in steady state. `--phase3-broad` opts in to probing
// every Phase-3-eligible candidate (initial backfill use only).
const phase3Broad = args.includes('--phase3-broad');
const missingOnly = !force && !fixUnconfirmed;
const showArg = args.find(a => a.startsWith('--show='));
const showFilter = showArg ? showArg.split('=')[1] : null;

// =========================================================
// PARSE HELPERS
// =========================================================

/**
 * Parse a date like "April 26, 2026" or "Apr 26" → ISO yyyy-mm-dd. Returns
 * null on parse failure.
 */
function parseUSDate(text, defaultYear) {
  if (!text) return null;
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = m[2].padStart(2, '0');
  const year = m[3] || String(defaultYear || new Date().getFullYear());
  if (!month) return null;
  const y = parseInt(year, 10);
  // Sanity-bound: rolling window relative to current year so this doesn't
  // rot in 2031. Allow 5 years past, 5 years future — covers reasonable
  // schedule announcements without admitting obvious garbage.
  const currentYear = new Date().getFullYear();
  if (y < currentYear - 5 || y > currentYear + 5) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Page-content validation: refuse to extract dates from a response whose
 * <title> doesn't match the expected page. Catches Cloudflare challenge
 * pages, soft 404s, and Show-Score-style upgrade banners that return 200
 * but render no real content.
 */
function validatePageTitle(html, expectedTitleSubstring) {
  if (!html) return false;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return false;
  return m[1].toLowerCase().includes(expectedTitleSubstring.toLowerCase());
}

// =========================================================
// SOURCE 1: PLAYBILL OFF-BROADWAY SCHEDULE
// =========================================================

/**
 * Parse Playbill's OB schedule article into entries:
 *   [{ title, firstPreview, opening, source: 'playbill' }, ...]
 *
 * The article structure: each show is a paragraph or list-item containing
 * the show title (often in <strong> or <a>) followed by lines like
 * "First Preview: April 16, 2026" / "Opens: April 26, 2026".
 */
function parsePlaybillOBSchedule(html) {
  if (!validatePageTitle(html, 'Off-Broadway')) {
    console.warn('  WARNING: Playbill OB schedule page title did not match — refusing to parse');
    return [];
  }

  // Playbill's OB schedule article structure:
  //   <strong><a href="...">SHOW TITLE</a></strong><br>
  //   • Venue Name<br>
  //   • First Preview: April 15, 2026<br>
  //   • Opening: April 26, 2026<br>
  //   ... (more bullet lines)
  //   <strong><a href="...">NEXT SHOW TITLE</a></strong><br>
  //
  // The whole show block lives inside one <p>, with <br>-separated lines.
  // Splitting on the <strong>...<a>TITLE</a>...</strong> marker lets us
  // chunk the document into per-show segments.
  const titleRe = /<strong>\s*<a[^>]*>([^<]{2,160})<\/a>\s*<\/strong>/g;
  const titleMatches = [];
  let tm;
  while ((tm = titleRe.exec(html)) !== null) {
    titleMatches.push({ title: tm[1].trim(), index: tm.index });
  }
  const entries = [];
  for (let i = 0; i < titleMatches.length; i++) {
    const { title, index } = titleMatches[i];
    const nextIndex = titleMatches[i + 1]?.index ?? Math.min(index + 5000, html.length);
    const segment = html.slice(index, nextIndex);
    // Strip tags to plain text for the date lines.
    const plain = segment.replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<[^>]+>/g, ' ');
    const fpMatch = plain.match(/First Preview[s]?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    const openMatch = plain.match(/Open(?:s|ing)?:?\s*([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (!fpMatch && !openMatch) continue;
    entries.push({
      title,
      firstPreview: fpMatch ? parseUSDate(fpMatch[1]) : null,
      opening: openMatch ? parseUSDate(openMatch[1]) : null,
      source: 'playbill',
    });
  }
  return entries.filter(e => e.firstPreview || e.opening);
}

async function scrapePlaybillOB() {
  console.log('--- PLAYBILL OFF-BROADWAY SCHEDULE ---');
  console.log(`Fetching: ${PLAYBILL_OB_URL}`);
  const result = await fetchPage(PLAYBILL_OB_URL, { tier: 1 });
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch Playbill OB schedule');
    return [];
  }
  const entries = parsePlaybillOBSchedule(html);
  console.log(`Parsed ${entries.length} show entries from Playbill`);
  if (entries.length === 0 && html.length > 5000) {
    console.error('⚠️  WARNING: Playbill page loaded but 0 entries parsed — HTML structure may have changed');
  }
  return entries;
}

// =========================================================
// SOURCE 2: LORTEL.ORG CURRENTLY-PLAYING
// =========================================================

/**
 * Parse lortel.org/currently-playing/ — Lortel publishes their own shows'
 * dates authoritatively. Shape:
 *   <div class="show-card">
 *     <h3>{title}</h3>
 *     <p>{First Preview: ...}</p>
 *     <p>{Opening Night: ...}</p>
 *   </div>
 * (Approximation — selectors validated at test-time.)
 */
function parseLortelCurrentlyPlaying(html) {
  if (!validatePageTitle(html, 'Lortel')) {
    console.warn('  WARNING: Lortel page title did not match — refusing to parse');
    return [];
  }
  const $ = cheerio.load(html);
  const entries = [];
  // Lortel's currently-playing section uses semantic markup but the exact
  // selector has shifted historically. Walk all blocks and look for
  // title + date pairs. Restrict to text-near-keyword matches.
  $('h2, h3, h4').each((_, el) => {
    const titleEl = $(el);
    const title = titleEl.text().trim();
    if (!title || title.length > 120) return;
    // Search the next ~500 chars for First Preview / Opening Night markers.
    const block = titleEl.parent();
    const blockText = block.text().slice(0, 1500);
    const fpMatch = blockText.match(/First\s+Preview[s]?:?\s+([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    const openMatch = blockText.match(/Opening\s+Night:?\s+([A-Z][a-z]+\.?\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (!fpMatch && !openMatch) return;
    entries.push({
      title,
      firstPreview: fpMatch ? parseUSDate(fpMatch[1]) : null,
      opening: openMatch ? parseUSDate(openMatch[1]) : null,
      source: 'lortel',
    });
  });
  return entries.filter(e => e.firstPreview || e.opening);
}

async function scrapeLortel() {
  console.log('--- LORTEL.ORG CURRENTLY PLAYING ---');
  console.log(`Fetching: ${LORTEL_URL}`);
  const result = await fetchPage(LORTEL_URL, { tier: 1 });
  const html = result?.content || '';
  if (!html) {
    console.warn('WARNING: Failed to fetch lortel.org');
    return [];
  }
  const entries = parseLortelCurrentlyPlaying(html);
  console.log(`Parsed ${entries.length} show entries from Lortel`);
  return entries;
}

// =========================================================
// SOURCE 3: PLAYBILL PRODUCTION PAGE (PER-SHOW DIRECT)
// =========================================================
//
// Gap-filler for OB shows the schedule article doesn't carry — typically
// already-running productions whose openingDate==previewsStartDate came in
// from IBDB. Per-show SERP query → fetch playbill.com/production/{slug} →
// parse the bsp-list-promo blocks (First Preview / Opening Date) inline on
// the production page.
//
// Why SERP-first (not URL guessing): OB Playbill slugs are far less
// predictable than Broadway. Real examples include
// `the-adding-machine-off-broadway-the-new-group-theatre-at-st-clements-2026`
// and `heathers-the-musical-off-broadway-new-world-stages-stage-1-2025` —
// venue tokens are full strings (no "the"/"at" stripping), and sub-stages
// ("stage 1") appear without a separate canonical form. Three URL-guess
// attempts vs one SERP query: SERP wins on reliability and total fetches.

function loadPlaybillUrlCache() {
  try {
    return JSON.parse(fs.readFileSync(PLAYBILL_URL_CACHE_PATH, 'utf8'));
  } catch {
    return { shows: {}, lastUpdated: '' };
  }
}

function savePlaybillUrlCache(cache) {
  cache.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PLAYBILL_URL_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function decodeBasicEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'");
}

// Small generic-word set used by the short-title length guard. Mirrors the
// meaningful-word filter in scripts/lib/show-matching.js TITLE_GENERIC_WORDS
// but kept local + minimal so we can extend without touching the shared lib.
const COMMON_GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'for', 'to', 'with',
  'new', 'musical', 'play', 'show', 'revival',
]);

function normalizeForCompare(s) {
  return decodeBasicEntities(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Pull the canonical year out of a show id (e.g., music-city-off-broadway-2026)
 * or from openingDate (the more reliable source when present).
 */
function getShowYear(show) {
  if (show.openingDate) {
    const y = parseInt(show.openingDate.slice(0, 4), 10);
    if (!Number.isNaN(y)) return y;
  }
  const m = (show.id || '').match(/-(\d{4})$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Pull the year out of a Playbill production-page <title>. Page format:
 *   "Show Name (Off-Broadway, Venue Name, 2025) | Playbill"
 * Returns the year as a number, or null if not found.
 */
function getPlaybillPageYear(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return null;
  const yr = m[1].match(/\b(20\d{2})\b/);
  return yr ? parseInt(yr[1], 10) : null;
}

/**
 * Pull the trailing year from a Playbill production URL (e.g., -2025 at end).
 */
function getPlaybillUrlYear(url) {
  const m = (url || '').match(/-(\d{4})(?:[/?#]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Validate a Playbill production page. Three checks:
 *   1. <title> contains the show's title (loose substring after diacritic +
 *      entity decode + punctuation strip)
 *   2. <title> contains "off-broadway" or "off broadway" (rejects Broadway,
 *      concert, regional, and West End pages that SERP might return for shows
 *      with cross-market revivals)
 *   3. Year in the page title is within ±1 of the expected show year. Guards
 *      against cross-production false-matches — e.g. SERP returning a 2024
 *      Playbill production page for "Music City" when shows.json has
 *      music-city-off-broadway-2026 with openingDate 2026-03-23. Without this
 *      check, single-source same-date-fix would auto-write 2024 dates to a
 *      2026 show. Caught in dry-run 2026-04-29.
 * Returns true on pass, false on reject.
 */
function validateOBProductionPageTitle(html, show) {
  if (!html) return false;
  const showTitle = typeof show === 'string' ? show : show.title;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return false;
  const rawTitle = decodeBasicEntities(m[1]);
  const pageTitleNorm = normalizeForCompare(m[1]);
  // Market check: raw title must contain Off-Broadway in some form.
  if (!pageTitleNorm.includes('off-broadway') && !pageTitleNorm.includes('off broadway')) return false;
  // Strip Playbill's structured metadata before token-matching. Page title
  // format: "Show Name (Off-Broadway, Venue, Year) | Playbill". The venue
  // tokens count as "extra distinctive words" to titleWordsMatch's short-title
  // guard and cause valid pages to reject. Cropping to the head keeps the
  // year-window check separate (which reads the full title, parens included).
  const showHead = rawTitle.replace(/\s*\(.*$/, '').replace(/\s*\|\s*Playbill\s*$/i, '').trim();
  if (!showHead) return false;
  // Title-word match (token-overlap with extra-distinctive-word rejection) is
  // stricter than substring containment. The previous bidirectional substring
  // rule could pass a longer sibling production within the same year window
  // (e.g. base title matching extended title, or vice versa). titleWordsMatch
  // applies the same cross-show defense the rest of the codebase uses for
  // page validation. Tightened 2026-04-30 ship-check (Codex P0 finding).
  //
  // Pre-normalize slashes to spaces — show-matching's normalizer treats `/` as
  // word-internal (so "Blood/Love" collapses to "bloodlove" and never matches
  // "Blood/Love" on a Playbill page where the slash is a token separator).
  const slashSplit = (s) => s.replace(/\//g, ' ');
  if (!titleWordsMatch(slashSplit(showTitle), slashSplit(showHead))) return false;
  // Short-title length guard: titleWordsMatch's single-word path accepts any
  // page-head that contains the show word as a token, so "Hamlet" passes
  // "Hamlet 2.0: An Improvised Sequel" and "The Maids" passes "The Maids of
  // Honor". For show titles with ≤3 meaningful words, require page-head's
  // meaningful word count to equal the show title's. Longer titles are
  // sufficiently distinctive on their own. (Codex P0 ship-check finding.)
  const meaningfulWords = (s) => normalizeForCompare(s)
    .split(/[\s,:()&\-_/.]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 2 && !COMMON_GENERIC_WORDS.has(w));
  const showWc = meaningfulWords(showTitle).length;
  const headWc = meaningfulWords(showHead).length;
  if (showWc <= 3 && headWc > showWc) return false;
  // Year window check — only enforced when both expected and page year exist.
  if (typeof show === 'object') {
    const expectedYear = getShowYear(show);
    const pageYear = getPlaybillPageYear(html);
    if (expectedYear && pageYear && Math.abs(pageYear - expectedYear) > 1) {
      return false;
    }
  }
  return true;
}

/**
 * Extract First Preview + Opening Date from a Playbill production page's
 * `bsp-list-promo-title` blocks. Each block pairs a label (e.g., "First
 * Preview", "Opening Date") with an `info-circular` block that decomposes
 * the date into pre-text (month abbreviation) / text (day) / post-text (year).
 * Returns { firstPreview: ISO|null, opening: ISO|null } or null on parse miss.
 */
function extractDatesFromProductionPage(html) {
  if (!html) return null;
  const dates = { firstPreview: null, opening: null };
  // Tight regex: pair the label with the FIRST info-circular block that
  // follows within ~2000 chars. The Playbill template puts each label and
  // its date in the same UL/LI, so this proximity bound is safe.
  const re = /<div class="bsp-list-promo-title">([^<]+)<\/div>([\s\S]{0,2000}?)<div class="info-circular">([\s\S]{0,500}?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = m[1].trim().toLowerCase();
    const block = m[3];
    const pre = block.match(/info-circular-pre-text">([^<]+)</)?.[1]?.trim();
    const day = block.match(/info-circular-text">([^<]+)</)?.[1]?.trim();
    const post = block.match(/info-circular-post-text">([^<]+)</)?.[1]?.trim();
    if (!pre || !day || !post) continue;
    const iso = parseUSDate(`${pre} ${day}, ${post}`);
    if (!iso) continue;
    if (label.includes('first preview')) dates.firstPreview = iso;
    else if (label.includes('opening')) dates.opening = iso;
    // ignore "Closing Date" — out of scope for this script
  }
  return (dates.firstPreview || dates.opening) ? dates : null;
}

/**
 * SERP-discover the OB Playbill production page for a single show. Returns
 * a URL string, or null if no `/production/` URL containing `off-broadway`
 * comes back. Three filters:
 *   - URL contains `/production/` (drops articles, news posts)
 *   - URL contains `off-broadway` (drops Broadway revivals of the same title)
 *   - URL trailing year is within ±1 of expected show year (drops prior
 *     productions of the same title — e.g. a 2024 Music City vs a 2026
 *     Music City). Without this filter, the per-show year mismatch is only
 *     caught later in validateOBProductionPageTitle, which still costs us a
 *     fetchPage. Catching it at SERP avoids the wasted fetch.
 */
async function discoverOBPlaybillUrl(show) {
  // Strip diacritics from title for SERP query — "Pied à Terre" returns better
  // results without the accent vs with it.
  const cleanTitle = normalizeForCompare(show.title).replace(/"/g, '');
  const query = `site:playbill.com "${cleanTitle}" off-broadway production`;
  const results = await serpQuery(query, { nbResults: 5 });
  if (!results || results.length === 0) return null;
  const expectedYear = getShowYear(show);
  for (const r of results) {
    if (!r.url || !r.url.includes('/production/')) continue;
    if (!r.url.includes('off-broadway')) continue;
    if (expectedYear) {
      const urlYear = getPlaybillUrlYear(r.url);
      if (urlYear && Math.abs(urlYear - expectedYear) > 1) continue;
    }
    return r.url;
  }
  return null;
}

/**
 * Phase 3 entry point: for each candidate show NOT covered by Phase 1+2
 * merged entries, discover its Playbill production page and extract
 * First Preview / Opening Date.
 *
 * Returns:
 *   - entries: array of merge-shaped entries (title/firstPreview/opening/source)
 *   - misses: array of {showId, reason} for explicit audit-only logging
 *   - cacheChanged: bool, true if urlCache picked up new entries
 */
async function scrapePlaybillProductionPages(candidateShows, alreadyMatchedShowIds, urlCache, opts = {}) {
  console.log('--- PLAYBILL PRODUCTION PAGES (per-show direct) ---');
  const entries = [];
  const misses = [];
  let cacheChanged = false;
  const broad = !!opts.broad;

  // Default scope: same-date class (openingDate==previewsStartDate). These
  // are the urgent IBDB-conflated candidates where a single-source Playbill
  // date auto-applies via the same-date-fix bypass downstream. Probing the
  // broader unconfirmed-source set runs ~120 SERP+fetch/day with no
  // auto-apply (results land in audit-only). `--phase3-broad` enables the
  // wider sweep for one-time catalog audits.
  // Shows with no openingDate at all are intentionally NOT included in the
  // default queue — Phase 1 (Playbill schedule article) is the right source
  // for upcoming/announced shows; Phase 3 is the gap-filler for shows the
  // schedule article doesn't carry.
  const sameDateClass = (s) => s.openingDate && s.previewsStartDate && s.openingDate === s.previewsStartDate;
  const queue = candidateShows.filter(s => {
    if (alreadyMatchedShowIds.has(s.id)) return false;
    if (broad) return true;
    return sameDateClass(s);
  });
  console.log(`Queue: ${queue.length} candidate shows not covered by schedule article` +
    (broad ? ' [broad]' : ' [same-date-only — pass --phase3-broad to widen]'));

  // Fetch + validate + extract for one URL. Returns
  //   { ok: true, dates }              on success
  //   { ok: false, reason, detail? }   on failure (caller decides what to do)
  // Encapsulated so the cache-rot retry path can reuse it.
  const tryOneUrl = async (url, showCtx) => {
    let html;
    try {
      const r = await fetchPage(url, { tier: 1 });
      html = r?.content || '';
    } catch (e) {
      return { ok: false, reason: 'fetch-error', detail: e.message };
    }
    if (!html) return { ok: false, reason: 'fetch-error', detail: 'empty body' };
    if (!validateOBProductionPageTitle(html, showCtx)) {
      return { ok: false, reason: 'page-title-or-year-mismatch' };
    }
    const dates = extractDatesFromProductionPage(html);
    if (!dates || !dates.opening) {
      return { ok: false, reason: 'no-opening-date-on-page' };
    }
    return { ok: true, dates };
  };

  for (const show of queue) {
    let url = urlCache.shows?.[show.id];
    let usedCache = !!url;
    if (!url) {
      try {
        url = await discoverOBPlaybillUrl(show);
      } catch (e) {
        console.warn(`  ${show.id}: SERP error: ${e.message}`);
        misses.push({ showId: show.id, reason: 'serp-error', detail: e.message });
        continue;
      }
      if (!url) {
        console.log(`  ${show.id}: no playbill production URL found via SERP`);
        misses.push({ showId: show.id, reason: 'no-playbill-production-url' });
        continue;
      }
    }

    let result = await tryOneUrl(url, show);

    // Cache rot handling: a previously-discovered URL may have gone stale
    // (Playbill slug rename, page deletion, content drift). When a cache hit
    // fails fetch/validation/extract, evict the entry and retry SERP once.
    // Without this, a stale cache becomes a permanent miss loop — the show
    // stays audit-only forever even though a fresh SERP would find the new
    // URL. Codex ship-check finding 2026-04-30.
    if (!result.ok && usedCache) {
      console.warn(`  ${show.id}: cached URL failed (${result.reason}) — evicting + retry SERP`);
      delete urlCache.shows[show.id];
      cacheChanged = true;
      let freshUrl = null;
      try {
        freshUrl = await discoverOBPlaybillUrl(show);
      } catch (e) {
        misses.push({ showId: show.id, reason: 'serp-error-after-rot', detail: e.message, staleUrl: url });
        continue;
      }
      if (!freshUrl || freshUrl === url) {
        // No alternative URL — the slug really is dead.
        misses.push({ showId: show.id, reason: `${result.reason}-after-rot-evict`, url });
        continue;
      }
      url = freshUrl;
      usedCache = false;
      result = await tryOneUrl(url, show);
    }

    if (!result.ok) {
      console.warn(`  ${show.id}: ${result.reason} (${url})`);
      misses.push({ showId: show.id, reason: result.reason, detail: result.detail, url });
      continue;
    }

    const { dates } = result;
    // Page validated — cache the URL for future runs.
    if (!usedCache) {
      urlCache.shows[show.id] = url;
      cacheChanged = true;
    }

    entries.push({
      title: show.title,
      showId: show.id, // explicit ID — bypasses fuzzy title-match in Phase 4 for diacritics
      firstPreview: dates.firstPreview,
      opening: dates.opening,
      source: 'playbill-production-page',
      url,
    });
    console.log(`  ${show.id}: preview=${dates.firstPreview || '(none)'}, opening=${dates.opening} [${url}]`);
  }

  console.log(`Production-page hits: ${entries.length} | misses: ${misses.length}`);
  return { entries, misses, cacheChanged };
}

// =========================================================
// MERGE + APPLY
// =========================================================

/**
 * Two-source agreement merge. For each (title-matched) show:
 *   - If both sources have a date that agrees within ±1 day → high confidence.
 *   - If exactly one source has the date → low confidence, audit-only.
 *   - If sources disagree → low confidence, audit-only with discrepancy note.
 */
function mergeSources(playbill, lortel) {
  // Index by lowercased-title for matching.
  const byTitle = new Map();
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  for (const e of playbill) {
    const k = norm(e.title);
    if (!byTitle.has(k)) byTitle.set(k, { titles: new Set([e.title]), playbill: e, lortel: null });
    else {
      byTitle.get(k).titles.add(e.title);
      byTitle.get(k).playbill = e;
    }
  }
  for (const e of lortel) {
    const k = norm(e.title);
    if (!byTitle.has(k)) byTitle.set(k, { titles: new Set([e.title]), playbill: null, lortel: e });
    else {
      byTitle.get(k).titles.add(e.title);
      byTitle.get(k).lortel = e;
    }
  }
  const merged = [];
  for (const { titles, playbill: pb, lortel: lt } of byTitle.values()) {
    const title = [...titles][0];
    const fpPb = pb?.firstPreview;
    const fpLt = lt?.firstPreview;
    const opPb = pb?.opening;
    const opLt = lt?.opening;
    const sources = [pb, lt].filter(Boolean).map(s => s.source);

    // Agreement check (within ±1 day for typical timezone-rollover noise).
    const datesAgree = (a, b) => {
      if (!a || !b) return null; // can't compare
      const aMs = new Date(a).getTime();
      const bMs = new Date(b).getTime();
      if (Number.isNaN(aMs) || Number.isNaN(bMs)) return null;
      return Math.abs(aMs - bMs) <= 86400000;
    };

    const fpAgreement = datesAgree(fpPb, fpLt);
    const opAgreement = datesAgree(opPb, opLt);
    const bothPresent = pb && lt;

    let confidence;
    if (bothPresent && fpAgreement === true && opAgreement === true) {
      confidence = 'high';
    } else if (bothPresent && (fpAgreement === false || opAgreement === false)) {
      confidence = 'discrepancy';
    } else {
      confidence = 'single-source';
    }

    merged.push({
      title,
      firstPreview: fpPb || fpLt || null,
      opening: opPb || opLt || null,
      sources,
      confidence,
      raw: { playbill: pb, lortel: lt },
    });
  }
  return merged;
}

// =========================================================
// MAIN
// =========================================================

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function appendAudit(entries) {
  if (entries.length === 0) return;
  let existing = { _meta: { schema: 'date-enrichment-corrections v1' }, runs: [] };
  if (fs.existsSync(AUDIT_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
      if (!existing.runs) existing.runs = [];
    } catch {
      // corrupt audit — start fresh.
    }
  }
  existing.runs.push({
    runAt: new Date().toISOString(),
    script: 'enrich-off-broadway-dates',
    mode: { dryRun, verify, force, fixUnconfirmed, initialBackfill, showFilter },
    entries,
  });
  // Keep last 50 runs.
  if (existing.runs.length > 50) existing.runs = existing.runs.slice(-50);
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(existing, null, 2));
}

async function main() {
  console.log('=== Off-Broadway Date Enrichment ===');
  console.log(`Mode: ${verify ? 'verify' : dryRun ? 'dry-run' : 'apply'}${fixUnconfirmed ? ' +fix-unconfirmed' : ''}${force ? ' +force' : ''}${initialBackfill ? ' +initial-backfill' : ''}${showFilter ? ` (show=${showFilter})` : ''}`);
  console.log('');

  const data = loadShows();
  const allShows = data.shows || data;

  // Filter to off-broadway shows.
  // Status allowlist: only `open`, `previews`, `upcoming`, `announced` shows
  // are eligible for date-correction. Closed/cancelled/postponed/transferred
  // shows are EXCLUDED — their slug may be reused (or title-matched) by a
  // new upcoming production, and we'd corrupt the historical entry's dates.
  // Romeo & Juliet Suite 2026 (status=closed) got its dates overwritten with
  // a 2026-06-11 future production's data before this guard existed (caught
  // in /ship-check 2026-04-29; reverted in private repo).
  const ELIGIBLE_STATUSES = new Set(['open', 'previews', 'upcoming', 'announced']);
  let obShows = allShows.filter(s => s.category === 'off-broadway' && ELIGIBLE_STATUSES.has(s.status));
  console.log(`Off-Broadway shows in shows.json: ${obShows.length}`);
  if (showFilter) {
    obShows = obShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (obShows.length === 0) {
      console.error(`No OB show found with id/slug: ${showFilter}`);
      process.exit(1);
    }
  }

  // Candidates: same idiom as the WE script.
  const candidateShows = verify || showFilter
    ? obShows
    : fixUnconfirmed
      ? obShows.filter(s => !s.previewsStartDate || isUnconfirmedDateSource(s))
      : missingOnly
        ? obShows.filter(s => !s.previewsStartDate)
        : obShows;
  console.log(`Candidate shows for enrichment: ${candidateShows.length}`);
  console.log('');

  // Phase 1: Playbill OB schedule (primary source).
  const playbillEntries = await scrapePlaybillOB();

  // Phase 2: Lortel currently-playing (secondary source).
  // Only fetched once per run; cheap on the hosting side.
  const lortelEntries = await scrapeLortel();

  // Phase 3a: Initial merge of Playbill schedule + Lortel.
  console.log('');
  console.log('--- MERGING SCHEDULE + LORTEL ---');
  const merged = mergeSources(playbillEntries, lortelEntries);
  const highConfidence = merged.filter(e => e.confidence === 'high').length;
  const singleSource = merged.filter(e => e.confidence === 'single-source').length;
  const discrepancy = merged.filter(e => e.confidence === 'discrepancy').length;
  console.log(`Merged: ${merged.length} unique entries (${highConfidence} two-source agree, ${singleSource} single-source, ${discrepancy} discrepancy)`);

  // Phase 3b: Per-show Playbill production-page lookup for shows NOT already
  // covered by the schedule article. Targets the 33 OB shows currently stuck
  // in audit-only with openingDate==previewsStartDate from IBDB.
  // Only candidate shows go through Phase 3 — non-candidates (already-confirmed
  // dates) don't need the gap-fill, and probing them would burn SERP credits
  // with no ability to improve their data.
  console.log('');
  const alreadyMatched = new Set();
  for (const entry of merged) {
    const result = matchTitleToShow(entry.title, candidateShows, { market: 'off-broadway' });
    if (result?.confidence === 'high' && result.show.category === 'off-broadway') {
      alreadyMatched.add(result.show.id);
    }
  }
  const urlCache = loadPlaybillUrlCache();
  const phase3 = await scrapePlaybillProductionPages(candidateShows, alreadyMatched, urlCache, { broad: phase3Broad });
  for (const e of phase3.entries) {
    merged.push({
      title: e.title,
      showId: e.showId, // surfaces in Phase 4 as a direct-match shortcut
      firstPreview: e.firstPreview,
      opening: e.opening,
      sources: ['playbill-production-page'],
      confidence: 'single-source',
      raw: { 'playbill-production-page': { ...e } },
    });
  }
  // Save the URL cache even in dry-run/verify mode. The cache is discovery
  // data (URL strings), not show data — there's no risk to writing it during
  // a dry-run, and skipping the save means the real follow-up run has to
  // re-SERP every show, doubling the BD/SB cost of a backfill.
  if (phase3.cacheChanged) {
    savePlaybillUrlCache(urlCache);
    console.log(`Updated ${PLAYBILL_URL_CACHE_PATH} (${Object.keys(urlCache.shows || {}).length} entries total)`);
  }
  console.log('');

  if (merged.length === 0) {
    console.warn('WARNING: 0 merged entries — all sources returned empty');
    process.exit(0);
  }

  // Phase 4: Match to shows.json and compute changes.
  const changes = [];
  const auditEntries = [];

  // Carry Phase 3 misses through to audit output so operators can see *why*
  // an audit-only show stayed audit-only (no Playbill URL, page mismatch,
  // missing date markup, etc).
  for (const miss of phase3.misses) {
    const show = candidateShows.find(s => s.id === miss.showId);
    if (!show) continue;
    auditEntries.push({
      showId: show.id,
      title: show.title,
      confidence: 'phase3-miss',
      sources: ['playbill-production-page'],
      currentOpening: show.openingDate,
      currentPreviews: show.previewsStartDate,
      currentSource: show.openingDateSource,
      proposedOpening: null,
      proposedPreviews: null,
      reason: miss.reason,
      raw: { miss },
    });
  }

  for (const entry of merged) {
    if (!entry.opening) continue; // skip entries without an opening date
    // Phase 3 entries carry an explicit showId — use that as a direct lookup
    // and skip the fuzzy title-match path. Without this, titles with
    // diacritics ("Pied à Terre") fall to medium-confidence in matchTitleToShow
    // because the diacritic-stripped query doesn't equal the un-stripped
    // show.title, and the script silently skips a known-good fix.
    let show;
    if (entry.showId) {
      show = obShows.find(s => s.id === entry.showId);
      if (!show || show.category !== 'off-broadway') continue;
    } else {
      // Pass market: 'off-broadway' (NOT 'broadway') so pickBestProduction's
      // market-aware filter at scripts/lib/show-matching.js:507-518 keeps OB
      // candidates when a title has both Broadway and OB productions. Passing
      // 'broadway' would filter to !cat||cat==='broadway' and silently drop
      // the OB show from candidates. (Caught in /ship-check 2026-04-29.)
      const result = matchTitleToShow(entry.title, obShows, { market: 'off-broadway' });
      if (!result || result.confidence !== 'high' || result.show.category !== 'off-broadway') continue;
      show = result.show;
    }
    const isCandidate = candidateShows.some(s => s.id === show.id);

    // Data integrity: previews must be before opening.
    if (entry.firstPreview && entry.opening && entry.firstPreview >= entry.opening) {
      console.warn(`  SKIP ${show.title}: preview ${entry.firstPreview} >= opening ${entry.opening} (bad data)`);
      continue;
    }

    // Sources resolved during merge — pick the more authoritative for the
    // openingDateSource field.
    const entryDateSource = entry.confidence === 'high'
      ? 'playbill+lortel'
      : (entry.sources[0] || 'playbill');

    // Same-date fix: openingDate === previewsStartDate AND the external
    // source has a corrected opening OR a corrected preview. This is the
    // KENREX class — the existing data is provably wrong (IBDB shipped both
    // fields with the previews-start value), so single-source correction is
    // safe. The change-stability guard still gates against mass-corruption
    // from a Playbill format change.
    //
    // Both opening AND preview are eligible to trigger a fix: when Playbill
    // confirms IBDB's opening date but reports an earlier first-preview
    // (the more common scenario for the 33-show class), only the preview
    // update is needed to break the show out of the same-date class. Without
    // this branch, those shows stay audit-only forever and burn SERP credits
    // on every daily cron run.
    //
    // Magnitude guard: opening-date shift > 60 days is suspicious for an
    // IBDB-conflated correction — likely indicates a wrong-production match
    // that survived the year-window filter (e.g. two productions of the same
    // show in the same year at different venues). Caught 2026-04-29 dry-run:
    // music-city-off-broadway-2026 had a 93-day proposed shift (March → June)
    // because the only Playbill production page for that title in 2026 was
    // a different venue/date production. Forcing audit-only on shifts > 60
    // days lets a human review the candidate before an auto-apply.
    const SAME_DATE_FIX_MAX_SHIFT_DAYS = 60;
    const dayShift = (a, b) => {
      if (!a || !b) return 0;
      const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
      return Math.round(ms / 86400000);
    };
    // Apply the magnitude cap to BOTH opening and preview shifts. A wrong-
    // production match could yield an opening that happens to match IBDB's
    // value (so the preview-only branch would proceed) while previewsStartDate
    // shifts wildly. Pre-2026-04-30, only opening shift was checked; preview-
    // only fixes had no magnitude guard. (QA agent ship-check finding.)
    const openingShiftDays = dayShift(entry.opening, show.openingDate);
    const previewShiftDays = dayShift(entry.firstPreview, show.previewsStartDate);
    const shiftDays = Math.max(openingShiftDays, previewShiftDays);
    const shiftTooLarge = shiftDays > SAME_DATE_FIX_MAX_SHIFT_DAYS;
    const openingChanges = entry.opening !== show.openingDate;
    const previewChanges = entry.firstPreview && entry.firstPreview !== show.previewsStartDate;
    const sameDateFix = show.openingDate && show.previewsStartDate &&
      show.openingDate === show.previewsStartDate &&
      (openingChanges || previewChanges) &&
      isUnconfirmedDateSource(show) &&
      !shiftTooLarge;

    // For NON-same-date-fix changes, require two-source agreement OR --force.
    // This protects the bulk of OB shows (where the existing date may already
    // be correct) from being silently overwritten by a single-source error.
    if (!sameDateFix && entry.confidence !== 'high' && !force) {
      // Pick the most informative reason for audit operators. Magnitude veto
      // is the most actionable signal — it usually means a wrong-production
      // match. Otherwise fall back to the generic single-source label.
      const auditReason = shiftTooLarge && show.openingDate === show.previewsStartDate
        ? `shift-too-large (${shiftDays}d > ${SAME_DATE_FIX_MAX_SHIFT_DAYS}d cap) — likely cross-production`
        : 'single-source-and-not-same-date-fix';
      auditEntries.push({
        showId: show.id,
        title: show.title,
        confidence: entry.confidence,
        sources: entry.sources,
        currentOpening: show.openingDate,
        currentPreviews: show.previewsStartDate,
        currentSource: show.openingDateSource,
        proposedOpening: entry.opening,
        proposedPreviews: entry.firstPreview,
        shiftDays,
        reason: auditReason,
        raw: entry.raw,
      });
      continue;
    }

    if (sameDateFix && isCandidate) {
      const showChanges = [];
      if (openingChanges) {
        showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      }
      if (previewChanges) {
        showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
      }
      // Always rotate openingDateSource off ibdb when we have a corroborating
      // Playbill source — even on preview-only fixes — so the next daily run
      // doesn't re-process this show via isUnconfirmedDateSource.
      showChanges.push({ field: 'openingDateSource', old: show.openingDateSource, new: entryDateSource });
      changes.push({ id: show.id, title: show.title, slug: show.slug, changes: showChanges });
      console.log(`  FIX ${show.title}: same-date ${show.openingDate} → preview=${entry.firstPreview || show.previewsStartDate}, opening=${entry.opening} [${entryDateSource}]`);
    } else if (force && isCandidate) {
      const showChanges = [];
      if (entry.firstPreview && entry.firstPreview !== show.previewsStartDate) {
        showChanges.push({ field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview });
      }
      if (entry.opening !== show.openingDate) {
        showChanges.push({ field: 'openingDate', old: show.openingDate, new: entry.opening });
      }
      if (showChanges.length) {
        showChanges.push({ field: 'openingDateSource', old: show.openingDateSource, new: entryDateSource });
        changes.push({ id: show.id, title: show.title, slug: show.slug, changes: showChanges });
      }
    }
  }

  console.log('');
  console.log(`Proposed changes: ${changes.length} | Audit-only: ${auditEntries.length}`);

  // Stability guard: prevent mass-corruption from a parser regression.
  const guardResult = validateChangeStability({
    name: 'enrich-off-broadway-dates',
    changes,
    candidateCount: candidateShows.length,
    // Tightened from absoluteChanges:50, changePercent:0.5 after /ship-check
    // 2026-04-29: 217 OB candidates × 0.5 = 108-change ceiling was wide enough
    // to mask a parser regression that flips most candidates. Daily steady-state
    // should be 0-3 corrections; --initial-backfill bypass is the single
    // operator-acknowledged exception.
    thresholds: { absoluteChanges: 20, changePercent: 0.15 },
    forceFlag: force,
    initialBackfillFlag: initialBackfill,
    snapshotPath: ABORT_SNAPSHOT_PATH,
  });
  if (!guardResult.ok) {
    console.error(`Stability guard aborted run. See snapshot: ${guardResult.snapshotPath || ABORT_SNAPSHOT_PATH}`);
    process.exit(1);
  }

  // Print proposed changes
  if (changes.length > 0) {
    console.log('');
    console.log('CHANGES:');
    for (const c of changes) {
      console.log(`  ${c.title} (${c.slug || c.id}):`);
      for (const ch of c.changes) console.log(`    ${ch.field}: ${ch.old} -> ${ch.new}`);
    }
  }

  // Apply (unless dry-run/verify).
  if (!verify && !dryRun && changes.length > 0) {
    for (const c of changes) {
      const show = allShows.find(s => s.id === c.id);
      if (!show) continue;
      for (const ch of c.changes) show[ch.field] = ch.new;
    }
    saveShows(data);
    console.log('');
    console.log(`Wrote ${changes.length} change(s) to shows.json`);

    // Post-write validation pass. Mirrors enrich-west-end-dates.js:684-694
    // — if validate-data.js fails, we exit non-zero so the workflow's push
    // step is skipped and the bad write doesn't leave the local repo. CI's
    // checkout-core-data + push-core-data would normally rebase + push, but
    // a non-zero exit here aborts the job before push.
    console.log('');
    console.log('Running data validation...');
    try {
      const { execSync } = require('child_process');
      execSync('node scripts/validate-data.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
      console.log('Validation passed');
    } catch (e) {
      console.error('Validation failed after write — review changes and revert if needed.');
      process.exit(1);
    }
  } else if (changes.length > 0) {
    console.log('');
    console.log(`(${verify ? 'verify' : 'dry-run'} mode — no writes)`);
  }

  // Always append audit (even on dry-run, so operators can review).
  appendAudit([
    ...changes.map(c => ({ kind: 'applied', ...c })),
    ...auditEntries.map(e => ({ kind: 'audit-only', ...e })),
  ]);

  console.log('');
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
