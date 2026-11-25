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
 * Review-page pass (BRO-8286): the spotlight page lags NYT's own review pages
 * (Seven Guitars carried "Critic's Pick" in its header while the list still
 * ended five days earlier). After the spotlight merge, recent NYT reviews we
 * hold that are not on the list are fetched and judged by the label above
 * their own headline (scripts/lib/nyt-review-page-pick.js). It runs even when
 * the spotlight fetch fails, on its own time budget (at least 3 min), so a
 * blocked spotlight page cannot starve it. Candidates come from
 * data/review-texts: the shows in $SHOWS (the opening-night poller sets it and
 * checks out review-texts). Without $SHOWS it scans every show, which only
 * works where review-texts is checked out; the weekly/daily job has no such
 * checkout, so there the pass lists nothing and the spotlight scrape alone
 * applies (it catches up within days). Negative results and failed fetches are
 * cached in the picks file's _meta.pageChecks: a review is fetched at most
 * twice for a verdict and at most 4 times if fetches fail. Add
 * --review-url=<url> (repeatable) to check specific URLs, e.g. to confirm one
 * by hand with --dry-run. --no-review-pages skips the pass.
 *
 * --max-pages=1 checks only the newest ~10 picks. The opening-night poller
 * uses it so a pick published on opening night gets its badge in the same
 * run (scripts/lib/nyt-pick-refresh-needed.js decides when).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { findUnpickedNytUrls, readShowReviews, canonicalPickUrl } = require('./lib/nyt-pick-refresh-needed');
const { listShowDirs } = require('./lib/list-show-dirs');
const {
  selectUrlsToCheck, classifyReviewPages, recordChecks,
} = require('./lib/nyt-review-page-pick');

