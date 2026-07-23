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
import * as https from 'https';
import * as cheerio from 'cheerio';

// Use the shared show-matching utility (260+ aliases, multi-level matching)
const { matchTitleToShow, loadShows: loadShowsFromMatching } = require('./lib/show-matching');
// Bright Data / Scrapingdog — proxy through non-CI IPs. See scrape-grosses.ts
// for the full incident writeup (2026-07-21/22): ScrapingBee quota-exhausted
// and this script's bare Playwright fallback both fail identically when BWW
// throttles/blocks the GitHub Actions IP range.
const { fetchWithBrightData, fetchWithScrapingdog } = require('./lib/scraper');

const BASE_URL = 'https://www.broadwayworld.com/grossescumulative.cfm';
const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');
const MIN_SHOWS_MAIN_PAGE = 100; // BWW cumulative page typically lists 500+ shows

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

// ScrapingBee CSS extraction for cumulative page
async function scrapePageWithScrapingBee(url: string): Promise<ScrapedRow[]> {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) {
    console.log('  SCRAPINGBEE_API_KEY not set, skipping');
    return [];
  }

  const extractRules = {
    rows: {
      selector: 'table tr',
      type: 'list',
      output: {
        show: 'td:first-child a',  // Show name from anchor (without theater)
        cells: { selector: 'td', type: 'list', output: 'text' }
      }
    }
  };

  const params = new URLSearchParams({
    api_key: key,
    url: url,
    premium_proxy: 'true',
    extract_rules: JSON.stringify(extractRules),
    wait: '5000',
  });

  const apiUrl = `https://app.scrapingbee.com/api/v1/?${params.toString()}`;

  return new Promise<ScrapedRow[]>((resolve, reject) => {
    https.get(apiUrl, { timeout: 90000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`ScrapingBee returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const rows: ScrapedRow[] = [];

          for (const row of (parsed.rows || [])) {
            const cells = row.cells || [];
            // Columns: Show+Theater (0) | Gross (1) | Avg. Tix (2) | Seats Sold (3) | Total Perf. (4)
            // Verified main + ?year=YYYY pages 2026-05-16; previously 7 cols (Previews+RegularShows split out).
            if (cells.length < 5) continue;

            // Use the anchor tag text (clean show name without theater)
            const showTitle = (row.show || '').trim();
            if (!showTitle || showTitle === 'Show' || !(cells[1] || '').includes('$')) continue;

            rows.push({
              showTitle,
              gross: (cells[1] || '').trim(),
              attendance: (cells[3] || '').trim(),
              performances: (cells[4] || '').trim(),
            });
          }

          resolve(rows);
        } catch (e: any) {
          reject(new Error(`ScrapingBee parse error: ${e.message}`));
        }
      });
    }).on('error', reject)
      .on('timeout', () => reject(new Error('ScrapingBee timeout')));
  });
}

// Parse the cumulative-grosses table from raw HTML (BD/Scrapingdog tier).
// Mirrors the Playwright $$eval extraction in scrapePage() below.
function parseAllTimeHtml(html: string): ScrapedRow[] {
  const $ = cheerio.load(html);
  const rows: ScrapedRow[] = [];

  $('table tr').each((_i, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 5) return;

    const showTheater = $(cells[0]).text().trim();
    const lines = showTheater.split('\n').map(s => s.trim()).filter(Boolean);
    const showTitle = lines[0] || '';
    const gross = $(cells[1]).text().trim();
    if (!showTitle || !gross.includes('$')) return;

    rows.push({
      showTitle,
      gross,
      attendance: $(cells[3]).text().trim(),
      performances: $(cells[4]).text().trim(),
    });
  });

  return rows;
}

async function fetchAllTimeHtmlProvider(
  url: string,
  fetchFn: (url: string) => Promise<{ content: string } | null>
): Promise<ScrapedRow[]> {
  const result = await fetchFn(url);
  if (!result || !result.content) return [];
  return parseAllTimeHtml(result.content);
}

// Scrape a single cumulative page with Playwright (fallback)
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
  // Columns: Show+Theater (0) | Gross (1) | Avg. Tix (2) | Seats Sold (3) | Total Perf. (4)
  // Verified main + ?year=YYYY pages 2026-05-16; previously 7 cols (Previews+RegularShows split out).
  const tableData = await page.$$eval('table tr', rows => {
    return rows.map(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) return null;

      const showTheater = cells[0]?.textContent?.trim() || '';
      // The show name is the first line (before the theater name)
      const lines = showTheater.split('\n').map((s: string) => s.trim()).filter(Boolean);
      const showTitle = lines[0] || '';

      return {
        showTitle,
        gross: cells[1]?.textContent?.trim() || '',
        attendance: cells[3]?.textContent?.trim() || '', // SeatsSold column
        performances: cells[4]?.textContent?.trim() || '' // TotalPerf column
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
  let forceOverwrite = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      specificYear = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--all-years') {
      allYears = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--force-overwrite') {
      forceOverwrite = true;
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
  const failedPages: string[] = [];
  let mainPageFailed = false;

  try {
    // Determine which URLs to scrape
    const urls: { url: string; label: string }[] = [];

    if (specificYear) {
      urls.push({ url: `${BASE_URL}?year=${specificYear}`, label: `Year ${specificYear}` });
    } else if (allYears) {
      urls.push({ url: BASE_URL, label: 'Main page (all shows)' });
      const currentYear = new Date().getUTCFullYear();
      for (let year = currentYear; year >= 2005; year--) {
        urls.push({ url: `${BASE_URL}?year=${year}`, label: `Year ${year}` });
      }
    } else {
      // Default: just scrape the main page
      urls.push({ url: BASE_URL, label: 'Main page (all shows)' });
    }

    for (const { url, label } of urls) {
      const MAX_RETRIES = 2;
      let rows: ScrapedRow[] = [];
      let scrapeSource = 'unknown';

      // Tier 1: ScrapingBee CSS extraction
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`\n--- ${label} [Tier 1: ScrapingBee] (attempt ${attempt}/${MAX_RETRIES}) ---`);
          rows = await scrapePageWithScrapingBee(url);
          if (rows.length > 0) {
            scrapeSource = 'scrapingbee-css';
            console.log(`  Found ${rows.length} shows via ScrapingBee`);
            break;
          }
          console.log('  [ScrapingBee] Empty result');
        } catch (error: any) {
          console.log(`  [ScrapingBee] ${error.message}`);
        }
        if (attempt < MAX_RETRIES) {
          console.log(`  Retrying in ${3 * attempt}s...`);
          await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
        }
      }

      // Tier 2: Bright Data (proxied — survives a BWW-side block of the CI IP)
      if (rows.length === 0) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            console.log(`\n--- ${label} [Tier 2: Bright Data] (attempt ${attempt}/${MAX_RETRIES}) ---`);
            rows = await fetchAllTimeHtmlProvider(url, fetchWithBrightData);
            if (rows.length > 0) {
              scrapeSource = 'brightdata';
              break;
            }
            console.log('  [BrightData] Empty result');
          } catch (error: any) {
            console.log(`  [BrightData] ${error.message}`);
          }
          if (attempt < MAX_RETRIES) {
            console.log(`  Retrying in ${3 * attempt}s...`);
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
          }
        }
      }

      // Tier 3: Scrapingdog (proxied, cheaper than BD for a static page)
      if (rows.length === 0) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            console.log(`\n--- ${label} [Tier 3: Scrapingdog] (attempt ${attempt}/${MAX_RETRIES}) ---`);
            rows = await fetchAllTimeHtmlProvider(url, (u: string) => fetchWithScrapingdog(u, { renderJs: false }));
            if (rows.length > 0) {
              scrapeSource = 'scrapingdog';
              break;
            }
            console.log('  [Scrapingdog] Empty result');
          } catch (error: any) {
            console.log(`  [Scrapingdog] ${error.message}`);
          }
          if (attempt < MAX_RETRIES) {
            console.log(`  Retrying in ${3 * attempt}s...`);
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
          }
        }
      }

      // Tier 4: Playwright (last resort, no proxy)
      if (rows.length === 0) {
        const page = await context.newPage();
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            console.log(`\n--- ${label} [Tier 4: Playwright] (attempt ${attempt}/${MAX_RETRIES}) ---`);
            rows = await scrapePage(page, url);
            if (rows.length > 0) {
              scrapeSource = 'playwright';
              break;
            }
          } catch (error: any) {
            if (attempt === MAX_RETRIES) {
              console.error(`  Failed after ${MAX_RETRIES} attempts: ${error.message}`);
            } else {
              console.log(`  Retry in ${3 * attempt}s...`);
              await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
            }
          }
        }
        await page.close();
      }

      if (rows.length === 0) {
        failedPages.push(label);
        if (label === 'Main page (all shows)') mainPageFailed = true;
        // GHA-recognized warning so CI surface shows the failure
        console.log(`::warning::scrape-alltime: ${label} returned 0 rows after all retries`);
      }

      if (rows.length > 0) {
        totalRowsScraped += rows.length;

        let pageMatched = 0;
        let pageSkipped = 0;
        let pageMedium = 0;

        for (const row of rows) {
          // Use shared show-matching utility — high confidence only for financial data
          // BWW all-time data is Broadway-only, and cumulative stats belong to the
          // original production (e.g., Cats 7401 perfs = 1982 original, not 2016 revival)
          const match = matchTitleToShow(row.showTitle, shows, { market: 'broadway', prefer: 'original' });

          if (match && match.confidence === 'high') {
            const slug = match.show.slug || match.show.id;

            // BWW only covers Broadway — skip West End / Off-Broadway matches
            if (slug.includes('west-end') || slug.includes('off-broadway') || slug.includes('off-west-end')) {
              pageSkipped++;
              continue;
            }
            const stats: AllTimeStats = {
              gross: parseCurrency(row.gross),
              performances: parseNumber(row.performances),
              attendance: parseNumber(row.attendance)
            };

            // Keep highest values if show appears across multiple year pages
            const existing = allMatches.get(slug);
            if (existing) {
              stats.gross = Math.max(stats.gross || 0, existing.gross || 0) || null;
              stats.performances = Math.max(stats.performances || 0, existing.performances || 0) || null;
              stats.attendance = Math.max(stats.attendance || 0, existing.attendance || 0) || null;
              pageSkipped++;
            } else {
              pageMatched++;
            }

            allMatches.set(slug, stats);
            unmatchedShows.delete(row.showTitle);
          } else if (match && match.confidence === 'medium') {
            pageMedium++;
          } else {
            unmatchedShows.add(row.showTitle);
          }
        }

        const unmatchedCount = rows.length - pageMatched - pageSkipped - pageMedium;
        console.log(`  Matched: ${pageMatched} new, ${pageSkipped} updated, ${pageMedium} medium (rejected), ${unmatchedCount} unmatched`);
        console.log(`  Scrape source: ${scrapeSource}`);
      }

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
  if (failedPages.length > 0) {
    console.log(`Pages that returned 0 rows: ${failedPages.length}/${(specificYear ? 1 : allYears ? new Date().getUTCFullYear() - 2005 + 2 : 1)}`);
    failedPages.forEach(p => console.log(`  - ${p}`));
  }

  // Per-page failure guard for --all-years. The existing MIN_SHOWS_MAIN_PAGE guard only catches
  // total-outage on main-page-only mode; with --all-years, scattered year-page failures can
  // silently degrade coverage. Abort on main-page failure (always serious) or if >50% of pages
  // failed (BWW likely changed schema or is rate-limiting us).
  if (mainPageFailed && !specificYear) {
    console.error(`\nGUARD: Main page returned 0 rows. Aborting write to avoid persisting partial year-only data.`);
    process.exit(1);
  }
  if (allYears) {
    const totalPages = new Date().getUTCFullYear() - 2005 + 2; // main + (currentYear-2005+1) years
    if (failedPages.length > totalPages / 2) {
      console.error(`\nGUARD: ${failedPages.length}/${totalPages} pages failed. Aborting write — likely BWW schema change or rate-limit.`);
      process.exit(1);
    }
  }

  // Show matches
  // Default: disk-merge with Math.max to protect against partial-year stats overwriting lifetime
  // totals. A standalone `--year YYYY` invocation only sees that one season's stats; without
  // the merge, running `--year 2026` would overwrite Hamilton's $1.14B lifetime with its $40M
  // 2026-season gross. The --all-years path also relies on this via `allMatches` (main page
  // lands first, year pages can't overwrite).
  //
  // Escape hatch: --force-overwrite bypasses the Math.max and writes scraped values verbatim.
  // Use this when BWW publishes a downward correction (e.g., typo fix lowering Hamilton's total),
  // when a bad-high scrape has poisoned a slug, or when intentionally repairing historical data.
  // Without this flag, monotonic merge means lifetime numbers are permanently write-once-higher.
  let newCount = 0;
  let updateCount = 0;
  let downgradeRefused = 0;
  for (const [slug, stats] of allMatches) {
    const existingAllTime = grossesData.shows[slug]?.allTime;
    const hadData = existingAllTime?.gross != null;
    const merged: AllTimeStats = forceOverwrite ? {
      gross: stats.gross,
      performances: stats.performances,
      attendance: stats.attendance,
    } : {
      gross: Math.max(stats.gross || 0, existingAllTime?.gross || 0) || null,
      performances: Math.max(stats.performances || 0, existingAllTime?.performances || 0) || null,
      attendance: Math.max(stats.attendance || 0, existingAllTime?.attendance || 0) || null,
    };

    // Surface downward refusals so operators can spot bad-high pinned values without --dry-run.
    if (!forceOverwrite && hadData && (stats.gross || 0) < (existingAllTime?.gross || 0)) {
      downgradeRefused++;
      const scrapedStr = stats.gross ? `$${(stats.gross / 1_000_000).toFixed(1)}M` : 'null';
      const existingStr = `$${((existingAllTime?.gross || 0) / 1_000_000).toFixed(1)}M`;
      console.log(`  [merge] ${slug}: scraped ${scrapedStr} < stored ${existingStr} — kept stored (rerun with --force-overwrite to replace)`);
    }

    if (!grossesData.shows[slug]) {
      grossesData.shows[slug] = {
        allTime: merged
      };
    } else {
      grossesData.shows[slug].allTime = merged;
    }

    if (hadData) {
      updateCount++;
    } else {
      newCount++;
    }

    if (dryRun) {
      const grossStr = merged.gross ? `$${(merged.gross / 1_000_000).toFixed(1)}M` : 'N/A';
      const perfStr = merged.performances ?? 'N/A';
      const scrapedStr = stats.gross ? `$${(stats.gross / 1_000_000).toFixed(1)}M` : 'N/A';
      const note = hadData && (stats.gross || 0) < (existingAllTime?.gross || 0)
        ? ` (kept existing; scraped ${scrapedStr} was lower)`
        : '';
      console.log(`  ${hadData ? 'UPDATE' : 'NEW'}: ${slug} → ${grossStr} gross, ${perfStr} perfs${note}`);
    }
  }

  console.log(`\nNew entries: ${newCount}`);
  console.log(`Updated entries: ${updateCount}`);
  if (downgradeRefused > 0) {
    console.log(`Downward corrections refused (use --force-overwrite to apply): ${downgradeRefused}`);
  }

  // Show unmatched (first 30)
  if (unmatchedShows.size > 0) {
    const unmatchedArr = Array.from(unmatchedShows).sort();
    console.log(`\nUnmatched shows (${unmatchedShows.size}${unmatchedShows.size > 30 ? ', showing first 30' : ''}):`);
    unmatchedArr.slice(0, 30).forEach(s => console.log(`  - ${s}`));
  }

  // Safety guard: minimum show count (only for main page, not year-filtered)
  if (!specificYear && allMatches.size < MIN_SHOWS_MAIN_PAGE) {
    console.error(`\nGUARD: Only ${allMatches.size} shows matched (minimum: ${MIN_SHOWS_MAIN_PAGE}). Aborting write.`);
    process.exit(1);
  }

  // Write results.
  // Note: no backup file is written. Rollback path = `git revert` on the private data repo
  // (broadway-scorecard-data). A local backup written here would only live in the ephemeral CI
  // runner and never be committed, giving false comfort.
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
