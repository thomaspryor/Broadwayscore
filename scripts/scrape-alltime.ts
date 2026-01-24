/**
 * Broadway All-Time Stats Scraper
 *
 * Scrapes cumulative box office data from BroadwayWorld.
 * Collects: total gross, total performances, total attendance.
 *
 * Usage: npx tsx scripts/scrape-alltime.ts
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const CUMULATIVE_URL = 'https://www.broadwayworld.com/grossescumulative.cfm';
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');

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

// Load our shows database
function loadShows(): Map<string, string> {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  const showMap = new Map<string, string>();

  for (const show of data.shows) {
    showMap.set(normalizeTitle(show.title), show.slug);

    // Add without "The" prefix
    const withoutThe = show.title.replace(/^The\s+/i, '');
    showMap.set(normalizeTitle(withoutThe), show.slug);
  }

  // Manual mappings for BWW title variations
  showMap.set(normalizeTitle('SIX'), 'six');
  showMap.set(normalizeTitle('& JULIET'), 'and-juliet');
  showMap.set(normalizeTitle('HARRY POTTER AND THE CURSED CHILD'), 'harry-potter');
  showMap.set(normalizeTitle('MOULIN ROUGE! THE MUSICAL'), 'moulin-rouge');

  return showMap;
}

// Load existing grosses data
function loadGrosses(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf-8'));
  } catch {
    return {
      lastUpdated: null,
      weekEnding: null,
      shows: {}
    };
  }
}

// Parse currency string to number
function parseCurrency(value: string | null | undefined): number | null {
  if (!value || value === '-') return null;
  const cleaned = value.replace(/[$,]/g, '');
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

// Find matching slug
function findMatchingSlug(bwwTitle: string, showMap: Map<string, string>): string | null {
  const normalized = normalizeTitle(bwwTitle);

  if (showMap.has(normalized)) {
    return showMap.get(normalized)!;
  }

  // Try partial matches
  for (const [key, slug] of showMap) {
    if (key.length < 5) continue;
    if (normalized.includes(key) || key.includes(normalized)) {
      return slug;
    }
  }

  return null;
}

async function scrapeAllTime(): Promise<void> {
  console.log('Starting Broadway all-time stats scrape...');

  const showMap = loadShows();
  const grossesData = loadGrosses() as {
    lastUpdated: string | null;
    weekEnding: string | null;
    shows: Record<string, {
      thisWeek?: Record<string, unknown>;
      allTime: {
        gross: number | null;
        performances: number | null;
        attendance: number | null;
      };
      lastUpdated?: string;
    }>;
  };

  console.log(`Loaded ${showMap.size} show mappings`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log(`Fetching ${CUMULATIVE_URL}...`);
    await page.goto(CUMULATIVE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);

    // Close ad overlay if present
    try {
      await page.click('text=CLICK HERE TO CLOSE', { timeout: 2000 });
      await page.waitForTimeout(1000);
    } catch (e) {}

    // Extract cumulative data from table
    // Format: Show + Theater | Gross | Avg Tix | SeatsSold | Previews | RegularShows | TotalPerf
    const tableData = await page.$$eval('table tr', rows => {
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 6) return null;

        const showTheater = cells[0]?.textContent?.trim() || '';
        const [show] = showTheater.split('\n').map(s => s.trim());

        return {
          show: show || '',
          gross: cells[1]?.textContent?.trim() || '',
          attendance: cells[3]?.textContent?.trim() || '', // SeatsSold
          performances: cells[6]?.textContent?.trim() || '' // TotalPerf
        };
      }).filter(r => r && r.show && r.gross.includes('$'));
    });

    console.log(`Found ${tableData.length} shows with cumulative data`);

    let matchedCount = 0;
    const unmatchedShows: string[] = [];

    for (const row of tableData) {
      if (!row) continue;

      const slug = findMatchingSlug(row.show, showMap);

      if (slug) {
        matchedCount++;

        // Initialize show entry if it doesn't exist
        if (!grossesData.shows[slug]) {
          grossesData.shows[slug] = {
            allTime: {
              gross: null,
              performances: null,
              attendance: null
            }
          };
        }

        grossesData.shows[slug].allTime = {
          gross: parseCurrency(row.gross),
          performances: parseNumber(row.performances),
          attendance: parseNumber(row.attendance)
        };

        console.log(`  ✓ ${row.show} → ${slug} (${row.gross}, ${row.performances} perfs, ${row.attendance} attendance)`);
      } else {
        unmatchedShows.push(row.show);
      }
    }

    console.log(`\nMatched ${matchedCount} shows to our database`);
    if (unmatchedShows.length > 0 && unmatchedShows.length <= 20) {
      console.log(`Unmatched shows (${unmatchedShows.length}):`);
      unmatchedShows.slice(0, 20).forEach(s => console.log(`  - ${s}`));
    }

    grossesData.lastUpdated = new Date().toISOString();

    // Write the updated data
    fs.writeFileSync(GROSSES_PATH, JSON.stringify(grossesData, null, 2) + '\n');
    console.log(`\nWrote all-time stats to ${GROSSES_PATH}`);

  } catch (error) {
    console.error('Scraping failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the scraper
scrapeAllTime().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
