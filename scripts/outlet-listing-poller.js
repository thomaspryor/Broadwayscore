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
 *   - Four outlets are skipped (have dedicated scrapers/pollers):
 *       broadwayworld, london-theatre, london-box-office, loureviews
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
  isFlaggedMergeTarget,
} = require('./lib/review-normalization');
const { normalizeUrl } = require('./lib/url-utils');
const { describeSkip } = require('./lib/ingest-skip-classify');
const {
  findMatchingShows,
  deriveQualifyingOutlets,
  mergeAlwaysOnOutlets,
  parseRssFeed,
  looksLikeFeed,
  looksLikeSitemap,
  parseWpApiPosts,
  parseSitemapXml,
  extractListingUrls,
  buildSerpQuery,
  OUTLET_FEED_HEALTH_REL,
  FEED_STALE_DAYS,
  OUTLET_ALIVE_DAYS,
  newestItemDate,
  oldestItemDate,
  latestReviewDateByOutlet,
  isFeedStale,
} = require('./lib/outlet-listing-helpers');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const FEED_HEALTH_PATH = path.join(__dirname, '..', OUTLET_FEED_HEALTH_REL);
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
// loureviews: owned by poll-loureviews.yml (full-text WP ingest + its own tested
// matcher, scripts/lib/loureviews-match.js) — polling it here too made two
// writers for one outlet (BRO-4185 plan review).
const SKIP_OUTLETS = new Set(['broadwayworld', 'london-theatre', 'london-box-office', 'loureviews']);

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
  // TheWrap theater section RSS (the old /tag/theater/feed/ froze in June 2026, BRO-6340).
  // urlFilter keeps "-review/" and "-broadway-review-<names>/" slugs, drops news, ticket and roundup pieces.
  thewrap:             { strategy: 'rss', url: 'https://www.thewrap.com/creative-content/theater/feed/', urlFilter: /-review(?:\/|-(?!roundup|bomb))/ },
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
  // Observer: observer.com/theater/feed/ stopped in June 2026 and the outlet's reviews now
  // come from observer.co.uk, which has no feed; its sitemap carries every theatre article
  // with a lastmod (BRO-6340). Year-independent URL, so fetchViaSitemap fetches it once.
  observer:            { strategy: 'sitemap', urlTemplate: () => 'https://observer.co.uk/sitemap.xml', urlFilter: /\/culture\/theatre\/article\// },
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

  // --- Feed-first batch (BRO-4185, 2026-09-27) ---
  // Found by scripts/probe-outlet-feeds.js and checked by hand. These were
  // SERP-only: "site:domain theater review" returned 0 for 31/69 SERP outlets
  // on 2026-09-26 while these feeds held the reviews (Off Off Online → The
  // Holes, First Night → Table 17, TWI-NY → Delirium, London Unattached →
  // Catarina). Re-run the probe to find more; leave general-news feeds
  // (thejc, lightingandsoundamerica) and forums (theatreboard) on SERP.
  'off-off-online':          { strategy: 'rss', url: 'https://offoffonline.com/offoffonline?format=rss' },
  'this-week-in-new-york':   { strategy: 'rss', url: 'https://twi-ny.com/feed/' },
  'la-voce-di-new-york':     { strategy: 'rss', url: 'https://lavocedinewyork.com/feed/' },
  'the-interested-bystander': { strategy: 'rss', url: 'https://www.interestedbystander.com/feeds/posts/default' },
  'firstnightmagazine':      { strategy: 'rss', url: 'https://firstnightmagazine.com/feed/' },
  'london-unattached':       { strategy: 'rss', url: 'https://www.london-unattached.com/feed/' },
  // Squarespace: /news is the review collection (the probe's first hit was /shop)
  'west-end-best-friend':    { strategy: 'rss', url: 'https://www.westendbestfriend.co.uk/news?format=rss', urlFilter: /review/i },
  'all-that-dazzles-uk':     { strategy: 'rss', url: 'https://www.allthatdazzles.co.uk/blog-feed.xml' },
  'plays-international':     { strategy: 'rss', url: 'https://playsinternational.org.uk/feed/' },
  theupcoming:               { strategy: 'rss', url: 'https://www.theupcoming.co.uk/feed/' },
  'the-spy-in-the-stalls':   { strategy: 'rss', url: 'https://thespyinthestalls.com/feed/' },
  liamodell:                 { strategy: 'rss', url: 'https://liamodell.com/feed/' },
  readaboutstuff:            { strategy: 'rss', url: 'https://readaboutstuff.com/feed/' },
  // Afridiziak mixes offers/interviews/news; reviews live under /reviews/
  'afridiziak-theatre-news': { strategy: 'rss', url: 'https://www.afridiziak.com/feed/', urlFilter: /\/reviews\// },
  'musical-theatre-review':  { strategy: 'rss', url: 'https://musicaltheatrereview.com/feed/' },
  'plays-to-see':            { strategy: 'rss', url: 'https://playstosee.com/feed/' },
  'a-youngish-perspective':  { strategy: 'rss', url: 'https://ayoungishperspective.co.uk/feed/' },
  monstagigz:                { strategy: 'rss', url: 'https://monstagigz.com/feed/' },
  'north-west-end':          { strategy: 'rss', url: 'https://northwestend.com/feed/' },
  // South London Press: local news site; theatre reviews carry "review" in the slug
  'south-london':            { strategy: 'rss', url: 'https://southlondon.co.uk/feed/', urlFilter: /review/i },
  'theatre-vibe':            { strategy: 'rss', url: 'https://theatrevibe.co.uk/feed/' },
  'west-end-wilma':          { strategy: 'rss', url: 'https://westendwilma.com/feed/' },
  pinkprincetheatre:         { strategy: 'rss', url: 'https://www.pinkprincetheatre.com/blog-feed.xml' },
  viewfromthegods:           { strategy: 'rss', url: 'https://viewfromthegods.co.uk/feed/' },
  fairypoweredproductions:   { strategy: 'rss', url: 'https://fairypoweredproductions.com/feed/' },
  adventuresintheatreland:   { strategy: 'rss', url: 'https://www.adventuresintheatreland.com/blog-feed.xml' },
  unmissabletheatre:         { strategy: 'rss', url: 'https://unmissabletheatre.co.uk/reviews?format=rss' },
  theartsdispatch:           { strategy: 'rss', url: 'https://theartsdispatch.substack.com/feed' },
  jackstage:                 { strategy: 'rss', url: 'https://www.jackstage.co.uk/blog-feed.xml' },
  rolandcat:                 { strategy: 'rss', url: 'https://rolandcat.substack.com/feed' },
  revstanstheatreblog:       { strategy: 'rss', url: 'https://revstanstheatreblog.co.uk/feed/' },
  matineemouse:              { strategy: 'rss', url: 'https://matineemouse.substack.com/feed' },
  'rhombus-rota':            { strategy: 'rss', url: 'https://rhombusrota.co.uk/feed/' },
  'harry-theatre-life':      { strategy: 'rss', url: 'https://www.harrytheatrelife.co.uk/blog-feed.xml' },
  onin:                      { strategy: 'rss', url: 'https://onin.london/feed/' },
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

function fetchSimple(url, timeoutMs = 15000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': 'BroadwayScorecard/1.0 (+https://broadwayscorecard.com)', Accept: 'application/rss+xml, application/atom+xml, application/json, text/html' } },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          // Location may be relative (e.g. Squarespace "/offoffonline?format=rss").
          const next = new URL(res.headers.location, url).toString();
          return fetchSimple(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
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
  // credited-person-as-critic is durable in the same sense: the byline is a
  // credited member of this show's creative team, and retrying the same URL
  // cannot change that. Without it the poller re-attempts every cycle forever.
  return /cross-market|^domain-mismatch|junk-outlet|suspicious-outlet-id|credited-person-as-critic/.test(reason);
}

// ---------------------------------------------------------------------------
// Stub file creation
// ---------------------------------------------------------------------------

function buildStubPath(showId, outletId) {
  return path.join(REVIEW_TEXTS_DIR, showId, generateReviewFilename(outletId, 'unknown'));
}

/**
 * After the writer refuses a write with 'flagged-filename-collision' (BRO-3182):
 * is the flagged file that blocked it for this SAME url? Classification only,
 * never a skip. Same-url refusals are usually an already-rejected URL
 * re-matched daily (26 on 2026-09-26), but some carry a FALSE flag (Table 17 /
 * First Night, BRO-4185), so they stay visible as a count; a false flag is
 * fixed at read time in review-guards, not by suppressing rediscovery here.
 */
function isSameUrlFlaggedTarget(showId, outletId, url, reviewTextsDir = REVIEW_TEXTS_DIR) {
  const filepath = path.join(reviewTextsDir, showId, generateReviewFilename(outletId, 'unknown'));
  let data;
  try { data = JSON.parse(fs.readFileSync(filepath, 'utf-8')); } catch { return false; }
  return isFlaggedMergeTarget(data) && !!data.url && normalizeUrl(data.url) === normalizeUrl(url);
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

/**
 * Fetch a feed or sitemap directly; if the outlet blocks the CI runner (Substack,
 * Slant, Front Row Center 403'd for 30+ days; Observer's sitemap 403s, BRO-6340),
 * retry once through the shared provider chain. The proxied body is accepted only
 * when `isExpected` recognises its XML root, so a block page still throws and the
 * caller falls back to SERP instead of reading "no new reviews".
 */
async function fetchXmlWithProxyRetry(url, label, isExpected, { proxyRetry = true, timeoutMs, health } = {}) {
  try {
    const body = await fetchSimple(url, timeoutMs);
    // A 200 challenge/block page (slantmagazine's Cloudflare "Just a moment...",
    // BRO-6352) parsed to 0 items and read as "no new reviews". Treat it like a
    // failed fetch: proxy retry, then the caller's SERP fallback.
    if (!isExpected(body)) throw new Error(`direct fetch returned a non-${label} page`);
    return body;
  } catch (err) {
    if (!proxyRetry) throw err;
    if (health) health.directBlocked = true;
    console.log(`  [${label}] direct fetch failed (${err.message}); retrying via fetchPage`);
    const result = await fetchPage(url, { renderJs: false });
    if (!isExpected(result && result.content)) {
      throw new Error(`fetchPage returned an unexpected page for ${url}`);
    }
    console.log(`  [${label}] via fetchPage (${result.source || 'unknown'})`);
    return result.content;
  }
}

// Keep only the items an outlet's config accepts (shared by the in-window list
// and the cutoff-free health read, so both apply the same filters).
function applyRssFilters(items, config) {
  let out = items;
  if (config.urlFilter) out = out.filter(i => config.urlFilter.test(i.url));
  if (config.titleFilter) out = out.filter(i => config.titleFilter.test(i.headline));
  return out;
}

// `health` (optional, BRO-6352): filled with the feed's newest item date
// ignoring the lookback cutoff, so a frozen feed is visible, not "no reviews".
async function fetchViaRss(outletId, config, cutoff, { proxyRetry = true, health } = {}) {
  const url = config.url;
  if (health) health.url = url;
  console.log(`  [rss] Fetching ${url}`);
  const xml = await fetchXmlWithProxyRetry(url, 'rss', looksLikeFeed, { proxyRetry, health });
  const items = applyRssFilters(parseRssFeed(xml, cutoff), config);
  if (health) {
    const all = parseRssFeed(xml, new Date(0));
    const matching = applyRssFilters(all, config);
    health.newestAny = newestItemDate(all);
    health.oldestAny = oldestItemDate(all);
    health.newestFiltered = newestItemDate(matching);
    health.filteredCount = matching.length;
  }
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

async function fetchViaSitemap(outletId, config, cutoff, { proxyRetry = true, health } = {}) {
  const thisYear = new Date().getFullYear();
  // Try current year first; if no matching entries, check prior year (reviews near year boundary)
  const tried = new Set();
  for (const year of [thisYear, thisYear - 1]) {
    const url = config.urlTemplate(year);
    if (tried.has(url)) continue; // year-independent sitemap (observer): fetch once
    tried.add(url);
    console.log(`  [sitemap] Fetching ${url}`);
    if (health && !health.url) health.url = url;
    try {
      const xml = await fetchXmlWithProxyRetry(url, 'sitemap', looksLikeSitemap, { proxyRetry, timeoutMs: 30000, health });
      const items = parseSitemapXml(xml, cutoff, config.urlFilter);
      if (health) recordSitemapHealth(health, xml, config.urlFilter);
      console.log(`  [sitemap] ${items.length} items in window (${year})`);
      if (items.length > 0) return items;
    } catch (err) {
      console.log(`  [sitemap] ${year} failed: ${err.message}`);
    }
  }
  if (health && health.filteredCount === undefined) health.error = 'every sitemap fetch failed';
  return [];
}

// Merge one sitemap file's cutoff-free newest dates into `health` (the poller
// may read the current and the prior year's sitemap; the newest across both counts).
function recordSitemapHealth(health, xml, urlFilter) {
  const all = parseSitemapXml(xml, new Date(0), null);
  const matching = urlFilter ? parseSitemapXml(xml, new Date(0), urlFilter) : all;
  const maxDate = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));
  const minDate = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
  health.newestAny = maxDate(health.newestAny || null, newestItemDate(all));
  health.oldestAny = minDate(health.oldestAny || null, oldestItemDate(all));
  health.newestFiltered = maxDate(health.newestFiltered || null, newestItemDate(matching));
  health.filteredCount = (health.filteredCount || 0) + matching.length;
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
      const result = await fetchPage(listingUrl, { timeout: 20000 });
      // fetchPage returns {content, format, source}, never a bare string
      const html = result && typeof result === 'object' ? result.content : result;
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
  // Every source returned nothing. For SERP-only outlets that is NOT proof of
  // "no new reviews" (index lag, keyword mismatch) — listed in the summary so a
  // silent miss is visible; the fix is a feed entry (scripts/probe-outlet-feeds.js).
  const serpOnlyEmpty = [];
  const blockedCollisions = [];
  const sameUrlFlagged = [];
  // Per-outlet rss/sitemap feed health (BRO-6352), written to OUTLET_FEED_HEALTH_REL.
  const feedHealth = {};
  const feedHealthFor = (outletId, sc) => (feedHealth[outletId] = { strategy: sc.strategy, url: null, newestAny: null, oldestAny: null, newestFiltered: null, directBlocked: false });

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
            case 'rss':          articles = await fetchViaRss(outletId, sc, cutoff, { health: feedHealthFor(outletId, sc) }); break;
            case 'sitemap':      articles = await fetchViaSitemap(outletId, sc, cutoff, { health: feedHealthFor(outletId, sc) }); break;
            case 'listing-html': articles = await fetchViaListingHtml(outletId, sc.url, sc.urlFilter, sc.usePlainFetch); break;
            default: console.warn(`  Unknown strategy "${sc.strategy}" for ${outletId}`);
          }
        } catch (err) {
          if (feedHealth[outletId]) feedHealth[outletId].error = String(err.message || err).slice(0, 200);
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
      const serpOnly = !WP_API_CONFIG[outletId] && !OUTLET_STRATEGY_CONFIG[outletId];
      if (serpOnly) serpOnlyEmpty.push(outletId);
      console.log(serpOnly
        ? `  No articles found — SERP-only outlet, so this is unverified (add a feed entry: scripts/probe-outlet-feeds.js --outlets ${outletId})`
        : `  No articles found (normal if no new reviews this week)`);
      continue;
    }

    // Guard: warn if outlet normally active but returned suspiciously few results
    const MIN_EXPECTED_PER_WEEK = 2; // very conservative
    if (articles.length < MIN_EXPECTED_PER_WEEK) {
      console.warn(`  ⚠ Only ${articles.length} article(s) — scraper may have broken`);
    }

    // --- Match each article to shows ---
    let outletNewStubs = 0;

    for (const { url, headline, publishDate, description } of articles) {
      const urlSlug = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      const matchedShows = findMatchingShows(headline, urlSlug, activeShows, description, { publishDate });

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
        if (result && result.action === 'skipped' && result.reason === 'flagged-filename-collision') {
          if (isSameUrlFlaggedTarget(show.id, outletId, url)) sameUrlFlagged.push({ showId: show.id, outletId, url });
          else blockedCollisions.push({ showId: show.id, outletId, url });
        }
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
  if (serpOnlyEmpty.length > 0) {
    console.warn(`SERP-only outlets with 0 results (unverified, not proof of no reviews): ${serpOnlyEmpty.length} — ${serpOnlyEmpty.join(', ')}`);
  }
  if (sameUrlFlagged.length > 0) {
    // Not suppressed: a same-url refusal can be a FALSE flag (Table 17 / First
    // Night, BRO-4185). Listed so the count is visible run over run.
    console.log(`Re-matched URLs whose file is already flagged (same url, refused by writer): ${sameUrlFlagged.length}`);
    for (const b of sameUrlFlagged) console.log(`  · ${b.showId} / ${b.outletId}: ${b.url}`);
  }
  if (blockedCollisions.length > 0) {
    console.warn(`\n⛔ ${blockedCollisions.length} new URL(s) blocked by a flagged file with a DIFFERENT url — needs a human call:`);
    for (const b of blockedCollisions) {
      console.warn(`  • ${describeSkip(b.showId, b.url, { reason: 'flagged-filename-collision' })}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ⛔ blocked: \`${b.showId}\` / ${b.outletId}: ${b.url}\n`);
      }
    }
  }

  reportFeedHealth(feedHealth, allReviews, opts);

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

/**
 * Decide staleness per feed and write data/audit/outlet-feed-health.json
 * (BRO-6352). A --outlets run merges into the existing file instead of
 * replacing it, so a targeted re-poll does not drop the other ~70 feeds.
 */
function buildFeedHealthReport(feedHealth, allReviews, { now = Date.now(), previous = null, partial = false } = {}) {
  const latestByOutlet = latestReviewDateByOutlet(allReviews);
  const checkedAt = new Date(now).toISOString();
  const outlets = partial && previous && previous.outlets ? { ...previous.outlets } : {};
  for (const [outletId, h] of Object.entries(feedHealth)) {
    const latestReviewDate = latestByOutlet[outletId] || null;
    const stale = !h.error && isFeedStale({ newestFiltered: h.newestFiltered, filteredCount: h.filteredCount, newestAny: h.newestAny, oldestAny: h.oldestAny, latestReviewDate, now });
    const prev = previous && previous.outlets && previous.outlets[outletId];
    const failStreak = h.error ? ((prev && prev.failStreak) || 0) + 1 : 0;
    outlets[outletId] = { ...h, latestReviewDate, stale, failStreak, checkedAt };
  }
  const stale = Object.keys(outlets).filter(id => outlets[id].stale).sort();
  // Feeds that errored (SERP fallback took over) while the outlet is alive: the
  // same silent gap, so listed beside stale[] (alive = review within aliveDays).
  // FEED_FAIL_STREAK consecutive runs, so one flaky fetch does not warn.
  const aliveCutoff = new Date(now - OUTLET_ALIVE_DAYS * 86400000).toISOString().slice(0, 10);
  const failing = Object.keys(outlets).filter(id => outlets[id].error && outlets[id].failStreak >= FEED_FAIL_STREAK && outlets[id].latestReviewDate && outlets[id].latestReviewDate >= aliveCutoff).sort();
  return { generatedAt: checkedAt, staleDays: FEED_STALE_DAYS, aliveDays: OUTLET_ALIVE_DAYS, stale, failing, outlets };
}

const FEED_FAIL_STREAK = 3;

function reportFeedHealth(feedHealth, allReviews, opts) {
  if (Object.keys(feedHealth).length === 0) return;
  // Previous snapshot: carries failStreak, and is the merge base for --outlets runs.
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(FEED_HEALTH_PATH, 'utf-8')); } catch { previous = null; }
  const report = buildFeedHealthReport(feedHealth, allReviews, { previous, partial: !!opts.outlets });
  if (report.stale.length > 0) {
    console.warn(`\n⚠ Stale feeds (outlet still publishing, feed's newest matching item >${FEED_STALE_DAYS}d old or none): ${report.stale.length}`);
    for (const id of report.stale) {
      const o = report.outlets[id];
      const line = `${id}: feed newest ${o.newestFiltered || 'none'} (any item ${o.newestAny || 'none'}), latest review ${o.latestReviewDate} — ${o.url}`;
      console.warn(`  • ${line}`);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ⚠ stale feed: ${line}\n`);
    }
  }
  if (report.failing.length > 0) {
    console.warn(`\n⚠ Failing feeds (outlet still publishing, feed fetch failed ${FEED_FAIL_STREAK}+ runs running, SERP fallback used): ${report.failing.join(', ')}`);
  }
  if (opts.dryRun) return;
  fs.mkdirSync(path.dirname(FEED_HEALTH_PATH), { recursive: true });
  fs.writeFileSync(FEED_HEALTH_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`Feed health: ${Object.keys(report.outlets).length} feed(s) → ${OUTLET_FEED_HEALTH_REL}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}

// Exported for scripts/probe-outlet-feeds.js (lists SERP-only outlets) and tests.
module.exports = {
  SKIP_OUTLETS, OUTLET_STRATEGY_CONFIG, WP_API_CONFIG, isSameUrlFlaggedTarget,
  // feed fetchers, reused by scripts/outlet-feed-reconcile.js (BRO-5358)
  fetchViaRss, fetchViaWpApi, fetchViaSitemap, fetchViaListingHtml,
  buildFeedHealthReport,
};
