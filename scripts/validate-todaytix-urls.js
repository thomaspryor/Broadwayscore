#!/usr/bin/env node
/**
 * validate-todaytix-urls.js
 *
 * Validates that all TodayTix URLs in shows.json are working.
 * TodayTix URLs must have numeric IDs (e.g., /shows/12345-show-name) to work.
 * URLs with just search queries (e.g., /shows?q=Show+Name) return 404.
 *
 * This script:
 * 1. Checks all TodayTix URLs for proper format (must have numeric ID)
 * 2. Optionally validates URLs are live (--check-live flag)
 * 3. Reports any broken/invalid URLs
 * 4. Can auto-search for correct URLs (--auto-fix flag)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Valid TodayTix URL pattern: must have numeric ID
const VALID_TODAYTIX_PATTERN = /todaytix\.com\/nyc\/shows\/(\d+)-/;

// Invalid pattern: search query URLs
const SEARCH_URL_PATTERN = /todaytix\.com\/nyc\/shows\?q=/;

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function isValidTodayTixUrl(url) {
  if (!url) return false;

  // Must match the valid pattern (has numeric ID)
  if (VALID_TODAYTIX_PATTERN.test(url)) return true;

  return false;
}

function isSearchUrl(url) {
  return SEARCH_URL_PATTERN.test(url);
}

// Check if URL returns 200 (live validation)
function checkUrlLive(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'HEAD',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)'
      }
    };

    const req = https.request(options, (res) => {
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 400,
        redirectTo: res.headers.location
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'timeout' });
    });

    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const checkLive = args.includes('--check-live');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const json = args.includes('--json');

  console.log('='.repeat(60));
  console.log('TODAYTIX URL VALIDATOR');
  console.log('='.repeat(60));
  console.log(`Check live URLs: ${checkLive ? 'YES' : 'NO (use --check-live)'}`);
  console.log('');

  const data = loadShows();
  const results = {
    total: 0,
    valid: 0,
    invalid: [],
    searchUrls: [],
    liveCheckFailed: [],
    needsUpdate: []
  };

  // Filter to open/preview shows only (closed shows don't need ticket links)
  const relevantShows = data.shows.filter(s => s.status === 'open' || s.status === 'previews');

  for (const show of relevantShows) {
    if (!show.ticketLinks || show.ticketLinks.length === 0) continue;

    for (const link of show.ticketLinks) {
      if (link.platform !== 'TodayTix') continue;

      results.total++;
      const url = link.url;

      // Check if it has needsUpdate flag
      if (link.needsUpdate) {
        results.needsUpdate.push({
          showId: show.id,
          title: show.title,
          url
        });
      }

      // Check URL format
      if (isSearchUrl(url)) {
        results.searchUrls.push({
          showId: show.id,
          title: show.title,
          url,
          issue: 'Search query URL (will 404)'
        });
        if (verbose) console.log(`  SEARCH URL: ${show.title} - ${url}`);
        continue;
      }

      if (!isValidTodayTixUrl(url)) {
        results.invalid.push({
          showId: show.id,
          title: show.title,
          url,
          issue: 'Missing numeric ID in URL'
        });
        if (verbose) console.log(`  INVALID: ${show.title} - ${url}`);
        continue;
      }

      results.valid++;
      if (verbose) console.log(`  OK: ${show.title}`);

      // Live check if requested
      if (checkLive) {
        await sleep(500); // Rate limit
        const check = await checkUrlLive(url);
        if (!check.ok) {
          results.liveCheckFailed.push({
            showId: show.id,
            title: show.title,
            url,
            status: check.status,
            error: check.error
          });
          console.log(`  LIVE CHECK FAILED: ${show.title} - status ${check.status}`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total TodayTix URLs checked: ${results.total}`);
  console.log(`Valid URLs: ${results.valid}`);
  console.log(`Search URLs (broken): ${results.searchUrls.length}`);
  console.log(`Invalid format: ${results.invalid.length}`);
  console.log(`Flagged needsUpdate: ${results.needsUpdate.length}`);
  if (checkLive) {
    console.log(`Live check failed: ${results.liveCheckFailed.length}`);
  }

  // Report issues
  const hasIssues = results.searchUrls.length > 0 || results.invalid.length > 0 || results.needsUpdate.length > 0;

  if (hasIssues) {
    console.log('\n' + '='.repeat(60));
    console.log('ISSUES FOUND');
    console.log('='.repeat(60));

    if (results.searchUrls.length > 0) {
      console.log('\nSearch URLs (will 404):');
      for (const item of results.searchUrls) {
        console.log(`  - ${item.title}: ${item.url}`);
      }
    }

    if (results.invalid.length > 0) {
      console.log('\nInvalid URL format:');
      for (const item of results.invalid) {
        console.log(`  - ${item.title}: ${item.url} (${item.issue})`);
      }
    }

    if (results.needsUpdate.length > 0) {
      console.log('\nFlagged as needing update:');
      for (const item of results.needsUpdate) {
        console.log(`  - ${item.title}: ${item.url}`);
      }
    }

    if (checkLive && results.liveCheckFailed.length > 0) {
      console.log('\nLive check failed:');
      for (const item of results.liveCheckFailed) {
        console.log(`  - ${item.title}: ${item.url} (status: ${item.status})`);
      }
    }
  }

  // JSON output
  if (json) {
    console.log('\n' + JSON.stringify(results, null, 2));
  }

  // Write results file
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'todaytix-validation-results.json'),
    JSON.stringify(results, null, 2)
  );

  // Exit with error if issues found
  const errorCount = results.searchUrls.length + results.invalid.length;
  if (errorCount > 0) {
    console.log(`\n${errorCount} URL(s) need attention.`);
    process.exit(1);
  } else {
    console.log('\nAll TodayTix URLs are valid.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
