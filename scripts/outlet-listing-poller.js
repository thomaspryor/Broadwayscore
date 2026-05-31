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
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  findExistingReviewFile,
} = require('./lib/review-normalization');
const {
  findMatchingShows,
  deriveQualifyingOutlets,
  mergeAlwaysOnOutlets,
  parseRssFeed,
  parseWpApiPosts,
  parseSitemapXml,
  extractListingUrls,
  buildSerpQuery,
} = require('./lib/outlet-listing-helpers');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
// Rejected-URL cache: when the shared writer's classifier rejects a URL as
// cross-market (or any other 'skipped' reason that isn't transient), we record
// the URL here so the next poll cycle doesn't re-discover and re-process it.
// Without this we burn time + log noise every cycle on the same dead URLs.
// FIFO-capped at REJECTED_URL_CACHE_MAX entries. Schema:
//   [{ url, showId, outletId, reason, rejectedAt }]
const REJECTED_URL_CACHE = path.join(__dirname, '..', 'data', 'audit', 'outlet-poller-rejected-urls.json');
const REJECTED_URL_CACHE_MAX = 1000;

// ---------------------------------------------------------------------------
// Outlet strategy overrides (all other qualifying outlets fall back to serp)
// ---------------------------------------------------------------------------

// Outlets with dedicated aggregator scrapers — skip entirely
const SKIP_OUTLETS = new Set(['broadwayworld', 'london-theatre', 'london-box-office']);

