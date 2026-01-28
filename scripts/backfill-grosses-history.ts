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

const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const PLAYBILL_URL = 'https://playbill.com/grosses';

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

// Load our shows database for matching
function loadShows(): Map<string, string> {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  const showMap = new Map<string, string>();

  for (const show of data.shows) {
    showMap.set(show.slug, show.slug);
    showMap.set(normalizeTitle(show.title), show.slug);
    const titleSlug = createSlug(show.title);
    showMap.set(titleSlug, show.slug);
    const withoutThe = show.title.replace(/^The\s+/i, '');
    showMap.set(normalizeTitle(withoutThe), show.slug);
  }

  // Manual mappings for Playbill title variations
  showMap.set(normalizeTitle('SIX: The Musical'), 'six');
  showMap.set(normalizeTitle('SIX THE MUSICAL'), 'six');
  showMap.set(normalizeTitle('& Juliet'), 'and-juliet');
  showMap.set(normalizeTitle('ALADDIN'), 'aladdin');
  showMap.set(normalizeTitle('MJ The Musical'), 'mj');
  showMap.set(normalizeTitle('Moulin Rouge! The Musical'), 'moulin-rouge');
  showMap.set(normalizeTitle("Harry Potter and the Cursed Child"), 'harry-potter');
  showMap.set(normalizeTitle('Stranger Things: The First Shadow'), 'stranger-things');
  showMap.set(normalizeTitle('Two Strangers (Carry a Cake Across New York)'), 'two-strangers');
  showMap.set(normalizeTitle("Mamma Mia!"), 'mamma-mia');
  showMap.set(normalizeTitle("Oh, Mary!"), 'oh-mary');
  showMap.set(normalizeTitle("A Wonderful World: The Louis Armstrong Musical"), 'wonderful-world');
  showMap.set(normalizeTitle("Suffs"), 'suffs');
  showMap.set(normalizeTitle("Water for Elephants"), 'water-for-elephants');
  showMap.set(normalizeTitle("The Who's Tommy"), 'the-whos-tommy');
  showMap.set(normalizeTitle("The Wiz"), 'the-wiz');
  showMap.set(normalizeTitle("The Notebook"), 'the-notebook');
  showMap.set(normalizeTitle("All Out: Comedy About Ambition"), 'all-out');

  return showMap;
}

function findMatchingSlug(title: string, showMap: Map<string, string>): string | null {
  const normalized = normalizeTitle(title);

  if (showMap.has(normalized)) return showMap.get(normalized)!;

  const slugVersion = createSlug(title);
  if (showMap.has(slugVersion)) return showMap.get(slugVersion)!;

  for (const [key, slug] of showMap) {
    if (key.length < 5) continue;
    if (normalized.includes(key) || key.includes(normalized)) return slug;
  }

  return null;
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

  const showMap = loadShows();
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
      const page = await context.newPage();

      try {
        const url = `${PLAYBILL_URL}?week=${weekDate}`;
        console.log(`\nFetching week ${weekDate}...`);

        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Wait for the grosses table to appear
        await page.waitForSelector('table', { timeout: 15000 });

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

          const slug = findMatchingSlug(row.showName, showMap);
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

          // Save incrementally every 5 weeks
          if (successCount % 5 === 0) {
            history._meta.lastUpdated = new Date().toISOString();
            fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
            console.log(`  [Saved progress: ${Object.keys(history.weeks).length} weeks]`);
          }
        } else {
          console.log(`  ⚠ No shows matched for week ${weekDate} (${rowData.length} rows found)`);
          failCount++;
        }

      } catch (error: any) {
        console.error(`  ✗ Failed for week ${weekDate}: ${error.message}`);
        failCount++;
      } finally {
        await page.close();
      }

      // Respectful delay between requests
      await new Promise(resolve => setTimeout(resolve, 2000));
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
