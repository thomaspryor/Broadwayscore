/**
 * Broadway Grosses Scraper
 *
 * Scrapes weekly box office data from BroadwayWorld using Playwright.
 * Collects: gross, attendance, capacity %, average ticket price
 * With week-over-week and year-over-year comparisons.
 *
 * Usage: npx tsx scripts/scrape-grosses.ts
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const GROSSES_URL = 'https://www.broadwayworld.com/grosses.cfm';
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');
const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');

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

// Normalize show titles for matching
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

// Create a slug from a title
function createSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Load our shows database
function loadShows(): Map<string, string> {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  const showMap = new Map<string, string>();

  for (const show of data.shows) {
    // Map both the slug and normalized title to the slug
    showMap.set(show.slug, show.slug);
    showMap.set(normalizeTitle(show.title), show.slug);

    // Also add common variations
    const titleSlug = createSlug(show.title);
    showMap.set(titleSlug, show.slug);

    // Add without "The" prefix
    const withoutThe = show.title.replace(/^The\s+/i, '');
    showMap.set(normalizeTitle(withoutThe), show.slug);
  }

  // Manual mappings for BWW title variations
  showMap.set(normalizeTitle('SIX: THE MUSICAL'), 'six');
  showMap.set(normalizeTitle('SIX THE MUSICAL'), 'six');
  showMap.set(normalizeTitle('& JULIET'), 'and-juliet');
  showMap.set(normalizeTitle('ALADDIN'), 'aladdin');
  showMap.set(normalizeTitle('ALL OUT: COMEDY ABOUT AMBITION'), 'all-out');  // if we add this show

  return showMap;
}

// Find matching slug for a BroadwayWorld show title
function findMatchingSlug(bwwTitle: string, showMap: Map<string, string>): string | null {
  const normalized = normalizeTitle(bwwTitle);

  // Direct match
  if (showMap.has(normalized)) {
    return showMap.get(normalized)!;
  }

  // Try slug version
  const slugVersion = createSlug(bwwTitle);
  if (showMap.has(slugVersion)) {
    return showMap.get(slugVersion)!;
  }

  // Try partial matches for shows with subtitles
  for (const [key, slug] of showMap) {
    // Skip very short keys to avoid false matches
    if (key.length < 5) continue;

    if (normalized.includes(key) || key.includes(normalized)) {
      return slug;
    }
  }

  return null;
}

// Parse currency string to number
function parseCurrency(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse percentage string to number
function parsePercentage(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/%/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse number string
function parseNumber(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/,/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

// Parse "M/DD/YYYY" or "MM/DD/YYYY" to "YYYY-MM-DD"
function parseWeekEndingToISO(weekEnding: string): string {
  const parts = weekEnding.split('/');
  const month = parts[0].padStart(2, '0');
  const day = parts[1].padStart(2, '0');
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${year}-${month}-${day}`;
}

// Load or initialize grosses history
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

// Find the closest week in history to a target date (within maxDaysDiff)
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

// Get previous week's data for a show from history
function getPrevWeekData(history: GrossesHistory, currentWeekISO: string, showSlug: string): HistoryEntry | null {
  const currentDate = new Date(currentWeekISO + 'T00:00:00Z');
  const prevTarget = new Date(currentDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prevWeekKey = findClosestWeek(history, prevTarget);

  if (prevWeekKey && history.weeks[prevWeekKey]?.[showSlug]) {
    return history.weeks[prevWeekKey][showSlug];
  }
  return null;
}

// Get same-week-last-year data for a show from history
function getYoYData(history: GrossesHistory, currentWeekISO: string, showSlug: string): HistoryEntry | null {
  const currentDate = new Date(currentWeekISO + 'T00:00:00Z');
  const yoyTarget = new Date(currentDate.getTime() - 364 * 24 * 60 * 60 * 1000); // 52 weeks
  const yoyWeekKey = findClosestWeek(history, yoyTarget);

  if (yoyWeekKey && history.weeks[yoyWeekKey]?.[showSlug]) {
    return history.weeks[yoyWeekKey][showSlug];
  }
  return null;
}

async function scrapeGrosses(): Promise<void> {
  console.log('Starting Broadway grosses scrape...');

  const showMap = loadShows();
  console.log(`Loaded ${showMap.size} show mappings`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log(`Fetching ${GROSSES_URL}...`);
    await page.goto(GROSSES_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);

    // Wait for the data to load
    await page.waitForSelector('.all-gross-data .row', { timeout: 30000 });

    // Extract the week ending date from the page title
    const title = await page.title();
    const weekEndingMatch = title.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const weekEnding = weekEndingMatch ? weekEndingMatch[1] : new Date().toISOString().split('T')[0];
    console.log(`Week ending: ${weekEnding}`);

    // Extract data from all rows (skip header row which is :nth-child(2))
    const tableData = await page.$$eval('.all-gross-data .row:not(:first-child):not(:nth-child(2))', (rows) => {
      return rows.map((row) => {
        const cells = row.querySelectorAll('.cell');
        if (cells.length < 10) return null;

        // Cell 0: Show + Theater
        const showTheater = cells[0]?.textContent?.trim() || '';
        const [show, theater] = showTheater.split('\n').map(s => s.trim());

        // Cell 1: Current gross (use .out span)
        const gross = cells[1]?.querySelector('.out')?.textContent?.trim() || cells[1]?.textContent?.trim() || '';

        // Cell 2: Previous week gross
        const grossPrevWeek = cells[2]?.querySelector('.out')?.textContent?.trim() || cells[2]?.textContent?.trim() || '';

        // Cell 3: Gross diff (skip)

        // Cell 4: Last year gross
        const grossYoY = cells[4]?.querySelector('.out')?.textContent?.trim() || cells[4]?.textContent?.trim() || '';

        // Cell 5: Gross diff vs last year (skip)

        // Cell 6: Avg ticket + top ticket (use .out for avg)
        const atp = cells[6]?.querySelector('.out')?.textContent?.trim() || '';

        // Cell 7: Attendance + capacity (use .out for attendance)
        const attendance = cells[7]?.querySelector('.out')?.textContent?.trim() || '';

        // Cell 8: Performances
        const performances = cells[8]?.querySelector('.out')?.textContent?.trim() || cells[8]?.textContent?.trim() || '';

        // Cell 9: Capacity % this week
        const capacityPct = cells[9]?.querySelector('.value')?.textContent?.trim() || cells[9]?.textContent?.trim() || '';

        // Cell 10: Capacity % last week
        const capacityPctPrevWeek = cells[10]?.querySelector('.value')?.textContent?.trim() || cells[10]?.textContent?.trim() || '';

        return {
          show: show || '',
          theater: theater || '',
          gross,
          grossPrevWeek,
          grossYoY,
          atp,
          attendance,
          performances,
          capacityPct,
          capacityPctPrevWeek
        };
      }).filter(Boolean);
    });

    console.log(`Found ${tableData.length} shows in table`);

    // Build the grosses data structure
    const grossesData: GrossesData = {
      lastUpdated: new Date().toISOString(),
      weekEnding,
      shows: {}
    };

    let matchedCount = 0;
    const unmatchedShows: string[] = [];

    for (const row of tableData) {
      if (!row) continue;

      const slug = findMatchingSlug(row.show, showMap);

      if (slug) {
        matchedCount++;

        grossesData.shows[slug] = {
          thisWeek: {
            gross: parseCurrency(row.gross),
            grossPrevWeek: parseCurrency(row.grossPrevWeek),
            grossYoY: parseCurrency(row.grossYoY),
            capacity: parsePercentage(row.capacityPct),
            capacityPrevWeek: parsePercentage(row.capacityPctPrevWeek),
            capacityYoY: null, // Enriched from history below
            atp: parseCurrency(row.atp),
            atpPrevWeek: null, // Enriched from history below
            atpYoY: null, // Enriched from history below
            attendance: parseNumber(row.attendance),
            performances: parseNumber(row.performances)
          },
          allTime: {
            gross: null, // Will be filled by IBDB scraper
            performances: null,
            attendance: null
          },
          lastUpdated: new Date().toISOString()
        };

        console.log(`  ✓ ${row.show} → ${slug}`);
      } else {
        unmatchedShows.push(row.show);
      }
    }

    console.log(`\nMatched ${matchedCount} shows to our database`);
    if (unmatchedShows.length > 0) {
      console.log(`Unmatched shows (${unmatchedShows.length}):`);
      unmatchedShows.forEach(s => console.log(`  - ${s}`));
    }

    // Load history and enrich with WoW/YoY comparisons
    const history = loadHistory();
    const weekISO = parseWeekEndingToISO(weekEnding);
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

    // Write both files
    fs.writeFileSync(GROSSES_PATH, JSON.stringify(grossesData, null, 2) + '\n');
    console.log(`\nWrote grosses data to ${GROSSES_PATH}`);

    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
    console.log(`Wrote grosses history to ${HISTORY_PATH} (${Object.keys(history.weeks).length} weeks stored)`);

  } catch (error) {
    console.error('Scraping failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the scraper
scrapeGrosses().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
