/**
 * Backfill Grosses History from Playbill
 *
 * Scrapes playbill.com/grosses for past weeks to populate grosses-history.json
 * with enough data for YoY comparisons (capacity YoY, ATP WoW/YoY).
 *
 * Usage: npx tsx scripts/backfill-grosses-history.ts [--weeks 55] [--start-from 2025-01-19]
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// Use shared show-matching library (260+ aliases, market filtering, era preference)
const { matchTitleToShow } = require('./lib/show-matching');

const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const PLAYBILL_URL = 'https://playbill.com/grosses';

interface HistoryEntry {
  gross: number | null;
  capacity: number | null;
  atp: number | null;
  attendance: number | null;
  // Playbill (this backfill's source) does not expose seats-offered — it publishes
  // "Seats Sold + Seats in Theatre" where the second value is nominal capacity,
  // not per-week offered. BWW does expose the correct value. Keep the field
  // optional here so backfill writes remain shape-compatible with the forward
  // scraper's writes without inventing data. See scripts/scrape-grosses.ts.
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

// Load shows array for shared matching library
let allShows: any[] = [];
function loadShows(): void {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  allShows = Array.isArray(data.shows) ? data.shows : Object.values(data.shows);
}

// Match a Playbill title to a show slug using the shared library
// Playbill only covers Broadway → market: 'broadway'. This is a HISTORICAL
// backfill, not a live-week scrape: pass the exact week date so the shared
// matcher disambiguates same-title productions (e.g. Cabaret 1998/2014, Gypsy
// 1989/2003/2024) by which one's run window actually contains that week
// (falls back to closest-opening-year if no window matches), instead of
// always picking whichever revival is open TODAY — otherwise every historical
// week for a recurring title gets attributed to whatever's running right now.
// Found 2026-07-20: year-only disambiguation caused 2,351 chronologically-
// impossible show/week entries across 250 shows in the 2001-2018 backfill.
function findMatchingSlug(title: string, weekDateStr: string): string | null {
  const weekYear = new Date(weekDateStr + 'T00:00:00Z').getFullYear();
  const result = matchTitleToShow(title, allShows, { market: 'broadway', prefer: 'open', year: weekYear, date: weekDateStr });
  if (!result?.show) return null;
  // Require high confidence — medium (word-based fuzzy) causes wrong-show contamination
  if (result.confidence !== 'high') return null;
  const show = result.show;
  // Double-check: reject WE/OB matches (safety net)
  if (show.id?.includes('west-end') || show.id?.includes('off-broadway') || show.id?.includes('off-west-end')) {
    return null;
  }
  return show.slug;
}

// Parse currency string to number
function parseCurrency(value: string): number | null {
  if (!value || value === '-' || value === '') return null;
  const cleaned = value.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse percentage string to number
function parsePercentage(value: string): number | null {
  if (!value || value === '-' || value === '') return null;
  const cleaned = value.replace(/%/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse number string
function parseNumber(value: string): number | null {
  if (!value || value === '-' || value === '') return null;
  const cleaned = value.replace(/,/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
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

// Get list of week dates to backfill
function getWeekDates(numWeeks: number, startFrom?: string): string[] {
  const dates: string[] = [];
  let current: Date;

  if (startFrom) {
    current = new Date(startFrom + 'T00:00:00Z');
  } else {
    // Start from the most recent Sunday
    current = new Date();
    current.setUTCDate(current.getUTCDate() - current.getUTCDay());
  }

  for (let i = 0; i < numWeeks; i++) {
    const dateStr = current.toISOString().split('T')[0];
    dates.push(dateStr);
    current.setUTCDate(current.getUTCDate() - 7);
  }

  return dates;
}

async function backfillHistory(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  let numWeeks = 55; // Default: ~1 year of data
  let startFrom: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--weeks' && args[i + 1]) {
      numWeeks = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--start-from' && args[i + 1]) {
      startFrom = args[i + 1];
      i++;
    }
  }

  console.log(`Backfilling ${numWeeks} weeks of grosses history from Playbill...`);

  loadShows();
  const history = loadHistory();
  const weekDates = getWeekDates(numWeeks, startFrom);

  // Filter out weeks we already have
  const weeksToDo = weekDates.filter(d => !history.weeks[d]);
  console.log(`${weekDates.length} total weeks, ${weeksToDo.length} need backfill (${weekDates.length - weeksToDo.length} already in history)`);

  if (weeksToDo.length === 0) {
    console.log('Nothing to backfill!');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  let successCount = 0;
  let failCount = 0;

  try {
    for (const weekDate of weeksToDo) {
      const MAX_RETRIES = 3;
      let succeeded = false;

      for (let attempt = 1; attempt <= MAX_RETRIES && !succeeded; attempt++) {
        const page = await context.newPage();

        try {
          const url = `${PLAYBILL_URL}?week=${weekDate}`;
          if (attempt === 1) {
            console.log(`\nFetching week ${weekDate}...`);
          } else {
            console.log(`  Retry ${attempt}/${MAX_RETRIES} for week ${weekDate}...`);
          }

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

          // Wait for the grosses table to appear (JS-rendered)
          await page.waitForSelector('table tbody tr', { timeout: 20000 });

          // Extract data from the table
          const rowData = await page.$$eval('table tbody tr', (rows) => {
            return rows.map(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length < 7) return null;

              // Cell 0: Show name + theater
              const showCell = cells[0];
              const showLink = showCell?.querySelector('a');
              const showName = showLink?.textContent?.trim() || '';

              // Cell 1: This Week Gross + Potential Gross
              const grossText = cells[1]?.textContent?.trim() || '';
              const gross = grossText.split('\n')[0]?.trim() || '';

              // Cell 3: Avg Ticket + Top Ticket
              const atpText = cells[3]?.textContent?.trim() || '';
              const atp = atpText.split('\n')[0]?.replace(/\s+/g, ' ')?.trim()?.split(' ')[0] || '';

              // Cell 4: Seats Sold + Seats in Theatre
              const seatsText = cells[4]?.textContent?.trim() || '';
              const seatsSold = seatsText.split('\n')[0]?.replace(/\s+/g, '')?.trim() || '';

              // Cell 5: Perfs + Previews
              const perfsText = cells[5]?.textContent?.trim() || '';
              const perfs = perfsText.split('\n')[0]?.replace(/\s+/g, '')?.trim() || '';

              // Cell 6: % Cap
              const capText = cells[6]?.textContent?.trim() || '';

              return { showName, gross, atp, seatsSold, perfs, capText };
            }).filter(Boolean);
          });

          const weekSnapshot: Record<string, HistoryEntry> = {};
          let matched = 0;

          for (const row of rowData) {
            if (!row || !row.showName) continue;

            const slug = findMatchingSlug(row.showName, weekDate);
            if (slug) {
              weekSnapshot[slug] = {
                gross: parseCurrency(row.gross),
                capacity: parsePercentage(row.capText),
                atp: parseCurrency(row.atp),
                attendance: parseNumber(row.seatsSold),
                performances: parseNumber(row.perfs)
              };
              matched++;
            }
          }

          if (matched > 0) {
            history.weeks[weekDate] = weekSnapshot;
            console.log(`  ✓ ${matched} shows matched for week ${weekDate}`);
            successCount++;
            succeeded = true;

            // Save incrementally every 3 weeks
            if (successCount % 3 === 0) {
              history._meta.lastUpdated = new Date().toISOString();
              fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
              console.log(`  [Saved progress: ${Object.keys(history.weeks).length} weeks]`);
            }
          } else {
            console.log(`  ⚠ No shows matched for week ${weekDate} (${rowData.length} rows found)`);
            if (attempt === MAX_RETRIES) failCount++;
          }

        } catch (error: any) {
          if (attempt === MAX_RETRIES) {
            console.error(`  ✗ Failed for week ${weekDate} after ${MAX_RETRIES} attempts: ${error.message}`);
            failCount++;
          }
        } finally {
          await page.close();
        }

        // Delay between requests (longer on retry)
        const delay = succeeded ? 2000 : (attempt < MAX_RETRIES ? 5000 : 2000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  } finally {
    await browser.close();
  }

  // Final save
  history._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');

  console.log(`\n=== Backfill Complete ===`);
  console.log(`Success: ${successCount}, Failed: ${failCount}`);
  console.log(`Total weeks in history: ${Object.keys(history.weeks).length}`);
  console.log(`Saved to ${HISTORY_PATH}`);
}

backfillHistory().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
