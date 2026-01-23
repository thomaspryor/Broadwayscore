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

// Normalize show titles for matching
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
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
  }

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
    if (normalized.includes(key) || key.includes(normalized)) {
      return slug;
    }
  }

  return null;
}

// Parse currency string to number
function parseCurrency(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse percentage string to number
function parsePercentage(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/%/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse number string
function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
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
    await page.goto(GROSSES_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for the table to load
    await page.waitForSelector('table', { timeout: 30000 });

    // Extract the week ending date from the page
    const weekEndingText = await page.$eval(
      'h1, .page-title, [class*="title"]',
      (el) => el.textContent || ''
    ).catch(() => '');

    const weekEndingMatch = weekEndingText.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const weekEnding = weekEndingMatch ? weekEndingMatch[1] : new Date().toISOString().split('T')[0];

    console.log(`Week ending: ${weekEnding}`);

    // Extract data from the grosses table
    const tableData = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const data: Array<{
        show: string;
        gross: string;
        grossDiff: string;
        potentialGross: string;
        avgTicket: string;
        topTicket: string;
        seats: string;
        perfs: string;
        capacity: string;
        capacityDiff: string;
        previews: string;
        theater: string;
      }> = [];

      rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 10) {
          data.push({
            show: cells[0]?.textContent?.trim() || '',
            gross: cells[1]?.textContent?.trim() || '',
            grossDiff: cells[2]?.textContent?.trim() || '',
            potentialGross: cells[3]?.textContent?.trim() || '',
            avgTicket: cells[4]?.textContent?.trim() || '',
            topTicket: cells[5]?.textContent?.trim() || '',
            seats: cells[6]?.textContent?.trim() || '',
            perfs: cells[7]?.textContent?.trim() || '',
            capacity: cells[8]?.textContent?.trim() || '',
            capacityDiff: cells[9]?.textContent?.trim() || '',
            previews: cells[10]?.textContent?.trim() || '',
            theater: cells[11]?.textContent?.trim() || ''
          });
        }
      });

      return data;
    });

    console.log(`Found ${tableData.length} shows in table`);

    // Try to get YoY data by navigating to the same week last year
    // BroadwayWorld uses URL parameters like ?week=2025-01-19
    const currentDate = new Date(weekEnding.replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'));
    const lastYearDate = new Date(currentDate);
    lastYearDate.setFullYear(lastYearDate.getFullYear() - 1);
    const lastYearWeek = `${lastYearDate.getFullYear()}-${String(lastYearDate.getMonth() + 1).padStart(2, '0')}-${String(lastYearDate.getDate()).padStart(2, '0')}`;

    let yoyData: Map<string, { gross: number | null; capacity: number | null; atp: number | null }> = new Map();

    try {
      console.log(`Fetching YoY data for week ${lastYearWeek}...`);
      await page.goto(`${GROSSES_URL}?week=${lastYearWeek}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForSelector('table', { timeout: 30000 });

      const yoyTableData = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        const data: Array<{ show: string; gross: string; avgTicket: string; capacity: string }> = [];

        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 10) {
            data.push({
              show: cells[0]?.textContent?.trim() || '',
              gross: cells[1]?.textContent?.trim() || '',
              avgTicket: cells[4]?.textContent?.trim() || '',
              capacity: cells[8]?.textContent?.trim() || ''
            });
          }
        });

        return data;
      });

      for (const row of yoyTableData) {
        const normalizedShow = normalizeTitle(row.show);
        yoyData.set(normalizedShow, {
          gross: parseCurrency(row.gross),
          capacity: parsePercentage(row.capacity),
          atp: parseCurrency(row.avgTicket)
        });
      }

      console.log(`Found ${yoyData.size} shows in YoY data`);
    } catch (error) {
      console.warn('Could not fetch YoY data:', error);
    }

    // Build the grosses data structure
    const grossesData: GrossesData = {
      lastUpdated: new Date().toISOString(),
      weekEnding,
      shows: {}
    };

    let matchedCount = 0;
    let unmatchedShows: string[] = [];

    for (const row of tableData) {
      const slug = findMatchingSlug(row.show, showMap);

      if (slug) {
        matchedCount++;
        const normalizedShow = normalizeTitle(row.show);
        const yoy = yoyData.get(normalizedShow);

        // Calculate previous week values from diff percentages
        const currentGross = parseCurrency(row.gross);
        const grossDiffPct = parsePercentage(row.grossDiff);
        const prevWeekGross = currentGross && grossDiffPct !== null
          ? Math.round(currentGross / (1 + grossDiffPct / 100))
          : null;

        const currentCapacity = parsePercentage(row.capacity);
        const capacityDiff = parsePercentage(row.capacityDiff);
        const prevWeekCapacity = currentCapacity !== null && capacityDiff !== null
          ? currentCapacity - capacityDiff
          : null;

        grossesData.shows[slug] = {
          thisWeek: {
            gross: currentGross,
            grossPrevWeek: prevWeekGross,
            grossYoY: yoy?.gross || null,
            capacity: currentCapacity,
            capacityPrevWeek: prevWeekCapacity,
            capacityYoY: yoy?.capacity || null,
            atp: parseCurrency(row.avgTicket),
            atpPrevWeek: null, // Not directly available
            atpYoY: yoy?.atp || null,
            attendance: parseNumber(row.seats),
            performances: parseNumber(row.perfs)
          },
          allTime: {
            gross: null, // Will be filled by IBDB scraper
            performances: null,
            attendance: null
          },
          lastUpdated: new Date().toISOString()
        };
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
