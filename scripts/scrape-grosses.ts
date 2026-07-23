/**
 * Broadway Grosses Scraper
 *
 * Scrapes weekly box office data from BroadwayWorld.
 * Two-tier fallback: ScrapingBee CSS extraction (primary) → Playwright (fallback).
 * Uses shared show-matching.js library (260+ aliases) for title matching.
 *
 * Safety guards: minimum show count, gross sanity, WoW delta check, pre-write backup.
 *
 * Usage:
 *   npx tsx scripts/scrape-grosses.ts              # Full scrape
 *   npx tsx scripts/scrape-grosses.ts --dry-run    # Preview without writing
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as cheerio from 'cheerio';

// Use the shared show-matching utility (260+ aliases, multi-level matching)
const { matchTitleToShow, loadShows: loadShowsFromMatching } = require('./lib/show-matching');
// Pure BWW row parser — extracted for unit testing (see tests/unit/parse-bww-grosses-row.test.mjs)
const { parseBwwGrossesRow } = require('./lib/parse-bww-grosses-row');
// Bright Data / Scrapingdog fetchers — proxy through non-CI IPs. ScrapingBee
// (Tier 1) and this script's own Playwright (Tier 4) both fail identically
// when BroadwayWorld throttles/blocks the GitHub Actions IP range: SB returns
// 401 quota errors independent of IP, but the bare Playwright fallback launches
// straight from the CI runner's own IP with no proxy, so a BWW-side IP block
// reproduces as a silent `.all-gross-data .row` timeout (2026-07-21/22
// incident — confirmed the page is static server-rendered HTML that loads
// fine from a non-CI IP). BD/SD route through proxy IPs that aren't in that
// blocklist, so they belong ahead of Playwright, not just as review-text tiers.
const { fetchWithBrightData, fetchWithScrapingdog } = require('./lib/scraper');

const GROSSES_URL = 'https://www.broadwayworld.com/grosses.php';
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');
const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');

const DRY_RUN = process.argv.includes('--dry-run');
const MIN_SHOWS = 20;

// Long-running shows expected in every weekly scrape. Soft-warn (not hard-fail)
// so the pipeline doesn't break when a show closes — but surfaces the gap loudly.
const EXPECTED_SHOWS = [
  'hamilton', 'wicked', 'the-lion-king', 'moulin-rouge', 'hadestown', 'mj',
];

// ============================================================
// Interfaces (unchanged)
// ============================================================

interface ShowGrosses {
  thisWeek: {
    gross: number | null;
    grossPrevWeek: number | null;
    grossYoY: number | null;
    capacity: number | null;
    capacityPrevWeek: number | null;
    capacityYoY: number | null;
    atp: number | null;
    atpPrevWeek: number | null;
    atpYoY: number | null;
    attendance: number | null;
    // BWW column [5] second token — seats offered that week (per-perf offered × perfs).
    // Varies with production configuration (Circle in the Square Just In Time offers
    // ~690 seats/perf, not the room's nominal max). RevPAS = gross ÷ seatsOffered.
    seatsOffered: number | null;
    performances: number | null;
  };
  allTime: {
    gross: number | null;
    performances: number | null;
    attendance: number | null;
  };
  lastUpdated: string;
}

interface GrossesData {
  lastUpdated: string;
  weekEnding: string;
  shows: Record<string, ShowGrosses>;
}

interface HistoryEntry {
  gross: number | null;
  capacity: number | null;
  atp: number | null;
  attendance: number | null;
  // Optional because historical entries (pre-2026-07-12) don't have this field.
  // New rows always populate it; readers must handle undefined for old weeks.
  seatsOffered?: number | null;
  performances: number | null;
}

interface GrossesHistory {
  _meta: {
    description: string;
    lastUpdated: string;
  };
  weeks: Record<string, Record<string, HistoryEntry>>;
}

interface BWWRowData {
  show: string;
  theater: string;
  gross: number | null;
  grossPrevWeek: number | null;
  grossYoY: number | null;
  atp: number | null;
  attendance: number | null;
  seatsOffered: number | null;
  performances: number | null;
  capacityPct: number | null;
  capacityPctPrevWeek: number | null;
}

interface ScrapeResult {
  rows: BWWRowData[];
  weekEnding: string;
  source: string;
}

// ============================================================
// BWW Theater Name Map (confirmed from live page)
// ============================================================

// Explicit BWW theater names derived from actual BroadwayWorld grosses page.
// BWW concatenates show + theater in a single cell with no delimiter.
// These are the exact uppercase strings BWW uses (sorted longest-first for matching).
const BWW_THEATERS: string[] = [
  // Multi-word theaters (must come first to avoid partial matches)
  'CIRCLE IN THE SQUARE',
  'JAMES EARL JONES',
  'ETHEL BARRYMORE',   // Joe Turner 2026-04: must match before bare BARRYMORE
  'STEPHEN SONDHEIM',
  'RICHARD RODGERS',
  'VIVIAN BEAUMONT',
  'BROOKS ATKINSON',
  'BERNARD B. JACOBS',
  'GERALD SCHOENFELD',
  'SAMUEL J. FRIEDMAN',
  'AMERICAN AIRLINES',
  'AUGUST WILSON',
  'AL HIRSCHFELD',
  'NEW AMSTERDAM',
  'WINTER GARDEN',
  'TODD HAIMES',
  'HELEN HAYES',
  'LUNT-FONTANNE',
  'LUNT FONTANNE',     // BWW sometimes drops the hyphen
  'NEIL SIMON',
  'WALTER KERR',
  'LENA HORNE',
  'EUGENE O\'NEILL',
  'EUGENE ONEILL',     // BWW sometimes drops the apostrophe
  'STUDIO 54',
  'ST. JAMES',
  'MUSIC BOX',
  // Single-word theaters
  'SCHOENFELD',
  'HIRSCHFELD',
  'NEDERLANDER',
  'BARRYMORE',
  'AMBASSADOR',
  'BROADHURST',
  'FRIEDMAN',
  'MAJESTIC',          // Added 2026-04-14 for Beaches preview run
  'MINSKOFF',
  'IMPERIAL',
  'LONGACRE',
  'BROADWAY',
  'GERSHWIN',
  'BELASCO',
  'MARQUIS',
  'SHUBERT',
  'JACOBS',
  'PALACE',
  'GOLDEN',
  'LYCEUM',
  'HUDSON',
  'BOOTH',
  'LYRIC',
  'HAYES',
].sort((a, b) => b.length - a.length); // Longest first for greedy matching

// ============================================================
// Show-Theater Splitting
// ============================================================

// BWW appends status suffixes to shows that aren't yet open in their regular
// run. Observed variants (2026-04-14 data): "IN PREVIEWS", "PREVIEWING",
// "CLOSING WEEK", "FINAL WEEK". Strip these before the theater-suffix match
// below, otherwise every in-previews show gets dropped (bug: on the week
// ending 2026-04-12 this lost 12 shows including Titanique's opening week).
const BWW_STATUS_SUFFIXES: string[] = [
  ' IN PREVIEWS',
  ' PREVIEWING',
  ' CLOSING WEEK',
  ' FINAL WEEK',
  ' PREVIEWS',
];

function stripStatusSuffix(upper: string, original: string): { upper: string; original: string } {
  for (const suffix of BWW_STATUS_SUFFIXES) {
    if (upper.endsWith(suffix)) {
      return {
        upper: upper.slice(0, upper.length - suffix.length).trim(),
        original: original.slice(0, original.length - suffix.length).trim(),
      };
    }
  }
  return { upper, original };
}

function splitShowTheater(text: string): { show: string; theater: string } | null {
  let upper = text.toUpperCase().trim();
  if (!upper) return null;

  // Remove BWW's status suffix (" In Previews" etc.) so the theater name is
  // actually at the end of the string where endsWith() can find it.
  let current = text.trim();
  ({ upper, original: current } = stripStatusSuffix(upper, current));

  for (const theater of BWW_THEATERS) {
    if (upper.endsWith(theater)) {
      const showPart = current.slice(0, current.length - theater.length).trim();
      if (showPart) {
        return { show: showPart, theater };
      }
    }
  }

  console.warn(`  ⚠ No theater match for: "${text}"`);
  return null;
}

// ============================================================
// Show Matching (shared library, high confidence only)
// ============================================================

let allShows: any[] | null = null;

function findMatchingSlug(bwwTitle: string, market: string = 'broadway'): string | null {
  if (!allShows) {
    allShows = loadShowsFromMatching();
  }
  // Always pass market + prefer hints — BroadwayWorld only lists Broadway shows,
  // and weekly grosses belong to the currently-running production (e.g., Chicago
  // 1996 revival, not Chicago 1975 original).
  const match = matchTitleToShow(bwwTitle, allShows, { market, prefer: 'open' });
  if (match && match.confidence === 'high') {
    const slug = match.show.slug;
    // BWW only covers Broadway — never write to West End / Off-Broadway slugs
    if (slug.includes('west-end') || slug.includes('off-broadway') || slug.includes('off-west-end')) {
      return null;
    }
    return slug;
  }
  if (match && match.confidence === 'medium') {
    console.warn(`  ⚠ Medium-confidence match: "${bwwTitle}" → ${match.show.slug} (rejected for financial data)`);
  }
  return null;
}

// ============================================================
// Parse Utilities (unchanged)
// ============================================================

function parseCurrency(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parsePercentage(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/%/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/,/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

function parseWeekEndingToISO(weekEnding: string): string {
  const parts = weekEnding.split('/');
  const month = parts[0].padStart(2, '0');
  const day = parts[1].padStart(2, '0');
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${year}-${month}-${day}`;
}

// ============================================================
// Shared Row Parser (used by both tiers)
// ============================================================

function parseExtractedRow(cells: string[]): BWWRowData | null {
  // Delegates to scripts/lib/parse-bww-grosses-row.js. Kept as a thin wrapper
  // so unit tests exercise the same pure function this production path calls.
  // On sanity-guard drop, log the row loudly (the pure lib returns null silently).
  const row = parseBwwGrossesRow(cells, splitShowTheater);
  if (row !== null) return row;

  // The lib returned null. Distinguish three cases so we log the interesting one:
  //   (a) row too short (< 10 cells) — data plumbing bug, skip silently
  //   (b) splitShowTheater failed — already logged by splitShowTheater itself
  //   (c) sanity guard failed — log LOUDLY (column shift, ATP/perf/cap malformed)
  // Case (c) is the one we always logged pre-refactor. Don't re-call
  // splitShowTheater here — it re-emits its own warn. Use the raw show/theater
  // cell text as the identifier for the drop log.
  if (!cells || cells.length < 10) return null;
  if (cells[1] && parseCurrency(cells[1]) != null) {
    // Format values the same way the old inline parser did (parsed numbers,
    // not raw strings with $/%) so grep-alerts on the log message keep working.
    const atp = parseCurrency(cells[4]?.split(/\s+/)?.[0]);
    const perfs = parseNumber(cells[6]);
    const cap = parsePercentage(cells[7]);
    const showCell = cells[0]?.trim() || '(unknown)';
    console.warn(`  ⚠ Dropping "${showCell}" — implausible parsed values ` +
      `(atp=${atp}, perf=${perfs}, cap=${cap}). BWW columns may have shifted.`);
  }
  return null;
}

function extractWeekEndingFromTitle(title: string): string | null {
  // Old format: "5/10/26" or "5/10/2026"
  const numericMatch = title.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (numericMatch) return numericMatch[1];

  // New format (2026+): "Week of May 10, 2026"
  const MONTHS: Record<string, string> = {
    January: '1', February: '2', March: '3', April: '4', May: '5', June: '6',
    July: '7', August: '8', September: '9', October: '10', November: '11', December: '12',
  };
  const monthMatch = title.match(/Week of (\w+) (\d{1,2}),\s*(\d{4})/);
  if (monthMatch) {
    const month = MONTHS[monthMatch[1]];
    if (month) return `${month}/${monthMatch[2]}/${monthMatch[3]}`;
  }
  return null;
}

// ============================================================
// Tier 1: ScrapingBee CSS Extraction
// ============================================================

function scrapingBeeRequest(url: string, extractRules: Record<string, any>): Promise<string> {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) throw new Error('SCRAPINGBEE_API_KEY not set');

  const params = new URLSearchParams({
    api_key: key,
    url,
    premium_proxy: 'true',
    extract_rules: JSON.stringify(extractRules),
  });

  return new Promise((resolve, reject) => {
    const apiUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`ScrapingBee HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchWithScrapingBee(): Promise<ScrapeResult | null> {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) {
    console.log('  SCRAPINGBEE_API_KEY not set, skipping');
    return null;
  }

  const extractRules = {
    title: 'title',
    rows: {
      selector: '.all-gross-data .row',
      type: 'list',
      output: {
        cells: { selector: '.cell', type: 'list', output: 'text' }
      }
    }
  };

  const raw = await scrapingBeeRequest(GROSSES_URL, extractRules);
  const parsed = JSON.parse(raw);

  // Extract week ending from page title
  const weekEnding = extractWeekEndingFromTitle(parsed.title || '');
  if (!weekEnding) {
    console.warn('  ⚠ Could not extract week ending from page title');
    return null;
  }

  // Parse rows, skip header and total/empty rows
  const rows: BWWRowData[] = [];
  for (const rowData of (parsed.rows || [])) {
    const cells = rowData.cells || [];
    // Skip header row
    if (cells[0]?.trim()?.startsWith('Show')) continue;
    // Skip total/average row
    if (cells[0]?.trim()?.startsWith('Total')) continue;
    // Skip empty rows
    if (!cells[0]?.trim()) continue;

    const row = parseExtractedRow(cells);
    if (row) rows.push(row);
  }

  return { rows, weekEnding, source: 'scrapingbee-css' };
}

// ============================================================
// Tier 2 & 3: Bright Data / Scrapingdog (raw HTML + cheerio parse)
// ============================================================

// Shared parser for any provider that returns raw HTML (BD, Scrapingdog).
// Mirrors the Playwright DOM extraction below (.cell, preferring .out/.value
// spans) but via cheerio since there's no live page to query.
function parseHtmlRows(html: string): { rows: BWWRowData[]; weekEnding: string | null } {
  const $ = cheerio.load(html);
  const weekEnding = extractWeekEndingFromTitle($('title').first().text() || '');

  const rows: BWWRowData[] = [];
  $('.all-gross-data .row').each((_i, rowEl) => {
    const cells: string[] = [];
    $(rowEl).find('.cell').each((_j, cellEl) => {
      const $cell = $(cellEl);
      const out = $cell.find('.out').first();
      const value = $cell.find('.value').first();
      const target = out.length ? out : (value.length ? value : $cell);
      cells.push(target.text().trim());
    });
    if (!cells[0]?.trim()) return; // empty row
    if (cells[0]?.trim()?.startsWith('Show')) return; // header row
    if (cells[0]?.trim()?.startsWith('Total')) return; // total/average row

    const row = parseExtractedRow(cells);
    if (row) rows.push(row);
  });

  return { rows, weekEnding };
}

async function fetchWithHtmlProvider(
  label: string,
  fetchFn: (url: string) => Promise<{ content: string } | null>
): Promise<ScrapeResult | null> {
  const result = await fetchFn(GROSSES_URL);
  if (!result || !result.content) return null;

  const { rows, weekEnding } = parseHtmlRows(result.content);
  if (!weekEnding) {
    console.warn(`  ⚠ [${label}] Could not extract week ending from page title`);
    return null;
  }
  return { rows, weekEnding, source: label };
}

// ============================================================
// Tier 4: Playwright (last resort — no proxy, launches from the CI
// runner's own IP, so it's the tier most exposed to a site-side IP block)
// ============================================================

async function fetchWithPlaywright(): Promise<ScrapeResult | null> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(GROSSES_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);
    await page.waitForSelector('.all-gross-data .row', { timeout: 30000 });

    // Extract week ending from page title
    const title = await page.title();
    const weekEnding = extractWeekEndingFromTitle(title);
    if (!weekEnding) {
      console.warn('  ⚠ Could not extract week ending from page title');
      return null;
    }

    // Extract cell text arrays from all rows (normalize to same format as ScrapingBee)
    const rawRows: string[][] = await page.$$eval('.all-gross-data .row', (rows) => {
      return rows.map((row) => {
        const cells = row.querySelectorAll('.cell');
        return Array.from(cells).map(cell => {
          // For cells with .out or .value spans, prefer those
          const outSpan = cell.querySelector('.out');
          const valueSpan = cell.querySelector('.value');
          return (outSpan || valueSpan || cell).textContent?.trim() || '';
        });
      });
    });

    // Parse rows through the shared parser
    const rows: BWWRowData[] = [];
    for (const cellArray of rawRows) {
      // Skip header, total, and empty rows
      if (cellArray[0]?.trim()?.startsWith('Show')) continue;
      if (cellArray[0]?.trim()?.startsWith('Total')) continue;
      if (!cellArray[0]?.trim()) continue;

      const row = parseExtractedRow(cellArray);
      if (row) rows.push(row);
    }

    return { rows, weekEnding, source: 'playwright' };
  } finally {
    await browser.close();
  }
}

// ============================================================
// Retry Wrapper
// ============================================================

async function fetchWithRetry(
  label: string,
  fn: () => Promise<ScrapeResult | null>,
  maxRetries: number = 2
): Promise<ScrapeResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (result && result.rows.length > 0) return result;
      console.log(`  [${label}] Attempt ${attempt}: empty result`);
    } catch (err: any) {
      console.error(`  [${label}] Attempt ${attempt} failed: ${err.message}`);
    }
    if (attempt < maxRetries) {
      const delay = 3000 * attempt;
      console.log(`  Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}

// ============================================================
// Safety Guards
// ============================================================

function backupGrosses(): void {
  if (!fs.existsSync(GROSSES_PATH)) return;
  const backupPath = GROSSES_PATH.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(GROSSES_PATH, backupPath);
  console.log(`[Backup] Saved to ${path.basename(backupPath)}`);

  // Keep only last 5 backups
  const dir = path.dirname(GROSSES_PATH);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('grosses.backup-') && f.endsWith('.json'))
    .sort()
    .reverse();
  for (const old of backups.slice(5)) {
    fs.unlinkSync(path.join(dir, old));
  }
}

function validateScrapedData(matchedCount: number): boolean {
  if (matchedCount < MIN_SHOWS) {
    console.error(`GUARD: Only ${matchedCount} shows matched (minimum: ${MIN_SHOWS}). Aborting write.`);
    return false;
  }
  return true;
}

function validateGrossSanity(rows: BWWRowData[]): boolean {
  const withGross = rows.filter(r => r.gross !== null);
  const threshold = Math.floor(rows.length * 0.8);
  if (withGross.length < threshold) {
    console.error(`GUARD: Only ${withGross.length}/${rows.length} rows have gross data (need 80%). Aborting write.`);
    return false;
  }
  return true;
}

function validateWeekEnding(weekEnding: string): boolean {
  try {
    const parsed = new Date(parseWeekEndingToISO(weekEnding) + 'T00:00:00Z');
    const now = new Date();
    const daysDiff = Math.abs(now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 14) {
      console.warn(`⚠ Week ending ${weekEnding} is ${Math.round(daysDiff)} days from today. Data may be stale.`);
      return false;
    }
  } catch {
    console.warn(`⚠ Could not parse week ending date: ${weekEnding}`);
  }
  return true;
}

function warnMissingExpectedShows(matchedSlugs: string[]): void {
  const slugSet = new Set(matchedSlugs);
  const missing = EXPECTED_SHOWS.filter(s => !slugSet.has(s));
  if (missing.length > 0) {
    console.error(`⚠ EXPECTED SHOWS MISSING from scraped data: ${missing.join(', ')}`);
    console.error(`  This may indicate a show-matching alias bug or a show closure.`);
    console.error(`  If a show has closed, remove it from EXPECTED_SHOWS in scrape-grosses.ts.`);
  }
}

function validateDropCount(
  matchedCount: number,
  existingGrosses: GrossesData | null
): boolean {
  if (!existingGrosses) return true;
  const existingThisWeekCount = Object.values(existingGrosses.shows).filter(s => s.thisWeek).length;
  const dropped = existingThisWeekCount - matchedCount;
  if (dropped > 5) {
    console.error(`GUARD: ${dropped} shows dropped from previous week (${existingThisWeekCount} → ${matchedCount}). Aborting write.`);
    return false;
  }
  return true;
}

// Compare the scraped count against the live set of Broadway shows that SHOULD
// have grosses (status=open or previews; not West End / Off-Broadway).
// Catches silent-drop bugs the other guards miss:
//   - MIN_SHOWS is an absolute floor; a partial regression (28 of 40) passes it.
//   - EXPECTED_SHOWS only lists 6 long-runners; a 12-show in-previews drop passes.
//   - validateDropCount compares this-week-scraped vs last-week-scraped; if the
//     same shows were missing last week (as on 2026-04-12 for Titanique et al.),
//     delta is zero and the guard never fires.
// This guard compares against today's TRUTH from shows.json: if we're capturing
// <85% of expected open/previews Broadway shows, something is wrong with the
// BWW parse (new status suffix, new theater, renamed show) and we want a loud
// warning — but not a hard-fail, because legitimate edge cases exist (a show
// in previews that hasn't had any performances yet, a dark week).
function validateCaptureRate(matchedSlugs: string[]): void {
  try {
    const shows = loadShowsFromMatching();
    const expectedBroadway = shows.filter((s: { id: string; status?: string }) => {
      const status = s.status;
      if (status !== 'open' && status !== 'previews') return false;
      // BWW only lists Broadway, so exclude WE / OB / OWE shows.
      const id = s.id || '';
      if (id.includes('west-end') || id.includes('off-broadway') || id.includes('off-west-end')) return false;
      return true;
    });
    if (expectedBroadway.length === 0) return;
    const matched = new Set(matchedSlugs);
    const missing = expectedBroadway.filter((s: { slug?: string; id: string }) => {
      const slug = s.slug || s.id;
      return !matched.has(slug);
    });
    const captureRate = (expectedBroadway.length - missing.length) / expectedBroadway.length;
    if (captureRate < 0.85) {
      console.error(`⚠ CAPTURE RATE LOW: only ${expectedBroadway.length - missing.length}/${expectedBroadway.length} expected Broadway shows matched (${(captureRate * 100).toFixed(0)}%).`);
      console.error(`  Missing shows — likely a BWW parse bug (new status suffix, renamed theater, accented title):`);
      missing.slice(0, 20).forEach((s: { id: string; title?: string; status?: string }) => {
        console.error(`    - ${s.id} | "${s.title}" | status=${s.status}`);
      });
      console.error(`  Note: shows in previews that have not yet had performances are legitimately missing; review the list.`);
    } else {
      console.log(`✓ Capture rate: ${expectedBroadway.length - missing.length}/${expectedBroadway.length} (${(captureRate * 100).toFixed(0)}%) — within threshold.`);
    }
  } catch (err) {
    console.warn(`validateCaptureRate skipped: ${(err as Error).message}`);
  }
}

function checkWoWDeltas(
  newData: Record<string, ShowGrosses>,
  existingGrosses: GrossesData | null
): void {
  if (!existingGrosses) return;

  let anomalyCount = 0;
  for (const [slug, newShow] of Object.entries(newData)) {
    if (!newShow.thisWeek?.gross) continue;

    const existingShow = existingGrosses.shows[slug];
    if (!existingShow?.thisWeek?.gross) continue;

    const oldGross = existingShow.thisWeek.gross;
    const newGross = newShow.thisWeek.gross;
    const pctChange = Math.abs(newGross - oldGross) / oldGross;

    if (pctChange > 0.75) {
      anomalyCount++;
      const direction = newGross > oldGross ? '+' : '-';
      console.warn(`  ⚠ WoW anomaly: ${slug} gross ${direction}${(pctChange * 100).toFixed(0)}% ($${oldGross.toLocaleString()} → $${newGross.toLocaleString()})`);
    }
  }

  if (anomalyCount > 3) {
    console.warn(`⚠ ${anomalyCount} shows have >75% WoW gross changes — possible misattribution. Review above.`);
  }
}

// ============================================================
// History Utilities (unchanged)
// ============================================================

function loadHistory(): GrossesHistory {
  if (fs.existsSync(HISTORY_PATH)) {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  }
  return {
    _meta: {
      description: 'Weekly box office snapshots for computing WoW and YoY comparisons',
      lastUpdated: new Date().toISOString()
    },
    weeks: {}
  };
}

function findClosestWeek(history: GrossesHistory, targetDate: Date, maxDaysDiff: number = 7): string | null {
  const targetTime = targetDate.getTime();
  let closestKey: string | null = null;
  let closestDiff = Infinity;

  for (const weekKey of Object.keys(history.weeks)) {
    const weekDate = new Date(weekKey + 'T00:00:00Z');
    const diff = Math.abs(weekDate.getTime() - targetTime);
    const daysDiff = diff / (1000 * 60 * 60 * 24);

    if (daysDiff <= maxDaysDiff && daysDiff < closestDiff) {
      closestDiff = daysDiff;
      closestKey = weekKey;
    }
  }

  return closestKey;
}

function getPrevWeekData(history: GrossesHistory, currentWeekISO: string, showSlug: string): HistoryEntry | null {
  const currentDate = new Date(currentWeekISO + 'T00:00:00Z');
  const prevTarget = new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prevWeekKey = findClosestWeek(history, prevTarget);

  if (prevWeekKey && history.weeks[prevWeekKey]?.[showSlug]) {
    return history.weeks[prevWeekKey][showSlug];
  }
  return null;
}

function getYoYData(history: GrossesHistory, currentWeekISO: string, showSlug: string): HistoryEntry | null {
  const currentDate = new Date(currentWeekISO + 'T00:00:00Z');
  const yoyTarget = new Date(currentDate.getTime() - 364 * 24 * 60 * 60 * 1000); // 52 weeks
  const yoyWeekKey = findClosestWeek(history, yoyTarget);

  if (yoyWeekKey && history.weeks[yoyWeekKey]?.[showSlug]) {
    return history.weeks[yoyWeekKey][showSlug];
  }
  return null;
}

// ============================================================
// Main Scraper
// ============================================================

async function scrapeGrosses(): Promise<void> {
  console.log(`Starting Broadway grosses scrape...${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Try scraping tiers in order
  let result: ScrapeResult | null = null;

  // Tier 1: ScrapingBee CSS extraction
  console.log('\n[Tier 1] ScrapingBee CSS extraction...');
  result = await fetchWithRetry('ScrapingBee', fetchWithScrapingBee);

  // Tier 2: Bright Data (proxied — survives a BWW-side block of the CI IP)
  if (!result) {
    console.log('\n[Tier 2] Bright Data...');
    result = await fetchWithRetry('BrightData', () => fetchWithHtmlProvider('brightdata', fetchWithBrightData));
  }

  // Tier 3: Scrapingdog (proxied, cheaper than BD for a static page)
  if (!result) {
    console.log('\n[Tier 3] Scrapingdog...');
    result = await fetchWithRetry('Scrapingdog', () =>
      fetchWithHtmlProvider('scrapingdog', (url: string) => fetchWithScrapingdog(url, { renderJs: false }))
    );
  }

  // Tier 4: Playwright (last resort, no proxy)
  if (!result) {
    console.log('\n[Tier 4] Playwright (fallback)...');
    result = await fetchWithRetry('Playwright', fetchWithPlaywright);
  }

  if (!result || result.rows.length === 0) {
    console.error('All scraping tiers failed. No data written.');
    process.exit(1);
  }

  console.log(`\nScraped ${result.rows.length} rows via ${result.source}`);
  console.log(`Week ending: ${result.weekEnding}`);

  // Validate week ending date
  validateWeekEnding(result.weekEnding);

  // Validate gross sanity
  if (!validateGrossSanity(result.rows)) {
    process.exit(1);
  }

  // Match shows to our database
  let matchedCount = 0;
  const unmatchedShows: string[] = [];
  const matchedRows: Array<BWWRowData & { slug: string }> = [];

  for (const row of result.rows) {
    const slug = findMatchingSlug(row.show);
    if (slug) {
      matchedCount++;
      matchedRows.push({ ...row, slug });
      console.log(`  ✓ ${row.show} → ${slug}`);
    } else {
      unmatchedShows.push(row.show);
    }
  }

  console.log(`\nMatched ${matchedCount}/${result.rows.length} shows`);
  if (unmatchedShows.length > 0) {
    console.log(`Unmatched (${unmatchedShows.length}):`);
    unmatchedShows.forEach(s => console.log(`  - ${s}`));
  }

  // Validate minimum match count
  if (!validateScrapedData(matchedCount)) {
    process.exit(1);
  }

  // Warn if expected long-running shows are missing (soft — pipeline continues)
  warnMissingExpectedShows(matchedRows.map(r => r.slug));

  // Compare capture rate against live shows.json truth (catches silent-drop
  // class of bugs the fixed-list guards miss). Soft warning, not a hard fail —
  // legitimate previews can be missing if they haven't had any performances.
  validateCaptureRate(matchedRows.map(r => r.slug));

  // Load existing grosses data
  let existingGrosses: GrossesData | null = null;
  if (fs.existsSync(GROSSES_PATH)) {
    try {
      existingGrosses = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf-8'));
      console.log(`Loaded existing grosses data (${Object.keys(existingGrosses!.shows).length} shows)`);
    } catch {
      console.log('Could not load existing grosses.json, starting fresh');
    }
  }

  // Hard-fail if too many shows dropped vs previous week
  if (!validateDropCount(matchedCount, existingGrosses)) {
    process.exit(1);
  }

  // Build grosses data structure
  const grossesData: GrossesData = {
    lastUpdated: new Date().toISOString(),
    weekEnding: result.weekEnding,
    shows: {}
  };

  // Carry forward allTime data for ALL existing shows
  if (existingGrosses) {
    for (const [slug, existing] of Object.entries(existingGrosses.shows)) {
      if (existing.allTime && (existing.allTime.gross || existing.allTime.performances || existing.allTime.attendance)) {
        grossesData.shows[slug] = {
          allTime: { ...existing.allTime },
          lastUpdated: existing.lastUpdated || new Date().toISOString()
        } as ShowGrosses;
      }
    }
  }

  // Apply matched rows
  for (const row of matchedRows) {
    const existingAllTime = grossesData.shows[row.slug]?.allTime || existingGrosses?.shows[row.slug]?.allTime;

    grossesData.shows[row.slug] = {
      thisWeek: {
        gross: row.gross,
        grossPrevWeek: row.grossPrevWeek,
        grossYoY: row.grossYoY,
        capacity: row.capacityPct,
        capacityPrevWeek: row.capacityPctPrevWeek,
        capacityYoY: null, // Enriched from history below
        atp: row.atp,
        atpPrevWeek: null, // Enriched from history below
        atpYoY: null, // Enriched from history below
        attendance: row.attendance,
        seatsOffered: row.seatsOffered,
        performances: row.performances
      },
      allTime: existingAllTime || {
        gross: null,
        performances: null,
        attendance: null
      },
      lastUpdated: new Date().toISOString()
    };
  }

  console.log(`Preserved ${Object.keys(grossesData.shows).length - matchedCount} existing shows (allTime data)`);

  // Check WoW deltas for anomalies
  checkWoWDeltas(grossesData.shows, existingGrosses);

  // History enrichment (ATP WoW, Capacity YoY, ATP YoY)
  const history = loadHistory();
  const weekISO = parseWeekEndingToISO(result.weekEnding);
  console.log(`\nLooking up history for week ${weekISO}...`);

  let atpWoWCount = 0;
  let capYoYCount = 0;
  let atpYoYCount = 0;
  let grossYoYCount = 0;

  for (const [slug, data] of Object.entries(grossesData.shows)) {
    if (!data.thisWeek) continue;

    // ATP WoW from previous week in history
    const prevWeek = getPrevWeekData(history, weekISO, slug);
    if (prevWeek?.atp != null) {
      data.thisWeek.atpPrevWeek = prevWeek.atp;
      atpWoWCount++;
    }

    // Gross / Capacity / ATP YoY from ~52 weeks ago in history. BWW stopped
    // publishing YoY gross in-table (2026-06), so the prior-year absolute gross
    // now comes from our own history snapshot — which is what the newsletter's
    // market-YoY aggregate expects (a comparable dollar value, not a percent).
    const yoyWeek = getYoYData(history, weekISO, slug);
    if (yoyWeek) {
      if (yoyWeek.gross != null) {
        data.thisWeek.grossYoY = yoyWeek.gross;
        grossYoYCount++;
      }
      if (yoyWeek.capacity != null) {
        data.thisWeek.capacityYoY = yoyWeek.capacity;
        capYoYCount++;
      }
      if (yoyWeek.atp != null) {
        data.thisWeek.atpYoY = yoyWeek.atp;
        atpYoYCount++;
      }
    }
  }

  console.log(`  History enrichment: Gross YoY=${grossYoYCount}, ATP WoW=${atpWoWCount}, Capacity YoY=${capYoYCount}, ATP YoY=${atpYoYCount}`);

  // Save current week snapshot to history
  const currentSnapshot: Record<string, HistoryEntry> = {};
  for (const [slug, data] of Object.entries(grossesData.shows)) {
    if (data.thisWeek) {
      currentSnapshot[slug] = {
        gross: data.thisWeek.gross,
        capacity: data.thisWeek.capacity,
        atp: data.thisWeek.atp,
        attendance: data.thisWeek.attendance,
        seatsOffered: data.thisWeek.seatsOffered,
        performances: data.thisWeek.performances
      };
    }
  }
  history.weeks[weekISO] = currentSnapshot;
  history._meta.lastUpdated = new Date().toISOString();

  // Write files (unless dry-run)
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would write:');
    console.log(`  grosses.json: ${Object.keys(grossesData.shows).length} shows (${matchedCount} with thisWeek data)`);
    console.log(`  grosses-history.json: ${Object.keys(history.weeks).length} weeks stored`);
    console.log('\nSample data (first 3 matched shows):');
    for (const row of matchedRows.slice(0, 3)) {
      const data = grossesData.shows[row.slug];
      console.log(`  ${row.slug}: gross=$${data.thisWeek?.gross?.toLocaleString() || 'null'}, capacity=${data.thisWeek?.capacity || 'null'}%, atp=$${data.thisWeek?.atp || 'null'}`);
    }
  } else {
    // Pre-write backup
    backupGrosses();

    fs.writeFileSync(GROSSES_PATH, JSON.stringify(grossesData, null, 2) + '\n');
    console.log(`\nWrote grosses data to ${GROSSES_PATH}`);

    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
    console.log(`Wrote grosses history to ${HISTORY_PATH} (${Object.keys(history.weeks).length} weeks stored)`);
  }

  console.log(`\nScrape source: ${result.source}`);
}

// Run the scraper
scrapeGrosses().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
