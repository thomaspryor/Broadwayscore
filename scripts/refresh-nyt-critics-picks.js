#!/usr/bin/env node

/**
 * Refresh NYT Critic's Picks from the authoritative spotlight page.
 *
 * Source: https://www.nytimes.com/spotlight/theater-critics-picks
 * Scrapes all pages (10 per page, ~10 pages) and saves the review URLs
 * to data/nyt-critics-picks.json. The homepage shelf cross-references
 * these URLs against our reviews to find matching shows.
 *
 * Usage:
 *   node scripts/refresh-nyt-critics-picks.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_PATH = path.join(__dirname, '../data/nyt-critics-picks.json');
const BASE_URL = 'https://www.nytimes.com/spotlight/theater-critics-picks';
const MAX_PAGES = 15; // Safety cap
const DELAY_MS = 1500;

const dryRun = process.argv.includes('--dry-run');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractReviewUrls(html) {
  // Match theater review URLs in the spotlight page
  const matches = html.match(/\/\d{4}\/\d{2}\/\d{2}\/theater\/[^"]+/g) || [];
  return [...new Set(matches)].map(p => `https://www.nytimes.com${p}`);
}

async function main() {
  console.log('Refreshing NYT Critic\'s Picks from spotlight page...');
  const allUrls = new Set();
  let prevSize = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    console.log(`  Page ${page}: ${url}`);

    try {
      const html = await fetchPage(url);
      const urls = extractReviewUrls(html);

      for (const u of urls) allUrls.add(u);
      const newCount = allUrls.size - prevSize;
      console.log(`    Found ${urls.length} URLs (${newCount} new, ${allUrls.size} total)`);

      // Stop when no new URLs are found (past the last page)
      if (newCount === 0) {
        console.log('  No new URLs — reached end of pages.');
        break;
      }
      prevSize = allUrls.size;
    } catch (err) {
      console.error(`    Error on page ${page}: ${err.message}`);
      break;
    }

    if (page < MAX_PAGES) await sleep(DELAY_MS);
  }

  const urls = [...allUrls].sort();
  console.log(`\nTotal unique URLs: ${urls.length}`);

  if (dryRun) {
    console.log('[DRY RUN] Would write to', OUTPUT_PATH);
    urls.forEach(u => console.log('  ' + u));
    return;
  }

  const data = {
    _meta: {
      lastUpdated: new Date().toISOString(),
      source: BASE_URL,
      count: urls.length,
    },
    urls,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${urls.length} URLs to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
