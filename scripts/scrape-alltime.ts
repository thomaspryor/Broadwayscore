/**
 * Broadway All-Time Cumulative Grosses Scraper
 *
 * Scrapes BroadwayWorld's cumulative grosses page for all-time box office stats.
 * The page lists 500+ shows on a single page and supports year filtering.
 *
 * Usage:
 *   npx tsx scripts/scrape-alltime.ts                     # Scrape main page (all shows)
 *   npx tsx scripts/scrape-alltime.ts --year 2020          # Scrape specific year
 *   npx tsx scripts/scrape-alltime.ts --all-years          # Loop through years 2005-2026
 *   npx tsx scripts/scrape-alltime.ts --dry-run            # Preview matches without writing
 *   npx tsx scripts/scrape-alltime.ts --all-years --dry-run
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// Use the shared show-matching utility (260+ aliases, multi-level matching)
const { matchTitleToShow, loadShows: loadShowsFromMatching } = require('./lib/show-matching');

const BASE_URL = 'https://www.broadwayworld.com/grossescumulative.cfm';
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');

interface AllTimeStats {
  gross: number | null;
  performances: number | null;
  attendance: number | null;
}

interface GrossesData {
  lastUpdated: string | null;
  weekEnding: string | null;
  shows: Record<string, {
    thisWeek?: Record<string, unknown>;
    allTime: AllTimeStats;
    lastUpdated?: string;
  }>;
}

interface ScrapedRow {
  showTitle: string;
  gross: string;
  attendance: string;
  performances: string;
}

// Parse currency string to number
function parseCurrency(value: string | null | undefined): number | null {
  if (!value || value === '-' || value === '') return null;
  const cleaned = value.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse number string
function parseNumber(value: string | null | undefined): number | null {
  if (!value || value === '-' || value === '') return null;
  const cleaned = value.replace(/,/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

// Load existing grosses data
function loadGrosses(): GrossesData {
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

// Scrape a single cumulative page (main page or year-filtered)
async function scrapePage(page: Page, url: string): Promise<ScrapedRow[]> {
  console.log(`\nFetching: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  // Close ad overlay if present
  try {
    await page.click('text=CLICK HERE TO CLOSE', { timeout: 3000 });
    await page.waitForTimeout(1000);
  } catch { /* no overlay */ }

  // Wait for table to render
  try {
    await page.waitForSelector('table tr td', { timeout: 15000 });
  } catch {
    console.log('  Warning: Table may not have loaded fully');
  }

  // Extract cumulative data from table
  // Columns: Show+Theater (0), Gross (1), Avg Tix (2), SeatsSold (3), Previews (4), RegularShows (5), TotalPerf (6)
  const tableData = await page.$$eval('table tr', rows => {
    return rows.map(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 6) return null;

      const showTheater = cells[0]?.textContent?.trim() || '';
      // The show name is the first line (before the theater name)
      const lines = showTheater.split('\n').map((s: string) => s.trim()).filter(Boolean);
      const showTitle = lines[0] || '';

      return {
        showTitle,
        gross: cells[1]?.textContent?.trim() || '',
        attendance: cells[3]?.textContent?.trim() || '', // SeatsSold column
        performances: cells[6]?.textContent?.trim() || '' // TotalPerf column
      };
    }).filter((r): r is { showTitle: string; gross: string; attendance: string; performances: string } =>
      r !== null && r.showTitle !== '' && r.gross.includes('$')
    );
  });

  console.log(`  Found ${tableData.length} shows on page`);
  return tableData;
}

