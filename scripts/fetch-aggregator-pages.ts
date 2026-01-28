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
// Try direct URLs with -broadway suffix first (most reliable)
async function fetchShowScore(page: Page, showId: string, shows: Record<string, Show>, urlMappings: Record<string, string>): Promise<FetchResult> {
  const show = shows[showId];
  if (!show) {
    return { showId, aggregator: 'show-score', success: false, error: 'Show not found in shows.json' };
  }

  // Generate URL slug from title
  const baseSlug = show.title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[!?.,&:]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Try URL patterns in order of reliability
  // Pattern 1: {slug}-broadway (for shows with multiple productions like hadestown-broadway)
  // Pattern 2: {slug} (simple case)
  // Pattern 3: {slug}-the-musical-broadway (for musicals)
  const urlPatterns = [
    `https://www.show-score.com/broadway-shows/${baseSlug}-broadway`,
    `https://www.show-score.com/broadway-shows/${baseSlug}`,
    `https://www.show-score.com/broadway-shows/${baseSlug}-the-musical-broadway`,
  ];

  try {
    for (const tryUrl of urlPatterns) {
      const response = await page.goto(tryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      const pageUrl = page.url();

      // Reject if redirected to off-Broadway
      if (pageUrl.includes('/off-broadway-shows/') || pageUrl.includes('/off-off-broadway-shows/')) {
        continue; // Try next pattern
      }

      // Check if we landed on a valid Broadway show page
      if (!pageUrl.includes('/broadway-shows/') || pageUrl.includes('/search')) {
        continue; // Try next pattern
      }

      const html = await page.content();

      // Verify it has show data
      if (!html.includes('aggregateRating') && !html.includes('Critic Reviews')) {
        continue; // Try next pattern
      }

      // Success! Save and return
      saveHtml('show-score', showId, html, show.title, pageUrl);

      if (urlMappings[showId] !== pageUrl) {
        urlMappings[showId] = pageUrl;
      }

      return { showId, aggregator: 'show-score', success: true };
    }

    // All patterns failed
    return { showId, aggregator: 'show-score', success: false, error: `No Broadway page found (tried ${urlPatterns.length} URL patterns)` };
  } catch (error) {
    return { showId, aggregator: 'show-score', success: false, error: String(error) };
  }
}

// === DID THEY LIKE IT ===
// DTLI uses different URLs for different productions of the same show:
//   /shows/our-town/     = 2002 revival
//   /shows/our-town-2/   = 2024 revival
//   /shows/suffs/        = off-Broadway 2022
//   /shows/suffs-bway/   = Broadway 2024
// We need to search DTLI to find the correct URL for our specific production.

async function fetchDtli(page: Page, showId: string, shows: Record<string, Show>): Promise<FetchResult> {
  const show = shows[showId];
  if (!show) {
    return { showId, aggregator: 'dtli', success: false, error: 'Show not found in shows.json' };
  }

  const expectedYear = showId.match(/-(\d{4})$/)?.[1];
  const expectedVenue = show.venue?.toLowerCase() || '';

  // Helper to validate page matches expected production
  const validateProduction = (html: string): boolean => {
    // Extract opening date from DTLI page
    const openingMatch = html.match(/Opening Night[:\s]*(?:&nbsp;)?(?:<[^>]+>)?([A-Za-z]+\s+\d+,?\s+\d{4})/i);
    if (openingMatch && expectedYear) {
      const pageYear = openingMatch[1].match(/\d{4}/)?.[0];
      if (pageYear && Math.abs(parseInt(pageYear) - parseInt(expectedYear)) > 1) {
        console.log(`    ⚠️ Year mismatch: page has ${pageYear}, expected ${expectedYear}`);
        return false;
      }
    }
    // Also check for "Broadway" tab if this is a Broadway show
    if (show.venue && html.includes('off-broadway') && !html.includes('broadway-shows')) {
      console.log(`    ⚠️ Page appears to be off-Broadway, not Broadway`);
      return false;
    }
    return true;
  };

  // URL patterns to try, in order of likelihood for revivals
  const baseSlug = show.title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[!?.,]/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  // For revivals/transfers, DTLI often uses suffixes like -2, -bway, -broadway, etc.
  const urlPatterns = [
    `https://didtheylikeit.com/shows/${baseSlug}-bway/`,      // Broadway transfer (suffs-bway)
    `https://didtheylikeit.com/shows/${baseSlug}-broadway/`,  // Broadway suffix
    `https://didtheylikeit.com/shows/${baseSlug}-2/`,         // Revival suffix (our-town-2)
    `https://didtheylikeit.com/shows/${baseSlug}-3/`,         // Third production
    `https://didtheylikeit.com/shows/${baseSlug}-at-the-kit-kat-club/`, // Cabaret special case
    `https://didtheylikeit.com/shows/${baseSlug}/`,           // Base URL (try last - may be old production)
    `https://didtheylikeit.com/shows/${show.slug}/`,          // Show ID slug
  ];

  try {
    for (const url of urlPatterns) {
      console.log(`    Trying: ${url}`);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (response && response.status() === 200) {
        await page.waitForTimeout(500);
        const html = await page.content();

        if (html.includes('Page not found') || html.includes('404') || !html.includes('didtheylikeit')) {
          continue;
        }

        // Validate this is the right production
        if (validateProduction(html)) {
          saveHtml('dtli', showId, html, show.title, url);
          return { showId, aggregator: 'dtli', success: true };
        } else {
          console.log(`    Skipping ${url} - wrong production`);
        }
      }
    }

    return { showId, aggregator: 'dtli', success: false, error: 'Page not found or wrong production (tried multiple URL patterns)' };
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

  // Use BWW's internal search instead of Google (Google blocks headless browsers)
  const searchQuery = `${show.title} review roundup`;
  const searchUrl = `https://www.broadwayworld.com/search/?q=${encodeURIComponent(searchQuery)}&searchtype=articles`;

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Look for review roundup link in search results
    // BWW search results have links with "Review-Roundup" in the URL
    const roundupLinks = page.locator('a[href*="Review-Roundup"]');

    if (await roundupLinks.count() === 0) {
      // Try broader search for any review article
      const reviewLinks = page.locator('a[href*="broadwayworld.com/article/"][href*="Review"]');
      if (await reviewLinks.count() === 0) {
        return { showId, aggregator: 'bww-rr', success: false, error: 'No review roundup found in BWW search' };
      }
      // Use first review link as fallback
      const href = await reviewLinks.first().getAttribute('href');
      if (!href) {
        return { showId, aggregator: 'bww-rr', success: false, error: 'Could not extract URL from search results' };
      }
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      // Click the first review roundup link
      const href = await roundupLinks.first().getAttribute('href');
      if (!href) {
        return { showId, aggregator: 'bww-rr', success: false, error: 'Could not extract review roundup URL' };
      }
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const html = await page.content();

    // Verify it's a BWW article page
    if (!html.includes('broadwayworld') || !finalUrl.includes('/article/')) {
      return { showId, aggregator: 'bww-rr', success: false, error: 'Page does not appear to be a BWW article' };
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
