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

// Use the shared show-matching utility (260+ aliases, multi-level matching)
const { matchTitleToShow, loadShows: loadShowsFromMatching } = require('./lib/show-matching');

const GROSSES_URL = 'https://www.broadwayworld.com/grosses.cfm';
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');
const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');

const DRY_RUN = process.argv.includes('--dry-run');
const MIN_SHOWS = 20;

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

function splitShowTheater(text: string): { show: string; theater: string } | null {
  const upper = text.toUpperCase().trim();
  if (!upper) return null;

  for (const theater of BWW_THEATERS) {
    if (upper.endsWith(theater)) {
      const showPart = text.slice(0, text.length - theater.length).trim();
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

function findMatchingSlug(bwwTitle: string): string | null {
  if (!allShows) {
    allShows = loadShowsFromMatching();
  }
  const match = matchTitleToShow(bwwTitle, allShows);
  if (match && match.confidence === 'high') {
    return match.show.slug;
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
  if (cells.length < 10) return null;

  const split = splitShowTheater(cells[0]?.trim() || '');
  if (!split) return null;

  return {
    show: split.show,
    theater: split.theater,
    gross: parseCurrency(cells[1]),
    grossPrevWeek: parseCurrency(cells[2]),
    // cells[3] = diff vs prev week (skip)
    grossYoY: parseCurrency(cells[4]),
    // cells[5] = diff vs last year (skip)
    atp: parseCurrency(cells[6]?.split(/\s+/)?.[0]),         // "ATP TopTicket" → first value
    attendance: parseNumber(cells[7]?.split(/\s+/)?.[0]),     // "Attendance Capacity" → first value
    performances: parseNumber(cells[8]),
    capacityPct: parsePercentage(cells[9]),
    capacityPctPrevWeek: parsePercentage(cells[10]),
  };
}

function extractWeekEndingFromTitle(title: string): string | null {
  const match = title.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  return match ? match[1] : null;
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
// Tier 2: Playwright (fallback)
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

  // Tier 2: Playwright (fallback)
  if (!result) {
    console.log('\n[Tier 2] Playwright (fallback)...');
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

  // Compare match count with existing data
  if (existingGrosses) {
    const existingThisWeekCount = Object.values(existingGrosses.shows).filter(s => s.thisWeek).length;
    if (matchedCount < existingThisWeekCount - 5) {
      console.warn(`⚠ Matched ${matchedCount} vs ${existingThisWeekCount} last week — ${existingThisWeekCount - matchedCount} fewer shows`);
    }
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

  for (const [slug, data] of Object.entries(grossesData.shows)) {
    if (!data.thisWeek) continue;

    // ATP WoW from previous week in history
    const prevWeek = getPrevWeekData(history, weekISO, slug);
    if (prevWeek?.atp != null) {
      data.thisWeek.atpPrevWeek = prevWeek.atp;
      atpWoWCount++;
    }

    // Capacity YoY and ATP YoY from ~52 weeks ago in history
    const yoyWeek = getYoYData(history, weekISO, slug);
    if (yoyWeek) {
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

  console.log(`  History enrichment: ATP WoW=${atpWoWCount}, Capacity YoY=${capYoYCount}, ATP YoY=${atpYoYCount}`);

  // Save current week snapshot to history
  const currentSnapshot: Record<string, HistoryEntry> = {};
  for (const [slug, data] of Object.entries(grossesData.shows)) {
    if (data.thisWeek) {
      currentSnapshot[slug] = {
        gross: data.thisWeek.gross,
        capacity: data.thisWeek.capacity,
        atp: data.thisWeek.atp,
        attendance: data.thisWeek.attendance,
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
