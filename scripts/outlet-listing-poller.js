#!/usr/bin/env node
/**
 * Outlet Listing Poller
 *
 * Outlet-first daily sweep: for each qualifying outlet, fetch their recent
 * theater review listing (RSS feed, WordPress API, or SERP), then match each
 * article to ALL currently-open shows — filing a stub under every show that
 * matches, not just the first.
 *
 * This fixes the cross-show article gap: a WSJ piece covering both "New Born"
 * and "What Happened Was" gets filed under both shows, not just whichever one
 * the per-show SERP poller happened to be processing at the time.
 *
 * Outlet discovery:
 *   - Qualifying outlets are derived from reviews.json at runtime: any outlet
 *     that has reviewed ≥5 distinct shows opened in the last 4 months.
 *   - Three strategies (cheapest first):
 *       rss     — Free RSS/Atom feed (Guardian, Vulture)
 *       wp-api  — WordPress REST API (NYSR)
 *       serp    — SERP site: query (all others, including paywalled)
 *   - Three outlets are skipped (have dedicated aggregator scrapers):
 *       broadwayworld, london-theatre, london-box-office
 *
 * Usage:
 *   node scripts/outlet-listing-poller.js [options]
 *
 * Options:
 *   --dry-run               Log discoveries without writing files
 *   --lookback-days N       Days back to check (default 7)
 *   --outlets id1,id2,...   Only run for specific outlet IDs
 *   --market broadway|west-end|off-broadway  Filter active shows to one market
 *   --min-show-count N      Min shows reviewed in last 4 months (default 5)
 *
 * Outputs NEW_STUBS=N to $GITHUB_OUTPUT if running in GitHub Actions.
 *
 * Environment:
 *   SCRAPINGBEE_API_KEY   — Required for SERP queries
 *   BRIGHTDATA_TOKEN      — Fallback for SERP queries
 *   BRIGHTDATA_ZONE       — Bright Data zone name
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { safeWriteReview } = require('./lib/review-write-guard');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  findExistingReviewFile,
} = require('./lib/review-normalization');
const {
  findMatchingShows,
  deriveQualifyingOutlets,
  parseRssFeed,
  parseWpApiPosts,
  extractListingUrls,
} = require('./lib/outlet-listing-helpers');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// ---------------------------------------------------------------------------
// Outlet strategy overrides (all other qualifying outlets fall back to serp)
// ---------------------------------------------------------------------------

// Outlets with dedicated aggregator scrapers — skip entirely
const SKIP_OUTLETS = new Set(['broadwayworld', 'london-theatre', 'london-box-office']);

// Outlets where we use RSS instead of SERP
const RSS_CONFIG = {
  guardian: 'https://www.theguardian.com/stage/rss',
  vulture: 'https://www.vulture.com/rss/tag/theater.xml',
};

// Outlets where we use WordPress REST API
const WP_API_CONFIG = {
  nysr: {
    apiBase: 'https://nystagereview.com/wp-json/wp/v2/posts',
    // No category filter — NYSR only posts theater reviews
    params: 'per_page=50&orderby=date&order=desc',
  },
  'nyt-theater': {
    apiBase: 'https://newyorktheater.me/wp-json/wp/v2/posts',
    params: 'per_page=50&orderby=date&order=desc',
  },
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    lookbackDays: 7,
    outlets: null,
    market: null,
    minShowCount: 5,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--lookback-days': opts.lookbackDays = parseInt(args[++i], 10); break;
      case '--outlets': opts.outlets = args[++i].split(',').map(s => s.trim()); break;
      case '--market': opts.market = args[++i]; break;
      case '--min-show-count': opts.minShowCount = parseInt(args[++i], 10); break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// HTTP helpers (simple, no BD/SB — used for RSS and WP API)
// ---------------------------------------------------------------------------

function fetchSimple(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': 'BroadwayScorecard/1.0 (+https://broadwayscorecard.com)', Accept: 'application/rss+xml, application/atom+xml, application/json, text/html' } },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchSimple(res.headers.location, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Stub file creation
// ---------------------------------------------------------------------------

function buildStubPath(showId, outletId) {
  return path.join(REVIEW_TEXTS_DIR, showId, generateReviewFilename(outletId, 'unknown'));
}

/**
 * Check idempotency: does a stub already exist for this outlet + URL in this show's dir?
 * Returns true if we should SKIP (already filed).
 * This check is per-show-dir — so the same URL can be filed under Show A and Show B independently.
 */
function alreadyFiled(showId, outletId, url) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const existing = findExistingReviewFile(showDir, outletId, 'unknown');
  if (!existing) return false;
  // If existing file has the same URL, skip
  const existingUrl = existing.data && existing.data.url;
  return existingUrl === url;
}

