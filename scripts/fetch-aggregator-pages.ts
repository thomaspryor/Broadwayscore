#!/usr/bin/env npx tsx
/**
 * Fetch Aggregator Pages
 *
 * Fetches HTML pages from review aggregator sites using Playwright.
 * Supports: Show Score, Did They Like It (DTLI), BroadwayWorld Review Roundups
 *
 * Usage:
 *   npx tsx scripts/fetch-aggregator-pages.ts --aggregator show-score --shows two-strangers-bway-2025,boop-2025
 *   npx tsx scripts/fetch-aggregator-pages.ts --aggregator dtli --shows all
 *   npx tsx scripts/fetch-aggregator-pages.ts --aggregator all --shows two-strangers-bway-2025
 *
 * Options:
 *   --aggregator: show-score, dtli, bww-rr, or all
 *   --shows: comma-separated show IDs, "all", or "missing" (only fetch missing)
 *   --force: re-fetch even if file exists
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// Paths
const DATA_DIR = path.join(__dirname, '../data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const SHOW_SCORE_URLS_PATH = path.join(DATA_DIR, 'show-score-urls.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive');

// Types
interface Show {
  id: string;
  title: string;
  slug: string;
}

interface FetchResult {
  showId: string;
  aggregator: string;
  success: boolean;
  error?: string;
}

// Load shows data
function loadShows(): Record<string, Show> {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  // Convert array to record keyed by id
  const shows: Record<string, Show> = {};
  for (const show of data.shows) {
    shows[show.id] = show;
  }
  return shows;
}

// Load Show Score URL mappings
function loadShowScoreUrls(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(SHOW_SCORE_URLS_PATH, 'utf8'));
    return data.shows || {};
  } catch {
    return {};
  }
}

// Generate metadata header for archived HTML
function generateMetadata(aggregator: string, showTitle: string, url: string): string {
  const now = new Date().toISOString();
  return `<!--
Archive: ${aggregator} - ${showTitle}
URL: ${url}
Fetched: ${now.split('T')[0]}
-->
`;
}

// Save HTML to archive
function saveHtml(aggregator: string, showId: string, html: string, showTitle: string, url: string): void {
  const archiveSubdir = aggregator === 'show-score' ? 'show-score' :
                        aggregator === 'dtli' ? 'dtli' : 'bww-roundups';
  const archivePath = path.join(ARCHIVE_DIR, archiveSubdir);

  if (!fs.existsSync(archivePath)) {
    fs.mkdirSync(archivePath, { recursive: true });
  }

  const filePath = path.join(archivePath, `${showId}.html`);
  const metadata = generateMetadata(aggregator, showTitle, url);
  fs.writeFileSync(filePath, metadata + html);
  console.log(`  Saved: ${filePath}`);
}

// Check if archive file exists
function archiveExists(aggregator: string, showId: string): boolean {
  const archiveSubdir = aggregator === 'show-score' ? 'show-score' :
                        aggregator === 'dtli' ? 'dtli' : 'bww-roundups';
  const filePath = path.join(ARCHIVE_DIR, archiveSubdir, `${showId}.html`);
  return fs.existsSync(filePath);
}

// === SHOW SCORE ===
// Show Score blocks direct URL access, so we use search
async function fetchShowScore(page: Page, showId: string, shows: Record<string, Show>, urlMappings: Record<string, string>): Promise<FetchResult> {
  const show = shows[showId];
  if (!show) {
    return { showId, aggregator: 'show-score', success: false, error: 'Show not found in shows.json' };
  }

  try {
    // Navigate to homepage
    await page.goto('https://www.show-score.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Search for the show
    const searchBox = page.getByRole('textbox', { name: 'Search' });
    await searchBox.fill(show.title);
    await searchBox.press('Enter');
    await page.waitForTimeout(2000);

    // Look for Broadway show in results
    const broadwayLink = page.locator(`a:has-text("${show.title}"):has-text("Broadway")`).first();

    if (await broadwayLink.count() === 0) {
      // Try partial match
      const anyLink = page.locator('a[href*="/broadway-shows/"]').first();
      if (await anyLink.count() === 0) {
        return { showId, aggregator: 'show-score', success: false, error: 'No Broadway show found in search results' };
      }
      await anyLink.click();
    } else {
      await broadwayLink.click();
    }

    await page.waitForTimeout(2000);

    // Verify we're on a show page (not search or general page)
    const pageUrl = page.url();
    if (!pageUrl.includes('/broadway-shows/') || pageUrl.includes('/search')) {
      return { showId, aggregator: 'show-score', success: false, error: `Landed on wrong page: ${pageUrl}` };
    }

    // Get HTML
    const html = await page.content();

    // Verify it has show data
    if (!html.includes('aggregateRating') && !html.includes('Critic Reviews')) {
      return { showId, aggregator: 'show-score', success: false, error: 'Page does not contain expected show data' };
    }

    saveHtml('show-score', showId, html, show.title, pageUrl);

    // Update URL mapping if it's different
    if (urlMappings[showId] !== pageUrl) {
      urlMappings[showId] = pageUrl;
    }

    return { showId, aggregator: 'show-score', success: true };
  } catch (error) {
    return { showId, aggregator: 'show-score', success: false, error: String(error) };
  }
}

// === DID THEY LIKE IT ===
async function fetchDtli(page: Page, showId: string, shows: Record<string, Show>): Promise<FetchResult> {
  const show = shows[showId];
  if (!show) {
    return { showId, aggregator: 'dtli', success: false, error: 'Show not found in shows.json' };
  }

  // DTLI uses slug-based URLs
  // Convert show slug to DTLI format (they use the raw title slug)
  const dtliSlug = show.title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[!?.,]/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  const url = `https://didtheylikeit.com/shows/${dtliSlug}/`;

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (!response || response.status() === 404) {
      // Try alternative slug formats
      const altSlugs = [
        show.slug,
        show.title.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
      ];

      for (const altSlug of altSlugs) {
        const altUrl = `https://didtheylikeit.com/shows/${altSlug}/`;
        const altResponse = await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (altResponse && altResponse.status() === 200) {
          const html = await page.content();
          if (html.includes('didtheylikeit') && !html.includes('Page not found')) {
            saveHtml('dtli', showId, html, show.title, altUrl);
            return { showId, aggregator: 'dtli', success: true };
          }
        }
      }

      return { showId, aggregator: 'dtli', success: false, error: 'Page not found (tried multiple slug formats)' };
    }

    await page.waitForTimeout(1000);
    const html = await page.content();

    if (html.includes('Page not found') || html.includes('404')) {
      return { showId, aggregator: 'dtli', success: false, error: 'Page not found' };
    }

    saveHtml('dtli', showId, html, show.title, url);
    return { showId, aggregator: 'dtli', success: true };
  } catch (error) {
    return { showId, aggregator: 'dtli', success: false, error: String(error) };
  }
}

// === BROADWAYWORLD REVIEW ROUNDUPS ===
async function fetchBwwRoundup(page: Page, showId: string, shows: Record<string, Show>): Promise<FetchResult> {
  const show = shows[showId];
  if (!show) {
    return { showId, aggregator: 'bww-rr', success: false, error: 'Show not found in shows.json' };
  }

  // BWW review roundups are articles, need to search for them
  const searchTerms = `${show.title} review roundup site:broadwayworld.com`;

  try {
    // Use Google search to find the review roundup page
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(searchTerms)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Find first BWW link that looks like a review roundup
    const bwwLinks = page.locator('a[href*="broadwayworld.com"][href*="review"]');

    if (await bwwLinks.count() === 0) {
      return { showId, aggregator: 'bww-rr', success: false, error: 'No review roundup found via search' };
    }

    const href = await bwwLinks.first().getAttribute('href');
    if (!href) {
      return { showId, aggregator: 'bww-rr', success: false, error: 'Could not extract URL' };
    }

    // Navigate to the actual BWW page
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const html = await page.content();

    // Verify it's a review roundup article
    if (!html.includes('broadwayworld') || (!html.includes('review') && !html.includes('Review'))) {
      return { showId, aggregator: 'bww-rr', success: false, error: 'Page does not appear to be a review roundup' };
    }

    saveHtml('bww-rr', showId, html, show.title, finalUrl);
    return { showId, aggregator: 'bww-rr', success: true };
  } catch (error) {
    return { showId, aggregator: 'bww-rr', success: false, error: String(error) };
  }
}

// Main fetch function
async function fetchAggregatorPage(
  browser: Browser,
  aggregator: string,
  showId: string,
  shows: Record<string, Show>,
  showScoreUrls: Record<string, string>
): Promise<FetchResult> {
  const page = await browser.newPage();

  try {
    switch (aggregator) {
      case 'show-score':
        return await fetchShowScore(page, showId, shows, showScoreUrls);
      case 'dtli':
        return await fetchDtli(page, showId, shows);
      case 'bww-rr':
        return await fetchBwwRoundup(page, showId, shows);
      default:
        return { showId, aggregator, success: false, error: `Unknown aggregator: ${aggregator}` };
    }
  } finally {
    await page.close();
  }
}

// Parse command line arguments
function parseArgs(): { aggregators: string[]; showIds: string[]; force: boolean } {
  const args = process.argv.slice(2);
  let aggregator = 'all';
  let shows = 'missing';
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--aggregator' && args[i + 1]) {
      aggregator = args[i + 1];
      i++;
    } else if (args[i] === '--shows' && args[i + 1]) {
      shows = args[i + 1];
      i++;
    } else if (args[i] === '--force') {
      force = true;
    }
  }

  const aggregators = aggregator === 'all'
    ? ['show-score', 'dtli', 'bww-rr']
    : [aggregator];

  const showsData = loadShows();
  let showIds: string[];

  if (shows === 'all') {
    showIds = Object.keys(showsData);
  } else if (shows === 'missing') {
    // Will be filtered per-aggregator
    showIds = Object.keys(showsData);
  } else {
    showIds = shows.split(',').map(s => s.trim());
  }

  return { aggregators, showIds, force };
}

// Run Show Score extraction after fetching
async function runShowScoreExtraction(): Promise<void> {
  console.log('\nRunning Show Score extraction script...');
  const { execSync } = require('child_process');
  try {
    execSync('node scripts/extract-show-score-reviews.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('Extraction script failed:', error);
  }
}

// Main
async function main() {
  console.log('=== Aggregator Page Fetcher ===\n');

  const { aggregators, showIds, force } = parseArgs();
  const shows = loadShows();
  const showScoreUrls = loadShowScoreUrls();

  console.log(`Aggregators: ${aggregators.join(', ')}`);
  console.log(`Shows: ${showIds.length} total`);
  console.log(`Force re-fetch: ${force}\n`);

  const browser = await chromium.launch({ headless: true });
  const results: FetchResult[] = [];
  let fetchedShowScore = false;

  try {
    for (const aggregator of aggregators) {
      console.log(`\n--- ${aggregator.toUpperCase()} ---`);

      for (const showId of showIds) {
        // Skip if file exists and not forcing
        if (!force && archiveExists(aggregator, showId)) {
          console.log(`[${showId}] Skipping (file exists)`);
          continue;
        }

        console.log(`[${showId}] Fetching...`);
        const result = await fetchAggregatorPage(browser, aggregator, showId, shows, showScoreUrls);
        results.push(result);

        if (result.success) {
          console.log(`[${showId}] Success`);
          if (aggregator === 'show-score') fetchedShowScore = true;
        } else {
          console.log(`[${showId}] Failed: ${result.error}`);
        }

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } finally {
    await browser.close();
  }

  // Update Show Score URL mappings if any changed
  if (fetchedShowScore) {
    fs.writeFileSync(SHOW_SCORE_URLS_PATH, JSON.stringify({
      _meta: {
        lastUpdated: new Date().toISOString().split('T')[0],
        source: 'Show Score Broadway section',
        needsManualFetch: [],
        needsManualFetchNote: 'URLs auto-updated by fetch script'
      },
      shows: showScoreUrls
    }, null, 2));

    // Run extraction
    await runShowScoreExtraction();
  }

  // Summary
  console.log('\n=== Summary ===');
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Fetched: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFailed shows:');
    for (const r of failed) {
      console.log(`  ${r.aggregator}/${r.showId}: ${r.error}`);
    }
  }
}

main().catch(console.error);