const OUTPUT_PATH = path.join(__dirname, '../data/nyt-critics-picks.json');
const BASE_URL = 'https://www.nytimes.com/spotlight/theater-critics-picks';
const MAX_PAGES = 15; // Safety cap
const DELAY_MS = 1500;
// A review-page fetch is a fetchPage() chain (worst case ~2.5 min, run-budget.js).
const PAGE_PASS_MIN_BUDGET_MIN = 3;
const PAGE_FETCH_MIN_REMAINING_MS = 90 * 1000;
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

  const scraped = [...allUrls].sort();
  console.log(`\nScraped unique URLs: ${scraped.length}`);

  const prev = readExisting();
  const existingUrls = (prev && Array.isArray(prev.urls)) ? prev.urls : [];
  const verdict = evaluateScrape({ urls: scraped, existingUrls, firstPageError });
  let spotlightRefused = false;
  let urls = existingUrls;
  let added = [];
  let metaPatch = {};
  if (!verdict.ok) {
    // Keep the file as it is, but still run the review-page pass below: a
    // blocked spotlight page is exactly when the second source matters.
    console.error(`REFUSING to merge the spotlight scrape into ${OUTPUT_PATH}: ${verdict.reason}. Keeping the ${existingUrls.length} URLs on file.`);
    spotlightRefused = true;
  } else {
    ({ urls, added } = mergePicks(existingUrls, scraped));
    console.log(`New picks: ${added.length}`);
    added.forEach(u => console.log('  + ' + u));
    // lastUpdated is the spotlight's freshness (health-check.js warns at 72h),
    // so only a successful spotlight merge moves it.
    metaPatch = { source: BASE_URL, lastScrapeCount: scraped.length, lastUpdated: new Date().toISOString() };
  }

  let pageState = (prev && prev._meta && prev._meta.pageChecks) || {};
  if (!process.argv.includes('--no-review-pages')) {
    // Own budget: the poller gives the spotlight 2 min, and a blocked spotlight
    // page can spend all of it before this pass starts.
    const passBudget = createRunBudget(Math.max(PAGE_PASS_MIN_BUDGET_MIN, parseTimeBudgetMin(process.argv.slice(2))));
    const pass = await reviewPagePass({ urls, pageState, budget: passBudget, argv: process.argv.slice(2) });
    pageState = pass.pageState;
    if (pass.picks.length) {
      const merged = mergePicks(urls, pass.picks);
      urls = merged.urls;
      added = [...added, ...merged.added];
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would write ${urls.length} URLs (${added.length} new) to`, OUTPUT_PATH);
  } else if (spotlightRefused && added.length === 0 && JSON.stringify(pageState) === JSON.stringify((prev && prev._meta && prev._meta.pageChecks) || {})) {
    console.log('Nothing to write.');
  } else {
    const data = {
      _meta: {
        ...((prev && prev._meta) || {}),
        ...metaPatch,
        count: urls.length,
        pageChecks: pageState,
      },
      urls,
    };
    if (!Object.keys(pageState).length) delete data._meta.pageChecks;
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log(`Wrote ${urls.length} URLs (${added.length} new) to ${OUTPUT_PATH}`);
  }

  if (_scraper && typeof _scraper.cleanup === 'function') {
    try { await _scraper.cleanup(); } catch { /* best effort */ }
  }
  if (spotlightRefused) process.exit(1);
}

function parseReviewUrlArgs(argv) {
  return argv.filter(a => a.startsWith('--review-url=')).map(a => a.slice('--review-url='.length)).filter(Boolean);
}

/** Recent NYT reviews we hold (3-day window) that are not on the pick list. */
function findUnpickedCandidates(pickUrls, now = new Date()) {
  const root = path.join(__dirname, '..');
  const reviewTextsDir = path.join(root, 'data', 'review-texts');
  const fromEnv = (process.env.SHOWS || '').split(',').map(s => s.trim()).filter(Boolean);
  const showIds = fromEnv.length ? fromEnv : listShowDirs(reviewTextsDir, { silent: true });
  const shows = showIds.map(showId => ({ showId, reviews: readShowReviews(reviewTextsDir, showId, 'nytimes') }));
  return findUnpickedNytUrls({ shows, pickUrls, now });
}

async function fetchReviewPage(url) {
  if (!_scraper) _scraper = require('./lib/scraper');
  const result = await _scraper.fetchPage(url);
  const content = (result && (result.content || result.html)) || '';
  if (!content) throw new Error('empty response');
  return content;
}

/**
 * Judge recent unpicked NYT reviews by the label on the review page itself.
 * Returns { picks, pageState }; never throws (a failed fetch is logged and
 * retried on the next run).
 */
async function reviewPagePass({ urls, pageState, budget, argv, now = new Date(), getPage = fetchReviewPage, listCandidates = findUnpickedCandidates }) {
  const explicit = parseReviewUrlArgs(argv);
  let candidates = explicit;
  if (!explicit.length) {
    try {
      candidates = listCandidates(urls, now);
    } catch (err) {
      console.warn(`Review-page pass: could not list candidates (${err.message}); skipping.`);
      return { picks: [], pageState };
    }
  }
  const onFile = new Set(urls.map(canonicalPickUrl));
  // (--review-url bypasses the cache, so repeated manual checks always fetch.)
  const todo = selectUrlsToCheck({
    urls: candidates.filter(u => !onFile.has(canonicalPickUrl(u))),
    state: explicit.length ? {} : pageState,
    now,
  });
  if (!todo.length) {
    console.log(`Review-page pass: nothing to check (${candidates.length} unpicked candidate(s), rest cached or capped).`);
    return { picks: [], pageState };
  }
  console.log(`Review-page pass: checking ${todo.length} review page(s)`);
  const result = await classifyReviewPages({ urls: todo, getPage, shouldStop: () => !budget.canStartItem(PAGE_FETCH_MIN_REMAINING_MS) });
  result.picks.forEach(u => console.log('  + (review page label) ' + u));
  result.negatives.forEach(u => console.log('  - not a pick: ' + u));
  result.failures.forEach(f => console.warn(`  ! ${f.url}: ${f.reason}`));
  if (result.failures.length) console.warn(`::warning::NYT review-page pass could not read ${result.failures.length} page(s); retries back off and stop after a few tries`);
  return {
    picks: result.picks,
    pageState: explicit.length ? pageState : recordChecks(pageState, result, now),
  };
}

module.exports = { extractReviewUrls, looksLikeSpotlightPage, evaluateScrape, mergePicks, parseMaxPages, parseReviewUrlArgs, reviewPagePass, MAX_NEW_PER_RUN, MAX_PAGES };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