function createStub(showId, outletId, outletDisplayName, url, headline, publishDate, isMultiShow, nytCriticsPick, dryRun) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const filePath = buildStubPath(showId, outletId);

  if (dryRun) {
    console.log(`  [DRY RUN] Would write: ${showId}/${path.basename(filePath)}`);
    console.log(`            url: ${url}`);
    if (isMultiShow) console.log(`            isMultiShowReview: true`);
    return;
  }

  if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

  const stub = {
    showId,
    outletId,
    outlet: outletDisplayName,
    criticName: 'Unknown',
    url,
    source: 'outlet-listing-poller',
    sources: ['outlet-listing-poller'],
    publishDate: publishDate || null,
  };
  if (isMultiShow) stub.isMultiShowReview = true;
  if (nytCriticsPick) stub.nytCriticsPick = true;

  safeWriteReview(filePath, stub);
  console.log(`  ✓ Filed: ${showId}/${path.basename(filePath)}`);
}

// ---------------------------------------------------------------------------
// Per-outlet fetch strategies
// ---------------------------------------------------------------------------

async function fetchViaRss(outletId, rssUrl, cutoff) {
  console.log(`  [rss] Fetching ${rssUrl}`);
  const xml = await fetchSimple(rssUrl);
  const items = parseRssFeed(xml, cutoff);
  console.log(`  [rss] ${items.length} items in window`);
  return items;
}

async function fetchViaWpApi(outletId, config, cutoff) {
  const after = cutoff.toISOString();
  const url = `${config.apiBase}?${config.params}&after=${encodeURIComponent(after)}`;
  console.log(`  [wp-api] Fetching ${url}`);
  const json = await fetchSimple(url);
  const posts = JSON.parse(json);
  if (!Array.isArray(posts)) return [];
  const items = parseWpApiPosts(posts, cutoff);
  console.log(`  [wp-api] ${items.length} items in window`);
  return items;
}

async function fetchViaSerp(outletId, domain, cutoff, opts) {
  // site: query limited to 7-day window
  const query = `site:${domain} theater review`;
  const dateRange = { dateMin: cutoff, dateMax: new Date() };
  console.log(`  [serp] Querying: "${query}" (last ${opts.lookbackDays}d)`);

  const results = await serpQuery(query, {
    dateRange,
    nbResults: 10,
    log: msg => console.log(`    ${msg}`),
  });

  if (!results || results.length === 0) {
    console.log(`  [serp] 0 results`);
    return [];
  }

  const items = results.map(r => ({
    url: r.url || r.link || '',
    headline: r.title || '',
    publishDate: null, // SERP doesn't return dates reliably
  })).filter(r => r.url && r.url.startsWith('http'));

  console.log(`  [serp] ${items.length} results`);
  return items;
}

