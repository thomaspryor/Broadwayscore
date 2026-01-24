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
            capacityYoY: null, // Would need to scrape last year's page
            atp: parseCurrency(row.atp),
            atpPrevWeek: null, // Not directly available
            atpYoY: null, // Would need to scrape last year's page
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

    // Write the data
    fs.writeFileSync(GROSSES_PATH, JSON.stringify(grossesData, null, 2) + '\n');
    console.log(`\nWrote grosses data to ${GROSSES_PATH}`);

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