async function scrapeAllTime(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  let specificYear: number | null = null;
  let allYears = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      specificYear = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--all-years') {
      allYears = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  console.log('=== Broadway All-Time Cumulative Grosses Scraper ===');
  if (dryRun) console.log('  [DRY RUN - no files will be written]');

  // Load shows database for matching
  const shows = loadShowsFromMatching();
  console.log(`Loaded ${shows.length} shows from shows.json`);

  const grossesData = dryRun ? loadGrosses() : loadGrosses();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // Track all matches across all pages
  const allMatches: Map<string, AllTimeStats> = new Map();
  const unmatchedShows: Set<string> = new Set();
  let totalRowsScraped = 0;

  try {
    // Determine which URLs to scrape
    const urls: { url: string; label: string }[] = [];

    if (specificYear) {
      urls.push({ url: `${BASE_URL}?year=${specificYear}`, label: `Year ${specificYear}` });
    } else if (allYears) {
      // Scrape main page first (has all shows), then individual years for any we missed
      urls.push({ url: BASE_URL, label: 'Main page (all shows)' });
      // Broadway seasons we track: 2005-2026
      for (let year = 2026; year >= 2005; year--) {
        urls.push({ url: `${BASE_URL}?year=${year}`, label: `Year ${year}` });
      }
    } else {
      // Default: just scrape the main page
      urls.push({ url: BASE_URL, label: 'Main page (all shows)' });
    }

    for (const { url, label } of urls) {
      const page = await context.newPage();
      const MAX_RETRIES = 3;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`\n--- ${label} (attempt ${attempt}/${MAX_RETRIES}) ---`);
          const rows = await scrapePage(page, url);
          totalRowsScraped += rows.length;

          let pageMatched = 0;
          let pageSkipped = 0;

          for (const row of rows) {
            // Use shared show-matching utility
            const match = matchTitleToShow(row.showTitle, shows);

            if (match) {
              const slug = match.show.slug || match.show.id;
              const stats: AllTimeStats = {
                gross: parseCurrency(row.gross),
                performances: parseNumber(row.performances),
                attendance: parseNumber(row.attendance)
              };

              // Keep highest values if show appears across multiple year pages
              const existing = allMatches.get(slug);
              if (existing) {
                // Take the maximum of each stat (cumulative should be highest on main page)
                stats.gross = Math.max(stats.gross || 0, existing.gross || 0) || null;
                stats.performances = Math.max(stats.performances || 0, existing.performances || 0) || null;
                stats.attendance = Math.max(stats.attendance || 0, existing.attendance || 0) || null;
                pageSkipped++;
              } else {
                pageMatched++;
              }

              allMatches.set(slug, stats);
              unmatchedShows.delete(row.showTitle); // Remove from unmatched if previously unmatched
            } else {
              unmatchedShows.add(row.showTitle);
            }
          }

          console.log(`  Matched: ${pageMatched} new, ${pageSkipped} updated, ${rows.length - pageMatched - pageSkipped} unmatched`);
          break; // Success, no retry needed

        } catch (error: any) {
          if (attempt === MAX_RETRIES) {
            console.error(`  Failed after ${MAX_RETRIES} attempts: ${error.message}`);
          } else {
            console.log(`  Retry ${attempt + 1}/${MAX_RETRIES}...`);
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
          }
        }
      }

      await page.close();

      // Brief delay between pages to be polite
      if (urls.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } finally {
    await browser.close();
  }

  // Apply matches to grosses data
  console.log('\n=== Results ===');
  console.log(`Total rows scraped: ${totalRowsScraped}`);
  console.log(`Matched to shows.json: ${allMatches.size}`);
  console.log(`Unmatched: ${unmatchedShows.size}`);

  // Show matches
  let newCount = 0;
  let updateCount = 0;
  for (const [slug, stats] of allMatches) {
    const hadData = grossesData.shows[slug]?.allTime?.gross != null;

    if (!grossesData.shows[slug]) {
      grossesData.shows[slug] = {
        allTime: stats
      };
    } else {
      grossesData.shows[slug].allTime = stats;
    }

    if (hadData) {
      updateCount++;
    } else {
      newCount++;
    }

    if (dryRun) {
      const grossStr = stats.gross ? `$${(stats.gross / 1_000_000).toFixed(1)}M` : 'N/A';
      const perfStr = stats.performances ?? 'N/A';
      console.log(`  ${hadData ? 'UPDATE' : 'NEW'}: ${slug} → ${grossStr} gross, ${perfStr} perfs`);
    }
  }

  console.log(`\nNew entries: ${newCount}`);
  console.log(`Updated entries: ${updateCount}`);

  // Show unmatched (first 30)
  if (unmatchedShows.size > 0) {
    const unmatchedArr = Array.from(unmatchedShows).sort();
    console.log(`\nUnmatched shows (${unmatchedShows.size}${unmatchedShows.size > 30 ? ', showing first 30' : ''}):`);
    unmatchedArr.slice(0, 30).forEach(s => console.log(`  - ${s}`));
  }

  // Write results
  if (!dryRun) {
    grossesData.lastUpdated = new Date().toISOString();
    fs.writeFileSync(GROSSES_PATH, JSON.stringify(grossesData, null, 2) + '\n');
    console.log(`\nWrote all-time stats to ${GROSSES_PATH}`);
  } else {
    console.log('\n[DRY RUN] No files written.');
  }

  // Summary of shows.json coverage
  const showsWithAllTime = Object.values(grossesData.shows).filter(
    s => s.allTime && s.allTime.gross != null
  ).length;
  console.log(`\nTotal shows with allTime data: ${showsWithAllTime}/${shows.length}`);
}

// Run the scraper
scrapeAllTime().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