async function fetchViaHtml(outletId, domain, outletEntry, cutoff) {
  // Try common theater/stage section paths for the outlet
  const candidates = [
    outletEntry.theaterUrl,
    outletEntry.reviewsUrl,
    `https://${domain}/theater/`,
    `https://${domain}/stage/`,
    `https://${domain}/theater-reviews/`,
    `https://${domain}/reviews/`,
    `https://${domain}/broadway/`,
  ].filter(Boolean);

  for (const listingUrl of candidates) {
    try {
      console.log(`  [html] Fetching ${listingUrl}`);
      const html = await fetchPage(listingUrl, { timeout: 20000 });
      if (!html || html.length < 500) continue;

      const items = extractListingUrls(html, domain);
      if (items.length < 3) continue; // listing page didn't parse well

      console.log(`  [html] ${items.length} links extracted from ${listingUrl}`);
      return items;
    } catch (err) {
      console.log(`  [html] Failed: ${err.message}`);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// NYT Critics Pick detection
// ---------------------------------------------------------------------------

function detectNytCriticsPick(html, url) {
  if (!html) return false;
  // NYT marks critics picks with a "critic's pick" label/class in listing HTML
  return /critics['’\s-]*pick/i.test(html.slice(Math.max(0, html.indexOf(url) - 500), html.indexOf(url) + 500));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const cutoff = new Date(Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000);

  console.log(`\n=== Outlet Listing Poller ===`);
  console.log(`Lookback: ${opts.lookbackDays} days (since ${cutoff.toISOString().slice(0, 10)})`);
  if (opts.dryRun) console.log('DRY RUN mode — no files written');

  // --- Load data ---
  const { shows: allShows } = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  const { reviews: allReviews } = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf-8'));
  const { outlets: outletRegistry } = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

  // Active shows only (open or previews), optionally filtered by market
  let activeShows = allShows.filter(s => s.status === 'open' || s.status === 'previews');
  if (opts.market) activeShows = activeShows.filter(s => s.category === opts.market || s.market === opts.market);
  console.log(`Active shows: ${activeShows.length}${opts.market ? ` (${opts.market})` : ''}`);

  // --- Derive qualifying outlets ---
  let qualifyingOutlets;
  if (opts.outlets) {
    qualifyingOutlets = opts.outlets;
    console.log(`Targeting specific outlets: ${qualifyingOutlets.join(', ')}`);
  } else {
    qualifyingOutlets = deriveQualifyingOutlets(allReviews, allShows, SKIP_OUTLETS, {
      minShowCount: opts.minShowCount,
      lookbackDays: 120,
    });
    console.log(`Qualifying outlets (≥${opts.minShowCount} shows/4mo): ${qualifyingOutlets.length}`);
  }

  // --- Per-outlet sweep ---
  let totalNewStubs = 0;
  let outletsFailed = 0;

  for (const outletId of qualifyingOutlets) {
    const outletEntry = outletRegistry[outletId] || {};
    const domain = outletEntry.domain || outletEntry.url;
    const displayName = outletEntry.displayName || outletId;
    const accessModel = outletEntry.accessModel || 'free';
    const isPaid = accessModel === 'paywalled';

    console.log(`\n--- ${displayName} (${outletId}) ---`);

    let articles = [];

    try {
      if (RSS_CONFIG[outletId]) {
        articles = await fetchViaRss(outletId, RSS_CONFIG[outletId], cutoff);

      } else if (WP_API_CONFIG[outletId]) {
        articles = await fetchViaWpApi(outletId, WP_API_CONFIG[outletId], cutoff);

      } else if (isPaid || !domain) {
        // Paywalled or unknown domain — SERP is the only viable approach
        if (!domain) { console.log(`  Skipping — no domain in registry`); continue; }
        articles = await fetchViaSerp(outletId, domain, cutoff, opts);

      } else {
        // Free outlet: try SERP (reliable, no per-outlet HTML parsing complexity)
        // SERP gives us 10 relevant results vs. scraping an entire listing page
        articles = await fetchViaSerp(outletId, domain, cutoff, opts);
      }

    } catch (err) {
      console.warn(`  ⚠ Error fetching ${outletId}: ${err.message}`);
      outletsFailed++;
      continue;
    }

    if (articles.length === 0) {
      console.log(`  No articles found (normal if no new reviews this week)`);
      continue;
    }

    // Guard: warn if outlet normally active but returned suspiciously few results
    const MIN_EXPECTED_PER_WEEK = 2; // very conservative
    if (articles.length < MIN_EXPECTED_PER_WEEK) {
      console.warn(`  ⚠ Only ${articles.length} article(s) — scraper may have broken`);
    }

    // --- Match each article to shows ---
    let outletNewStubs = 0;

    // Capture listing HTML for NYT critics pick detection (if we fetched HTML)
    const listingHtmlForNyt = outletId === 'nytimes' ? null : null; // SERP doesn't give us HTML

    for (const { url, headline, publishDate } of articles) {
      const urlSlug = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      const matchedShows = findMatchingShows(headline, urlSlug, activeShows);

      if (matchedShows.length === 0) continue;

      const isMultiShow = matchedShows.length > 1;
      const nytCriticsPick = outletId === 'nytimes' && detectNytCriticsPick(listingHtmlForNyt || '', url);

      if (isMultiShow) {
        console.log(`  Cross-show article: "${headline.slice(0, 60)}" → ${matchedShows.map(s => s.id).join(', ')}`);
      }

      for (const show of matchedShows) {
        if (alreadyFiled(show.id, outletId, url)) continue;

        createStub(show.id, outletId, displayName, url, headline, publishDate, isMultiShow, nytCriticsPick, opts.dryRun);
        if (!opts.dryRun) outletNewStubs++;
        totalNewStubs++;
      }
    }

    if (outletNewStubs > 0) console.log(`  → ${outletNewStubs} new stubs created`);
  }

  // --- Summary ---
  console.log(`\n=== Done ===`);
  console.log(`New stubs: ${totalNewStubs}`);
  if (outletsFailed > 0) console.warn(`Outlets with errors: ${outletsFailed}`);

  // Signal to GitHub Actions workflow
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_stubs=${totalNewStubs}\n`);
  }

  if (totalNewStubs > 0 && !opts.dryRun) {
    console.log('\nTip: run node scripts/rebuild-all-reviews.js to incorporate new stubs');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