// Per-outlet fetch strategies. Each entry declares a strategy + required URL/config.
// Outlets not listed here fall back to SERP. All strategy fetches are wrapped in
// try/catch — on exception the poller falls back to SERP automatically (S3-T1).
//
// strategy: 'rss'          — fetch an RSS/Atom feed, optional urlFilter + titleFilter
// strategy: 'sitemap'      — fetch an annual XML sitemap, filter by urlFilter + <lastmod>
// strategy: 'listing-html' — fetch a known listing page via fetchPage() (BD→SB→Playwright)
//
// After adding new entries here, run a one-time historical backfill:
//   gh workflow run outlet-listing-poller.yml -f lookback_days=365
const OUTLET_STRATEGY_CONFIG = {
  // RSS strategies
  guardian:            { strategy: 'rss', url: 'https://www.theguardian.com/stage/rss' },
  'one-minute-critic': { strategy: 'rss', url: 'https://1minutecritic.com/feed' },
  // culturesauce: use .net canonical (registry domain); urlFilter guards against film/TV posts
  culturesauce:        { strategy: 'rss', url: 'https://culturesauce.net/feed', urlFilter: /\/[^/]*-review\b/ },
  // NYT Theater RSS is a 21-item rolling window; titleFilter drops features/news from the feed
  nytimes:             { strategy: 'rss', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Theater.xml', titleFilter: /\b(review|critic['’]?s\s+pick)\b/i },
  // TheaterMania: /rss.xml → 302 → sitemap.rss (site-wide feed, no reviews).
  // Listing page at /news/?categories=reviews is SSR; plain fetch returns review anchors.
  theatermania:        { strategy: 'listing-html', url: 'https://www.theatermania.com/news/?categories=reviews', urlFilter: /\/news\/review-/, usePlainFetch: true },
  // Variety theater-specific RSS — /v/theater/ path is review-only, no filter needed
  variety:             { strategy: 'rss', url: 'https://variety.com/v/theater/feed/' },
  // TheWrap theater tag RSS; urlFilter keeps only slugs ending in -review (drops news/obituaries)
  thewrap:             { strategy: 'rss', url: 'https://www.thewrap.com/tag/theater/feed/', urlFilter: /-review\/$/ },
  // TheReviewsHub: 100-item RSS covering all UK theater; no urlFilter needed — findMatchingShows guards FPs
  thereviewshub:       { strategy: 'rss', url: 'https://www.thereviewshub.com/feed/' },
  // Theater Scene: /plays/ and /musicals/ paths are reviews; /features/ /columns/ /multimedia/ are not
  'theater-scene':     { strategy: 'rss', url: 'https://www.theaterscene.net/feed/', urlFilter: /\/(plays|musicals)\// },
  // Theatre Weekly (UK): review URLs have /review- prefix; drops news/industry pieces
  'theatre-weekly':    { strategy: 'rss', url: 'https://theatreweekly.com/feed', urlFilter: /\/review-/ },
  // Pages on Stages: theater review blog; no URL discriminator, findMatchingShows guards noise
  'pages-on-stages':   { strategy: 'rss', url: 'https://pagesonstages.com/feed' },
  // Theater Life: covers shows + occasional ballet galas; findMatchingShows guards non-show content
  'theater-life':      { strategy: 'rss', url: 'https://theaterlife.com/feed' },
  // Front Row Center: covers theater + classical + cabaret; findMatchingShows guards non-theater content
  'front-row-center':  { strategy: 'rss', url: 'https://thefrontrowcenter.com/feed' },
  // NY Post theater-specific RSS; urlFilter keeps only slugs with "review" (drops news/awards coverage)
  nypost:              { strategy: 'rss', url: 'https://nypost.com/theater/feed/', urlFilter: /review/ },
  // Observer theater RSS; reviews use /review- or /theater-review- slug prefixes
  observer:            { strategy: 'rss', url: 'https://observer.com/theater/feed/', urlFilter: /\/(theater-review|review-)/ },
  // amNewYork theater category RSS; reviews use /review- slug prefix
  amny:                { strategy: 'rss', url: 'https://www.amny.com/category/entertainment/theater/feed/', urlFilter: /\/review-/ },
  // TheatreCat: UK theater review aggregator; pure review content, no filter needed
  theatrecat:          { strategy: 'rss', url: 'https://theatrecat.com/feed/' },
  // Theater Pizzazz: NYC/Broadway review site; pure theater content, no filter needed
  'theater-pizzazz':   { strategy: 'rss', url: 'https://theaterpizzazz.com/feed/' },
  // Front Mezz Junkies: NYC theater features + reviews; findMatchingShows guards non-review content
  frontmezzjunkies:    { strategy: 'rss', url: 'https://frontmezzjunkies.com/feed/' },

  // Sitemap strategy — Vulture's /rss/tag/theater.xml returns 404 since their CMS migration.
  // URL patterns for Vulture theater reviews:
  //   theater-review-*   (most reviews — explicit theater-review slug prefix)
  //   *-reviewed.*       (multi-show reviews: "The Receptionist and The Fever Reviewed")
  //   broadway*review*   (reviews with "broadway" in slug like "becky-shaw-broadway-play-review")
  vulture:             { strategy: 'sitemap', urlTemplate: year => `https://www.vulture.com/sitemaps/sitemap-${year}.xml`, urlFilter: /theater-review|-reviewed\.|broadway[^/]*review/i },

  // Listing-page HTML strategies (known-good review index URLs)
  // nytg: /reviews redirects to /reviews/broadway; plain fetch gets 12 review links per page.
  // urlFilter: keep only individual review slugs (they all end in -review, dropping category pages)
  nytg:              { strategy: 'listing-html', url: 'https://www.newyorktheatreguide.com/reviews/broadway', urlFilter: /\/reviews\/[^/]+-review/, usePlainFetch: true },
  // thestage: SSR listing page; 18 reviews per page, BD fetches directly
  // urlFilter keeps /reviews/<slug> paths; drops /review-round-ups/ multi-show roundup pages
  thestage:          { strategy: 'listing-html', url: 'https://www.thestage.co.uk/reviews', urlFilter: /\/reviews\/[^/]+/ },
  // timeout (NY): SSR reviews index page — 21 individual reviews confirmed via plain fetch;
  // usePlainFetch avoids BD/SB overhead; urlFilter keeps individual review slugs (*-review,
  // *-review-*) and drops the aggregate listing page itself (*-reviews plural).
  timeout:           { strategy: 'listing-html', url: 'https://www.timeout.com/newyork/theater/new-york-theater-and-broadway-reviews', urlFilter: /\/theater\/[^/]+-review(?!s)[^/]*$/, usePlainFetch: true },
  // timeout-london: SSR reviews index, BD fetches directly (~35 links)
  'timeout-london':  { strategy: 'listing-html', url: 'https://www.timeout.com/london/theatre/london-theatre-reviews' },
  // Evening Standard UK theatre reviews topic page — SSR, reviews-only (avoids news/features on /culture/theatre)
  standard:          { strategy: 'listing-html', url: 'https://www.standard.co.uk/topic/theatre-reviews', usePlainFetch: true },
  // WhatsOnStage: /news/?categories=reviews is a React SPA — plain fetch returns only the shell.
  // /news/feed/ is a WordPress RSS feed with reviews mixed in; urlFilter keeps -review_NNN slugs.
  whatsonstage:      { strategy: 'rss', url: 'https://www.whatsonstage.com/news/feed/', urlFilter: /-review_\d+/ },
  // ArtsDesk: SSR theatre listing; review URLs contain "-review-" in path after the show/venue slug
  artsdesk:          { strategy: 'listing-html', url: 'https://theartsdesk.com/theatre', urlFilter: /\/theatre\/[^/]+-review-/, usePlainFetch: true },
  // British Theatre Guide: /reviews/ serves an Atom feed to non-browser User-Agents — use RSS strategy
  'british-theatre': { strategy: 'rss', url: 'https://www.britishtheatreguide.info/reviews/' },

  // --- Additional outlets (previously on SERP-only) ---

  // Theatre Reviews Limited: Broadway/off-Broadway reviews; mix of reviews + news, findMatchingShows guards
  'theatre-reviews-limited': { strategy: 'rss', url: 'https://www.theatrereviews.com/feed/' },
  // The Recs: UK theatre review site; pure review content
  'the-recs':               { strategy: 'rss', url: 'https://therecs.co.uk/feed/' },
  // New York Classical Review: classical music + opera + some Broadway; show matching guards non-theater
  'new-york-classical-review': { strategy: 'rss', url: 'https://www.newyorkclassicalreview.com/feed/' },
  // Operawire: opera news + reviews; show matching keeps only matched Broadway/WE opera productions
  operawire:                { strategy: 'rss', url: 'https://operawire.com/feed/' },
  // Stage and Cinema: theater + film coverage; findMatchingShows guards film-only items
  stageandcinema:           { strategy: 'rss', url: 'https://www.stageandcinema.com/feed/' },
  // Slant Magazine: film + theater criticism; theater-specific feed for precision
  slantmagazine:            { strategy: 'rss', url: 'https://www.slantmagazine.com/theater/feed/' },
  // David Cote (Cote Notices) Substack: theater criticism newsletter; all content is theater
  'cote-notices':           { strategy: 'rss', url: 'https://davidcote1.substack.com/feed' },
  // City A.M.: London business paper; theatre category RSS has West End reviews
  'city-am':                { strategy: 'rss', url: 'https://www.cityam.com/category/theatre/feed/' },
  // LondonTheatre1: covered by WP_API_CONFIG (wp-json/wp/v2/posts?categories=14) — no entry needed here
};

