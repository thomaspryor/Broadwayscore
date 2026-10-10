#!/usr/bin/env node

/**
 * Refresh NYT Critic's Picks from the authoritative spotlight page.
 *
 * Source: https://www.nytimes.com/spotlight/theater-critics-picks
 * Scrapes all pages (10 per page, ~10 pages) and saves the review URLs
 * to data/nyt-critics-picks.json. The homepage shelf cross-references
 * these URLs against our reviews to find matching shows.
 *
 * Fetch order per page: plain HTTPS first (free), then the shared
 * fetchPage() chain (Bright Data → ScrapingBee → Playwright …) when NYT
 * blocks the runner. Since 2026-09-16 NYT answers GitHub runners with 403,
 * and the old plain-only fetcher silently wrote an empty list, wiping every
 * Critic's Pick badge on the site (The Holes, 2026-09-23, was the report).
 *
 * Accumulating list: the spotlight page only shows the latest ~100 picks,
 * but a Critic's Pick is permanent. Each run UNIONS the scrape into the
 * URLs already on file, so a pick that scrolls off the window keeps its
 * badge. (Replacing the list had already dropped 12 picks, e.g. Stereophonic
 * and Hell's Kitchen, before the 403 outage.)
 *
 * Write guard: the file is only rewritten when the scrape looks sane
 * (see evaluateScrape). Otherwise the script exits 1 and leaves the
 * existing list alone so the workflow's failure alert fires.
 *
 * Usage:
 *   node scripts/refresh-nyt-critics-picks.js [--dry-run] [--max-pages=N]
 *
 * --max-pages=1 checks only the newest ~10 picks. The opening-night poller
 * uses it so a pick published on opening night gets its badge in the same
 * run (scripts/lib/nyt-pick-refresh-needed.js decides when).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const OUTPUT_PATH = path.join(__dirname, '../data/nyt-critics-picks.json');
const BASE_URL = 'https://www.nytimes.com/spotlight/theater-critics-picks';
const MAX_PAGES = 15; // Safety cap
const DELAY_MS = 1500;
// NYT publishes a few picks a week. A run that finds more new URLs than this
// scraped something other than the spotlight list; since the list only grows,
// a bad merge would badge non-picks permanently, so refuse it instead.
const MAX_NEW_PER_RUN = 25;
// Text only the spotlight page carries. A proxy that followed a redirect to
// the theater section or homepage returns /theater/ links without it.
const SPOTLIGHT_MARKERS = [/theater-critics-picks/i, /Critic[’'‘]s Picks?/i];

function fetchPlain(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

let _scraper = null;
async function fetchSpotlightPage(url) {
  try {
    const html = await fetchPlain(url);
    if (looksLikeSpotlightPage(html)) return html;
    console.log('    Plain fetch did not return the spotlight page, escalating to fetchPage()');
  } catch (err) {
    console.log(`    Plain fetch failed (${err.message}), escalating to fetchPage()`);
  }
  if (!_scraper) _scraper = require('./lib/scraper');
  const result = await _scraper.fetchPage(url, { skipVerify: true });
  const content = (result && result.content) || '';
  if (!looksLikeSpotlightPage(content)) {
    throw new Error('fetched page is not the Critic\'s Picks spotlight (marker missing)');
  }
  return content;
}

/** True when the content is the spotlight list itself, not some other NYT page. */
function looksLikeSpotlightPage(content) {
  const text = String(content || '');
  return extractReviewUrls(text).length > 0 && SPOTLIGHT_MARKERS.some(re => re.test(text));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pull NYT theater review URLs out of a spotlight page. Works on raw HTML
 * (relative or absolute hrefs) and on markdown returned by proxy fetchers.
 */
function extractReviewUrls(content) {
  const matches = String(content || '').match(/\/\d{4}\/\d{2}\/\d{2}\/theater\/[A-Za-z0-9\-_/]+\.html/g) || [];
  return [...new Set(matches)].map(p => `https://www.nytimes.com${p}`);
}

/**
 * Decide whether a scrape may be merged into the file on disk. The merge only
 * adds, so a short (partial) scrape is harmless; what must be refused is an
 * empty/failed scrape (alert) and an implausible burst of new URLs (wrong
 * page). Pure so it can be unit-tested.
 */
function evaluateScrape({ urls, existingUrls = [], firstPageError }) {
  if (firstPageError) return { ok: false, reason: `page 1 failed: ${firstPageError}` };
  if (urls.length === 0) return { ok: false, reason: 'scrape found 0 URLs' };
  const existing = new Set(existingUrls);
  const newCount = urls.filter(u => !existing.has(u)).length;
  if (existing.size > 0 && newCount > MAX_NEW_PER_RUN) {
    return { ok: false, reason: `scrape would add ${newCount} new URLs (max ${MAX_NEW_PER_RUN} per run); likely not the picks list` };
  }
  return { ok: true };
}

/**
 * Union the scrape into the URLs already on file. Never removes a URL.
 * Pure so it can be unit-tested.
 */
function mergePicks(existingUrls, scrapedUrls) {
  const existing = new Set(existingUrls || []);
  const added = [...new Set(scrapedUrls)].filter(u => !existing.has(u)).sort();
  const urls = [...new Set([...existing, ...scrapedUrls])].sort();
  return { urls, added };
}

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function parseMaxPages(argv) {
  const raw = (argv.find(a => a.startsWith('--max-pages=')) || '').split('=')[1];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGES) : MAX_PAGES;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const maxPages = parseMaxPages(process.argv.slice(2));
  // Proxy fetches can be slow; stop paging before the workflow timeout. A
  // partial scrape still merges additively.
  const budget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
  console.log('Refreshing NYT Critic\'s Picks from spotlight page...');
  const allUrls = new Set();
  let prevSize = 0;
  let firstPageError = null;

  for (let page = 1; page <= maxPages; page++) {
    if (budget.exceeded()) {
      console.log(`  Time budget reached before page ${page}; stopping.`);
      break;
    }
    const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    console.log(`  Page ${page}: ${url}`);

    try {
      const html = await fetchSpotlightPage(url);
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
      if (page === 1) firstPageError = err.message;
      break;
    }

    if (page < maxPages) await sleep(DELAY_MS);
  }

  if (_scraper && typeof _scraper.cleanup === 'function') {
    try { await _scraper.cleanup(); } catch { /* best effort */ }
  }

  const scraped = [...allUrls].sort();
  console.log(`\nScraped unique URLs: ${scraped.length}`);

  const prev = readExisting();
  const existingUrls = (prev && Array.isArray(prev.urls)) ? prev.urls : [];
  const verdict = evaluateScrape({ urls: scraped, existingUrls, firstPageError });
  if (!verdict.ok) {
    console.error(`REFUSING to update ${OUTPUT_PATH}: ${verdict.reason}. Keeping the ${existingUrls.length} URLs on file.`);
    process.exit(1);
  }

  const { urls, added } = mergePicks(existingUrls, scraped);
  console.log(`New picks: ${added.length}`);
  added.forEach(u => console.log('  + ' + u));

  if (dryRun) {
    console.log(`[DRY RUN] Would write ${urls.length} URLs to`, OUTPUT_PATH);
    return;
  }

  const data = {
    _meta: {
      ...((prev && prev._meta) || {}),
      lastUpdated: new Date().toISOString(),
      source: BASE_URL,
      count: urls.length,
      lastScrapeCount: scraped.length,
    },
    urls,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${urls.length} URLs (${added.length} new) to ${OUTPUT_PATH}`);
}

module.exports = { extractReviewUrls, looksLikeSpotlightPage, evaluateScrape, mergePicks, parseMaxPages, MAX_NEW_PER_RUN, MAX_PAGES };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
