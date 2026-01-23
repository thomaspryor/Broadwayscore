/**
 * IBDB All-Time Stats Scraper
 *
 * Scrapes all-time box office data from IBDB (Internet Broadway Database).
 * Collects: total gross, total performances, total attendance.
 *
 * Usage: npx tsx scripts/scrape-ibdb.ts
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const IBDB_STATS_URL = 'https://www.ibdb.com/statistics/';
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');

interface ShowData {
  slug: string;
  title: string;
}

// Normalize show titles for matching
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '') // Remove leading "The"
    .trim();
}

// Load our shows database
function loadShows(): ShowData[] {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  return data.shows.map((s: { slug: string; title: string }) => ({
    slug: s.slug,
    title: s.title
  }));
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
  if (!value) return null;
  const cleaned = value.replace(/[$,]/g, '');
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

async function scrapeIBDB(): Promise<void> {
  console.log('Starting IBDB all-time stats scrape...');

  const shows = loadShows();
  const grossesData = loadGrosses() as {
    lastUpdated: string | null;
    weekEnding: string | null;
    shows: Record<string, {
      thisWeek: Record<string, unknown>;
      allTime: {
        gross: number | null;
        performances: number | null;
        attendance: number | null;
      };
      lastUpdated: string;
    }>;
  };

  console.log(`Loaded ${shows.length} shows from database`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // First, get the all-time grosses page
    console.log('Fetching IBDB all-time grosses...');
    await page.goto(`${IBDB_STATS_URL}grosses`, { waitUntil: 'networkidle', timeout: 60000 });

    // IBDB shows might need individual page visits for complete stats
    // For now, let's try to get data from the statistics overview

    // Map to store all-time stats by normalized show title
    const allTimeStats = new Map<string, {
      gross: number | null;
      performances: number | null;
      attendance: number | null;
    }>();

    // Try to extract from any available tables
    const tableData = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const results: Array<{
        title: string;
        gross: string;
        performances: string;
        attendance: string;
      }> = [];

      tables.forEach((table) => {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            // Try to identify what type of data this is
            const firstCell = cells[0]?.textContent?.trim() || '';
            const values = Array.from(cells).map(c => c.textContent?.trim() || '');

            results.push({
              title: firstCell,
              gross: values.find(v => v.includes('$')) || '',
              performances: values.find(v => /^\d+,?\d*$/.test(v) && !v.includes('$')) || '',
              attendance: values.find(v => /^\d+,?\d*$/.test(v) && parseInt(v.replace(/,/g, '')) > 10000) || ''
            });
          }
        });
      });

      return results;
    });

    console.log(`Found ${tableData.length} entries in IBDB tables`);

    // Match and store the data
    for (const entry of tableData) {
      const normalizedEntry = normalizeTitle(entry.title);

      for (const show of shows) {
        const normalizedShow = normalizeTitle(show.title);

        if (normalizedEntry === normalizedShow ||
            normalizedEntry.includes(normalizedShow) ||
            normalizedShow.includes(normalizedEntry)) {

          allTimeStats.set(show.slug, {
            gross: parseCurrency(entry.gross),
            performances: parseNumber(entry.performances),
            attendance: parseNumber(entry.attendance)
          });
          break;
        }
      }
    }

    // For shows we didn't find, try to visit individual show pages
    const unfoundShows = shows.filter(s => !allTimeStats.has(s.slug));
    console.log(`Need to look up ${unfoundShows.length} shows individually...`);

    for (const show of unfoundShows.slice(0, 10)) { // Limit to avoid rate limiting
      try {
        const searchTitle = encodeURIComponent(show.title);
        const searchUrl = `https://www.ibdb.com/search?q=${searchTitle}`;

        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000); // Be polite

        // Look for the show in search results
        const showLink = await page.$(`a[href*="/broadway-production/"]:has-text("${show.title.substring(0, 20)}")`);

        if (showLink) {
          await showLink.click();
          await page.waitForLoadState('networkidle');

          // Extract stats from the show page
          const stats = await page.evaluate(() => {
            const text = document.body.innerText;

            // Try to find gross, performances, attendance
            const grossMatch = text.match(/Gross[:\s]+\$?([\d,]+)/i);
            const perfsMatch = text.match(/Performances?[:\s]+([\d,]+)/i);
            const attendMatch = text.match(/Attendance[:\s]+([\d,]+)/i);

            return {
              gross: grossMatch ? grossMatch[1] : null,
              performances: perfsMatch ? perfsMatch[1] : null,
              attendance: attendMatch ? attendMatch[1] : null
            };
          });

          if (stats.gross || stats.performances || stats.attendance) {
            allTimeStats.set(show.slug, {
              gross: parseCurrency(stats.gross),
              performances: parseNumber(stats.performances),
              attendance: parseNumber(stats.attendance)
            });
            console.log(`  Found stats for: ${show.title}`);
          }
        }
      } catch (error) {
        console.warn(`  Could not fetch stats for: ${show.title}`);
      }
    }

    // Update the grosses data with all-time stats
    for (const [slug, stats] of allTimeStats) {
      if (!grossesData.shows[slug]) {
        grossesData.shows[slug] = {
          thisWeek: {
            gross: null,
            grossPrevWeek: null,
            grossYoY: null,
            capacity: null,
            capacityPrevWeek: null,
            capacityYoY: null,
            atp: null,
            atpPrevWeek: null,
            atpYoY: null,
            attendance: null,
            performances: null
          },
          allTime: {
            gross: null,
            performances: null,
            attendance: null
          },
          lastUpdated: new Date().toISOString()
        };
      }

      grossesData.shows[slug].allTime = stats;
      grossesData.shows[slug].lastUpdated = new Date().toISOString();
    }

    grossesData.lastUpdated = new Date().toISOString();

    // Write the updated data
    fs.writeFileSync(GROSSES_PATH, JSON.stringify(grossesData, null, 2) + '\n');
    console.log(`\nUpdated grosses data with all-time stats for ${allTimeStats.size} shows`);

  } catch (error) {
    console.error('IBDB scraping failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the scraper
scrapeIBDB().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