// Outlets where we use WordPress REST API (separate — API approach, no URL scraping needed)
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
  // LondonTheatre1: WP REST API, category 14 = reviews
  londontheatre1: {
    apiBase: 'https://www.londontheatre1.com/wp-json/wp/v2/posts',
    params: 'categories=14&per_page=50&orderby=date&order=desc',
  },
  // Chicago Tribune: WP REST API, category 135 = Theater (confirmed 9000+ posts)
  chicagotribune: {
    apiBase: 'https://www.chicagotribune.com/wp-json/wp/v2/posts',
    params: 'categories=135&per_page=20&orderby=date&order=desc',
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
// Rejected-URL cache (cross-market / classifier rejects)
// ---------------------------------------------------------------------------

let _rejectedCache = null;       // Set<string>: "url|||showId" keys for fast lookup
let _rejectedCacheList = null;   // Array<{url,showId,outletId,reason,rejectedAt}>: ordered FIFO

function _loadRejectedCache() {
  if (_rejectedCache) return _rejectedCache;
  _rejectedCache = new Set();
  _rejectedCacheList = [];
  try {
    if (fs.existsSync(REJECTED_URL_CACHE)) {
      const raw = JSON.parse(fs.readFileSync(REJECTED_URL_CACHE, 'utf-8'));
      if (Array.isArray(raw)) {
        _rejectedCacheList = raw;
        for (const e of raw) {
          if (e && e.url && e.showId) _rejectedCache.add(`${e.url}|||${e.showId}`);
        }
      }
    }
  } catch (e) {
    console.warn(`  ⚠ Could not load rejected-URL cache (${e.message}); starting empty`);
    _rejectedCache = new Set();
    _rejectedCacheList = [];
  }
  return _rejectedCache;
}

function isRejectedCached(url, showId) {
  _loadRejectedCache();
  return _rejectedCache.has(`${url}|||${showId}`);
}

function recordRejection({ url, showId, outletId, reason }) {
  _loadRejectedCache();
  const key = `${url}|||${showId}`;
  if (_rejectedCache.has(key)) return;  // Already recorded
  _rejectedCache.add(key);
  _rejectedCacheList.push({
    url,
    showId,
    outletId,
    reason,
    rejectedAt: new Date().toISOString(),
  });
  // FIFO cap: drop oldest entries when over the limit.
  while (_rejectedCacheList.length > REJECTED_URL_CACHE_MAX) {
    const removed = _rejectedCacheList.shift();
    if (removed) _rejectedCache.delete(`${removed.url}|||${removed.showId}`);
  }
}

function flushRejectedCache() {
  if (!_rejectedCacheList) return;
  try {
    const dir = path.dirname(REJECTED_URL_CACHE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REJECTED_URL_CACHE, JSON.stringify(_rejectedCacheList, null, 2) + '\n');
  } catch (e) {
    console.warn(`  ⚠ Could not write rejected-URL cache: ${e.message}`);
  }
}

/**
 * Heuristic: is this 'skipped' reason worth caching? Transient failures
 * (e.g. domain-mismatch on URL that may later be corrected) shouldn't pin a
 * URL forever. Classifier rejections (cross-market) are durable — the URL
 * isn't going to magically become a different market on retry.
 */
function shouldCacheSkipReason(reason) {
  if (!reason) return false;
  return /cross-market|^domain-mismatch|junk-outlet|suspicious-outlet-id/.test(reason);
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
  // Route through the shared writer so the cross-market/same-title classifier
  // (classifyMarketRouting in market-routing.js) runs on every poller stub.
  // Without this the poller can file an article under the wrong production of
  // a same-titled revival (Codex flagged this in plan-review of bc88039868).
  const fields = {
    publishDate: publishDate || null,
  };
  if (isMultiShow) fields.isMultiShowReview = true;
  if (nytCriticsPick) fields.nytCriticsPick = true;

  const result = createOrMergeReviewFile(showId, {
    outletId,
    outlet: outletDisplayName,
    criticName: 'Unknown',
    url,
    source: 'outlet-listing-poller',
    publishDate: publishDate || null,
    fields,
  }, { dryRun });

  if (dryRun) {
    if (result.action === 'skipped') {
      console.log(`  [DRY RUN] Skipped ${showId}/${outletId}: ${result.reason}`);
    } else {
      console.log(`  [DRY RUN] Would ${result.action}: ${showId}/${outletId} (${url})`);
      if (isMultiShow) console.log(`            isMultiShowReview: true`);
    }
    return result;
  }

  if (result.action === 'skipped') {
    console.log(`  ⤼ Skipped ${showId}/${outletId}: ${result.reason}`);
  } else if (result.action === 'new') {
    console.log(`  ✓ Filed: ${showId}/${path.basename(result.filepath || '')}`);
  } else if (result.action === 'updated') {
    console.log(`  ↻ Merged: ${showId}/${path.basename(result.filepath || '')}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-outlet fetch strategies
// ---------------------------------------------------------------------------

async function fetchViaRss(outletId, config, cutoff) {
  const url = config.url;
  console.log(`  [rss] Fetching ${url}`);
  const xml = await fetchSimple(url);
  let items = parseRssFeed(xml, cutoff);
  if (config.urlFilter) items = items.filter(i => config.urlFilter.test(i.url));
  if (config.titleFilter) items = items.filter(i => config.titleFilter.test(i.headline));
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

async function fetchViaSitemap(outletId, config, cutoff) {
  const thisYear = new Date().getFullYear();
  // Try current year first; if no matching entries, check prior year (reviews near year boundary)
  for (const year of [thisYear, thisYear - 1]) {
    const url = config.urlTemplate(year);
    console.log(`  [sitemap] Fetching ${url}`);
    try {
      const xml = await fetchSimple(url, 30000);
      const items = parseSitemapXml(xml, cutoff, config.urlFilter);
      console.log(`  [sitemap] ${items.length} items in window (${year})`);
      if (items.length > 0) return items;
    } catch (err) {
      console.log(`  [sitemap] ${year} failed: ${err.message}`);
    }
  }
  return [];
}

async function fetchViaListingHtml(outletId, listingUrl, urlFilter, usePlainFetch) {
  console.log(`  [listing-html] Fetching ${listingUrl}`);
  let html;
  if (usePlainFetch) {
    // SSR pages accessible without JS rendering — skip BD/SB/Playwright overhead.
    // Let errors propagate — the try/catch in fetchOutlet handles them and
    // falls back to SERP. Swallowing here would prevent that fallback.
    html = await fetchSimple(listingUrl, 20000);
  } else {
    const result = await fetchPage(listingUrl, { timeout: 25000 });
    // fetchPage returns {content, format, source} or null on all-tiers failure
    html = result && typeof result === 'object' ? result.content : result;
  }
  if (!html || html.length < 500) {
    console.log(`  [listing-html] Empty or too-short response`);
    return [];
  }
  const domain = new URL(listingUrl).hostname.replace(/^www\./, '');
  let items = extractListingUrls(html, domain);
  if (urlFilter) items = items.filter(i => urlFilter.test(i.url));
  console.log(`  [listing-html] ${items.length} links extracted`);
  return items;
}

async function fetchViaSerp(outletId, domain, cutoff, opts) {
  // UK outlets (thestage, times-uk) use "theatre" spelling; US outlets use "theater"
  const query = buildSerpQuery(domain);
  const dateRange = { dateMin: cutoff, dateMax: new Date() };
  console.log(`  [serp] Query: "${query}" (last ${opts.lookbackDays}d)`);

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
    const derived = deriveQualifyingOutlets(allReviews, allShows, SKIP_OUTLETS, {
      minShowCount: opts.minShowCount,
      lookbackDays: 120,
    });
    // Always-on outlets: any outlet we bothered to configure a dedicated strategy
    // for (RSS/sitemap/listing-html or WP API) is high-value and must be polled
    // EVERY run, regardless of the ≥minShowCount volume gate. The gate is for
    // SERP-fallback outlets discovered dynamically from reviews.json; a configured
    // outlet below the threshold (e.g. The Recs, a star-authoritative blog with a
    // low show count) would otherwise be skipped and depend solely on per-show
    // SERP timing — which silently drops late/low-rank reviews. That gap missed
    // The Recs' 5-star The Lost Boys review (opened late in a busy week, 2026-04).
    const configured = [...Object.keys(OUTLET_STRATEGY_CONFIG), ...Object.keys(WP_API_CONFIG)];
    qualifyingOutlets = mergeAlwaysOnOutlets(derived, configured, SKIP_OUTLETS);
    const added = qualifyingOutlets.length - derived.length;
    console.log(`Qualifying outlets: ${qualifyingOutlets.length} (${derived.length} derived ≥${opts.minShowCount} shows/4mo + ${added} always-on configured)`);
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

    if (WP_API_CONFIG[outletId]) {
      // WordPress REST API — try directly, no SERP fallback (API errors are informative)
      try {
        articles = await fetchViaWpApi(outletId, WP_API_CONFIG[outletId], cutoff);
      } catch (err) {
        console.warn(`  ⚠ WP API failed for ${outletId}: ${err.message}`);
        outletsFailed++;
        continue;
      }

    } else {
      const sc = OUTLET_STRATEGY_CONFIG[outletId];

      if (sc) {
        // Try the outlet-specific strategy; fall back to SERP on any thrown error
        try {
          switch (sc.strategy) {
            case 'rss':          articles = await fetchViaRss(outletId, sc, cutoff); break;
            case 'sitemap':      articles = await fetchViaSitemap(outletId, sc, cutoff); break;
            case 'listing-html': articles = await fetchViaListingHtml(outletId, sc.url, sc.urlFilter, sc.usePlainFetch); break;
            default: console.warn(`  Unknown strategy "${sc.strategy}" for ${outletId}`);
          }
        } catch (err) {
          console.warn(`  ⚠ ${sc.strategy} failed (${err.message}); falling back to SERP`);
          if (!domain) { outletsFailed++; continue; }
          try {
            articles = await fetchViaSerp(outletId, domain, cutoff, opts);
          } catch (serpErr) {
            console.warn(`  ⚠ SERP fallback also failed: ${serpErr.message}`);
            outletsFailed++;
            continue;
          }
        }

      } else {
        // No outlet-specific strategy — SERP only (covers paywalled and uncharted outlets)
        if (!domain) { console.log(`  Skipping — no domain in registry`); continue; }
        try {
          articles = await fetchViaSerp(outletId, domain, cutoff, opts);
        } catch (err) {
          console.warn(`  ⚠ SERP failed for ${outletId}: ${err.message}`);
          outletsFailed++;
          continue;
        }
      }
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

    for (const { url, headline, publishDate } of articles) {
      const urlSlug = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      const matchedShows = findMatchingShows(headline, urlSlug, activeShows);

      if (matchedShows.length === 0) continue;

      const isMultiShow = matchedShows.length > 1;
      const nytCriticsPick = outletId === 'nytimes' && detectNytCriticsPick('', url);

      if (isMultiShow) {
        console.log(`  Cross-show article: "${(headline || url).slice(0, 80)}" → ${matchedShows.map(s => s.id).join(', ')}`);
      }

      for (const show of matchedShows) {
        if (alreadyFiled(show.id, outletId, url)) continue;
        // Skip URLs the classifier durably rejected on a prior cycle. The
        // writer would just reject them again and we'd burn classifier work.
        if (isRejectedCached(url, show.id)) continue;

        const result = createStub(show.id, outletId, displayName, url, headline, publishDate, isMultiShow, nytCriticsPick, opts.dryRun);
        // Only count NEW writes — the shared writer may also reject (cross-market
        // classifier), reroute, or merge into an existing file. None of those
        // are "new stubs" for the workflow output.
        if (result && result.action === 'new') {
          if (!opts.dryRun) outletNewStubs++;
          totalNewStubs++;
        } else if (result && result.action === 'skipped' && !opts.dryRun
            && shouldCacheSkipReason(result.reason)) {
          // Record durable rejections (cross-market classifier, junk outlet,
          // domain mismatch) so the next poll cycle doesn't re-process them.
          recordRejection({ url, showId: show.id, outletId, reason: result.reason });
        }
      }
    }

    if (outletNewStubs > 0) console.log(`  → ${outletNewStubs} new stubs created`);
  }

  // --- Summary ---
  console.log(`\n=== Done ===`);
  console.log(`New stubs: ${totalNewStubs}`);
  if (outletsFailed > 0) console.warn(`Outlets with errors: ${outletsFailed}`);

  // Persist rejected-URL cache (cross-market classifier rejects, etc.) so the
  // next poll cycle skips them upfront. Skip in dry-run since recordRejection
  // is already gated above.
  if (!opts.dryRun) flushRejectedCache();

  // Signal to GitHub Actions workflow
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_stubs=${totalNewStubs}\n`);
  }

  if (totalNewStubs > 0 && !opts.dryRun) {
    console.log('\nTip: run node scripts/rebuild-all-reviews.js to incorporate new stubs');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
