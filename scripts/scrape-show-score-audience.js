#!/usr/bin/env node
/**
 * Scrape Show Score audience data and update audience-buzz.json
 *
 * Uses a fallback chain to fetch Show Score pages and extract audience scores:
 * 1. ScrapingBee (primary — render_js for SPA content, wait=3000 for hydration)
 * 2. Playwright (fallback — native JS rendering, no API credits needed)
 * 3. Bright Data Web Unlocker (last resort — may not render JS fully)
 *
 * Designed to run in GitHub Actions.
 *
 * Usage:
 *   node scripts/scrape-show-score-audience.js [--show=hamilton-2015] [--limit=10] [--dry-run]
 *
 * Environment variables:
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (primary, optional)
 *   BRIGHTDATA_TOKEN    - Bright Data API token (fallback, optional)
 *   At least one scraping method must be available (or Playwright installed).
 */

// BRO-6008: SB calls now go through fetchPage's per-run budget (default 250cr = ~50
// renders); these SB-primary scripts used to be unmetered, so raise the default.
process.env.SB_CREDIT_BUDGET = process.env.SB_CREDIT_BUDGET || '2000';
const { canDiscoverShowScoreUrl } = require('./lib/showscore-status-eligibility');
const { servesUkPageForUsShow, allowsUkShowScorePage, isUkPageForShow, pageRatingOf, storedRatingMatchesPage } = require('./lib/show-score-canonical');
const { removeSourceWithTombstone } = require('./lib/reconcile-audience-buzz');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { isSourceFresh } = require('./lib/audience-freshness');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { checkShowScorePage } = require('./lib/show-score-page-check');
const { checkPageProductionWindow } = require('./lib/show-score-production-window');
const { removeWrongProductionShowScore } = require('./lib/show-score-wrong-production');
const { isLondonMarket } = require('./lib/venue-classification');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');
const { fetchPage } = require('./lib/scraper');
const { findConflictingShowId, isShowScoreNotFoundPage, decideDeadUrlAction, isProductionMismatch, recordProductionMismatch } = require('./lib/show-score-url-map');
const { fetchWithBrightDataViaFetchPage } = require('./lib/audience-page-fetch');
const { gateScrapedSynopsis } = require('./lib/synopsis-fact-check');
const { setSynopsis } = require('./lib/synopsis-source');
const { extractShowScoreSynopsis } = require('./lib/show-score-synopsis');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `scrape-show-score-audience.js — Scrape Show Score audience data and update audience-buzz.json.

Usage:
  node scripts/scrape-show-score-audience.js [options]
  node scripts/scrape-show-score-audience.js --help, -h    print this usage and exit
`;
// Lazy-load Playwright — only imported if needed as fallback
let playwrightBrowser = null;
let playwrightUnavailable = false; // Cache permanent failures (missing binaries)
async function getPlaywrightBrowser() {
  if (playwrightUnavailable) return null;
  if (playwrightBrowser) return playwrightBrowser;
  try {
    const { chromium } = require('playwright');
    playwrightBrowser = await chromium.launch({ headless: true });
    return playwrightBrowser;
  } catch (e) {
    const msg = e.message || '';
    // Missing binaries = permanent failure, don't retry every call
    if (msg.includes("Executable doesn't exist") || msg.includes('MODULE_NOT_FOUND')) {
      console.error(`  Playwright permanently unavailable: ${msg.split('\n')[0]}`);
      playwrightUnavailable = true;
    } else {
      console.error(`  Playwright unavailable: ${msg}`);
    }
    return null;
  }
}
async function cleanupPlaywright() {
  if (playwrightBrowser) {
    await playwrightBrowser.close();
    playwrightBrowser = null;
  }
}

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
// --skip-fresh-hours=N (BRO-4215): with --shows=<ids>, drop shows whose Show
// Score record was written in the last N hours. The opening-night orchestrator
// re-dispatches the same shows ~7x/day (~11% of ScrapingBee credits 9/21-9/27).
const skipFreshArg = args.find(a => a.startsWith('--skip-fresh-hours='));
const skipFreshHours = skipFreshArg ? parseFloat(skipFreshArg.split('=')[1]) : 0;
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const includeAll = args.includes('--all');
const shardArg = args.find(a => a.startsWith('--shard='));
const totalShardsArg = args.find(a => a.startsWith('--total-shards='));
const shard = shardArg ? parseInt(shardArg.split('=')[1]) : null;
const totalShards = totalShardsArg ? parseInt(totalShardsArg.split('=')[1]) : null;
const shardMode = shard !== null && totalShards !== null;

// Config
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// Paths
const showsPath = path.join(__dirname, '../data/shows.json');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const showScorePath = path.join(__dirname, '../data/show-score.json');

// Load data
const showsData = loadShows();
const showMapById = {};
for (const s of showsData.shows) showMapById[s.id] = s;

// Build multi-production lookup: for each title base, find the most recent production
// that has actually started performances. ShowScore sometimes has separate pages per
// production (e.g. /sunset-boulevard = 2017, /sunset-boulevard-broadway = 2024).
// When only ONE page exists, only the newest production gets the data.
// Exclude shows whose previews haven't started — they can't have real audience data.
const today = new Date().toISOString().split('T')[0];
const mostRecentByTitle = {};
for (const s of showsData.shows) {
  const previewDate = s.previewsStartDate || s.openingDate;
  if (previewDate && previewDate > today) continue; // Skip future shows
  const titleBase = s.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const existing = mostRecentByTitle[titleBase];
  if (!existing || (s.openingDate || '') > (existing.openingDate || '')) {
    mostRecentByTitle[titleBase] = s;
  }
}

/**
 * Check if this show is the most recent production of its title.
 */
function isMostRecentProduction(show) {
  const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const newest = mostRecentByTitle[titleBase];
  return !newest || newest.id === show.id;
}

/**
 * Get the newest production's cached URL for this show's title.
 * Returns null if the show IS the newest or if the newest has no cached URL.
 */
function getNewestProductionUrl(show) {
  if (isMostRecentProduction(show)) return null;
  const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const newestShow = mostRecentByTitle[titleBase];
  return newestShow ? getCachedUrl(newestShow.id) : null;
}
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const audienceBuzz = loadAudienceBuzz();
const showScoreData = JSON.parse(fs.readFileSync(showScorePath, 'utf8'));

// Max new URL discoveries per run to avoid rate-limit avalanche
// In shard mode (bulk backfill), raise cap significantly
const MAX_DISCOVERIES = shardMode ? 100 : 10;
// BRO-4358: cap on dead-cached-URL rediscoveries per run (see rediscoverAfterDeadUrl).
let deadUrlRediscoveriesLeft = 3;
// Cooldown before retrying discovery for a show (7 days, disabled in shard mode)
const DISCOVERY_COOLDOWN_MS = shardMode ? 0 : 7 * 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch URL through ScrapingBee (single attempt), via fetchPage() restricted to
 * the scrapingbee tier (BRO-6008). Show Score is a React SPA, so the call needs
 * render_js + wait=3000 for scores to hydrate; fetchPage forwards `wait` to SB
 * and keeps the SB budget/credit guards + spend ledger in one place.
 * premium_proxy stays off (render_js=true, 5cr, is the cheapest tier with wait).
 * Returns HTML string, or null on no key / SB miss (a miss falls through to
 * Playwright, so there is no retry loop spending 5 credits per attempt).
 */
async function fetchViaScrapingBeeSingle(url) {
  if (!SCRAPINGBEE_KEY) return null; // No key — skip gracefully
  try {
    const r = await fetchPage(url, { tiers: ['scrapingbee'], renderJs: true, wait: 3000, skipVerify: true });
    return r && r.content ? r.content : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch URL through Playwright (renders JS natively).
 * Returns HTML string or null on failure.
 */
async function fetchViaPlaywright(url) {
  const browser = await getPlaywrightBrowser();
  if (!browser) return null;

  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      // Show Score is an SPA — wait a bit for content to render
      await page.waitForTimeout(3000);
      const html = await page.content();
      return html;
    } finally {
      await page.close();
    }
  } catch (error) {
    console.error(`  Playwright failed: ${error.message}`);
    // Reset browser if it's in a bad state so next call relaunches
    if (playwrightBrowser) {
      try { await playwrightBrowser.close(); } catch (_) {}
      playwrightBrowser = null;
    }
    return null;
  }
}

/**
 * Fetch URL through Bright Data Web Unlocker.
 * Returns HTML string or null on failure.
 * Note: Web Unlocker may not fully render JS-heavy SPAs like Show Score.
 */
async function fetchViaBrightData(url) {
  const r = await fetchWithBrightDataViaFetchPage(url);
  return r ? r.content : null;
}

/**
 * Fetch URL with fallback chain.
 * Chain: ScrapingBee (render_js + wait) → Playwright → Bright Data
 * Returns HTML string or throws if all methods fail.
 */
async function fetchWithFallback(url) {
  // ScrapingBee first (single attempt; fetchPage already rejects challenge/
  // garbage pages) — best for Show Score (render_js + wait for hydration). A
  // miss, including a 404, falls through to Playwright, which returns the 404
  // page for isShowScoreNotFoundPage (BRO-4358). No retry loop: each attempt
  // bills 5 credits and Playwright is free.
  if (SCRAPINGBEE_KEY) {
    const html = await fetchViaScrapingBeeSingle(url);
    if (html) return html;
    if (verbose) console.log('  ScrapingBee missed, falling through...');
  }

  // Playwright fallback — renders JS natively, no API credits
  if (verbose) console.log('  Falling back to Playwright...');
  const pwHtml = await fetchViaPlaywright(url);
  if (pwHtml) return pwHtml;

  // Bright Data last resort — may not render SPA content fully
  if (verbose) console.log('  Falling back to BrightData...');
  const bdHtml = await fetchViaBrightData(url);
  if (bdHtml) return bdHtml;

  throw new Error('All scraping methods failed for ' + url);
}

/**
 * Slugify a show title for Show Score URL patterns
 */
function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/&/g, '')           // Drop ampersand
    .replace(/['']/g, '-')       // Apostrophes → hyphen
    .replace(/[:.!?,()]/g, '')   // Drop punctuation
    .replace(/\s+/g, '-')        // Spaces → hyphens
    .replace(/-+/g, '-')         // Collapse multiple hyphens
    .replace(/^-|-$/g, '');      // Trim leading/trailing hyphens
}

/**
 * Generate candidate Show Score URLs for a show
 */
function generateCandidateUrls(show) {
  const titleSlug = slugifyTitle(show.title);
  const titleNoColon = show.title.replace(/:.*$/, '').trim();
  const titleNoColonSlug = slugifyTitle(titleNoColon);
  const showSlug = (show.slug || show.id).replace(/-\d{4}$/, '');
  const isMusical = show.type === 'musical' ||
    (show.tags && show.tags.some(t => /musical/i.test(t)));
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  const candidates = [];

  // Try without leading "the-" (SeatPlan/LBO pattern — sites often drop articles)
  const titleNoThe = titleSlug.startsWith('the-') ? titleSlug.replace(/^the-/, '') : null;
  const titleNoMusical = titleSlug.endsWith('-the-musical') ? titleSlug.replace(/-the-musical$/, '') : null;

  if (isWestEnd) {
    // West End: try -west-end and -london suffixes
    candidates.push(
      `${titleSlug}-west-end`,
      `${titleSlug}-london`,
      `${titleNoColonSlug}-west-end`,
      `${titleNoColonSlug}-london`,
      `${showSlug.replace(/-west-end$/, '')}-west-end`,
      `${showSlug.replace(/-west-end$/, '')}-london`,
    );
    if (titleNoThe) {
      candidates.push(`${titleNoThe}-west-end`, `${titleNoThe}-london`);
    }
    if (titleNoMusical) {
      candidates.push(`${titleNoMusical}-west-end`, `${titleNoMusical}-london`);
    }
    if (isMusical) {
      candidates.push(
        `${titleSlug}-the-musical-west-end`,
        `${titleSlug}-the-musical-london`,
      );
    }
    candidates.push(titleSlug, showSlug.replace(/-west-end$/, ''));
  } else if (isOffBroadway) {
    // Off-Broadway: no -broadway suffix needed
    // NOTE: OB slugs are unpredictable (often include venue name like "heathers-the-musical-new-world-stages").
    // Primary discovery is via listings scraping (discover-show-score-urls-from-listings.js).
    // This slug-based fallback only covers simple cases.
    candidates.push(titleSlug, titleNoColonSlug, showSlug);
    if (isMusical) {
      candidates.push(`${titleSlug}-the-musical`, `${titleNoColonSlug}-the-musical`);
    }
  } else {
    candidates.push(
      `${titleSlug}-broadway`,
      `${titleNoColonSlug}-broadway`,
      `${showSlug}-broadway`,
    );
    // Show Score year-suffixes a Broadway page when the title already has an
    // older page (School Girls: ...-broadway-2026, BRO-4358).
    const years = [show.openingDate, show.previewsStartDate]
      .map(d => (d ? String(d).slice(0, 4) : ''))
      .filter(y => /^\d{4}$/.test(y));
    for (const year of new Set(years)) {
      candidates.push(
        `${titleSlug}-broadway-${year}`,
        `${titleNoColonSlug}-broadway-${year}`,
        `${showSlug}-broadway-${year}`,
      );
    }
    if (titleNoThe) {
      candidates.push(`${titleNoThe}-broadway`);
    }
    if (titleNoMusical) {
      candidates.push(`${titleNoMusical}-broadway`);
    }
    if (isMusical) {
      candidates.push(
        `${titleSlug}-the-musical-broadway`,
        `${titleNoColonSlug}-the-musical-broadway`,
      );
    }
    candidates.push(titleSlug, showSlug);
  }

  // URL base depends on category
  const base = isWestEnd
    ? 'https://www.show-score.com/uk/london/west-end-shows'
    : isOffBroadway
      ? 'https://www.show-score.com/off-broadway-shows'
      : 'https://www.show-score.com/broadway-shows';

  // Deduplicate while preserving order
  return [...new Set(candidates)].map(slug => `${base}/${slug}`);
}

/**
 * Normalize a title for fuzzy comparison (strip parenthetical suffixes, punctuation, etc.)
 */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\s*\(broadway\)\s*/i, '')      // Strip "(Broadway)"
    .replace(/\s*\(london\)\s*/i, '')        // Strip "(London)"
    .replace(/\s*\(west end\)\s*/i, '')      // Strip "(West End)"
    .replace(/\s*\(.*?\)\s*$/, '')           // Strip trailing parenthetical
    .replace(/[''":,.!?]/g, '')              // Strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a JSON-LD page title matches the show we're looking for.
 * Prevents listings-page contamination (where Hamilton appears as first result).
 */
function titlesMatch(jsonLdName, showTitle) {
  const a = normalizeTitle(jsonLdName);
  const b = normalizeTitle(showTitle);
  if (!a || !b) return false;
  // Exact match after normalization
  if (a === b) return true;
  // One contains the other (handles subtitles like "Sweeney Todd: The Demon Barber...")
  if (a.includes(b) || b.includes(a)) return true;
  // Check first significant word match (handles "The" prefix variations)
  const aWords = a.replace(/^the /, '').split(' ');
  const bWords = b.replace(/^the /, '').split(' ');
  if (aWords[0] === bWords[0] && aWords[0].length > 3) return true;
  return false;
}

/**
 * Extract JSON-LD name from HTML
 */
function extractJsonLdName(html) {
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (!jsonLdMatch) return null;
  for (const match of jsonLdMatch) {
    try {
      const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
      const data = JSON.parse(content);
      if (data.aggregateRating && data.name) return data.name;
    } catch (e) { /* skip */ }
  }
  return null;
}

/**
 * Validate that HTML is a valid Show Score Broadway show page with audience data.
 * @param {string} html - Page HTML
 * @param {string} url - Page URL
 * @param {string} [showTitle] - Expected show title (for title validation)
 */
function isValidShowScorePage(html, url, showTitle, options = {}) {
  const { allowOffBroadway = false, allowWestEnd = false } = options;
  if (!html) return false;
  // Not a 404
  if (isShowScoreNotFoundPage(html) || html.includes('Page not found') || html.includes('404 -')) return false;
  // Not the homepage
  if (html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>')) return false;
  // Always reject off-off-broadway
  if (url.includes('/off-off-broadway-shows/')) return false;
  // Reject off-broadway unless show is off-broadway
  if (!allowOffBroadway && url.includes('/off-broadway-shows/')) return false;
  // Reject london/west-end shows unless show is west-end
  if (!allowWestEnd && (url.includes('/london-shows/') || url.includes('/west-end-shows/'))) return false;
  // BRO-5499: Show Score serves the London page at the NYC slug when a transfer has no NYC page
  // yet (canonical /uk/london/off-west-end-shows/...): London ratings must not become a NYC audience score.
  if (servesUkPageForUsShow(html, url, { allowWestEnd })) {
    if (verbose) console.log('    Rejected: page canonical is a UK Show Score page');
    return false;
  }
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(content);
        if (data.aggregateRating && typeof data.aggregateRating.ratingValue === 'number') {
          // Check canonical URL isn't off-off-broadway (always rejected)
          if (data.url && /\/off-off-broadway-shows\//.test(data.url)) {
            if (verbose) console.log(`    Rejected: canonical URL is off-off-broadway (${data.url})`);
            return false;
          }
          // Reject off-broadway canonical unless show is off-broadway
          if (!allowOffBroadway && data.url && /\/off-broadway-shows\//.test(data.url)) {
            if (verbose) console.log(`    Rejected: canonical URL is off-broadway (${data.url})`);
            return false;
          }
          // Reject london/west-end-shows canonical unless show is west-end
          if (!allowWestEnd && data.url && (/\/london-shows\//.test(data.url) || /\/west-end-shows\//.test(data.url))) {
            if (verbose) console.log(`    Rejected: canonical URL is west-end-shows (${data.url})`);
            return false;
          }
          // Title validation: reject if page is for a different show (listings page redirect)
          if (showTitle && data.name && !titlesMatch(data.name, showTitle)) {
            if (verbose) console.log(`    Rejected: title mismatch — page="${data.name}", expected="${showTitle}"`);
            return false;
          }
          return true;
        }
      } catch (e) { /* skip */ }
    }
  }
  return false;
}

/**
 * Discover Show Score URL for a show by trying candidate patterns
 */
async function discoverShowScoreUrl(show) {
  // BRO-4876: tours have no Show Score page; guessing finds the parent's.
  if (!canDiscoverShowScoreUrl(show)) return null;
  // For older productions, only discover if the newest already has a URL
  // (so we can ensure we find a DIFFERENT page, not the same one)
  let newestUrl = null;
  if (!isMostRecentProduction(show)) {
    newestUrl = getNewestProductionUrl(show);
    if (!newestUrl) {
      console.log(`  SKIP discovery: ${show.id} — newest production not yet discovered`);
      return null;
    }
    console.log(`  Older production — looking for own page (newest uses: ${newestUrl})`);
  }

  const candidates = generateCandidateUrls(show);
  if (verbose) console.log(`  Trying ${candidates.length} URL patterns...`);

  for (const url of candidates) {
    if (isProductionMismatch(urlData, show.id, url)) {
      if (verbose) console.log(`  Skip: ${url} (recorded as another production's page, BRO-5866)`);
      continue;
    }
    // For older productions, skip URLs already claimed by any other show
    if (newestUrl && url === newestUrl) {
      if (verbose) console.log(`  Skip: ${url} (same as newest production)`);
      continue;
    }
    // Skip URLs another show already has cached, for every production: a
    // revival's plain "-broadway" slug is often the older production's page,
    // and matching it first would hide the revival's "-broadway-<year>" page
    // behind a conflict (BRO-4358; also prevents 3+ production dupes).
    const existingOwner = findConflictingShowId(urlData.shows || {}, show.id, url);
    if (existingOwner) {
      if (verbose) console.log(`  Skip: ${url} (already cached for ${existingOwner})`);
      continue;
    }
    try {
      if (verbose) console.log(`  Trying: ${url}`);
      const html = await fetchWithFallback(url, 0); // No retries during discovery
      // isValidShowScorePage already requires a JSON-LD titlesMatch() pass
      // (the page's own declared show name) before returning true — a
      // deterministic, more reliable signal than the LLM heading tiebreaker,
      // which was rejecting genuinely correct pages (see page-validator.js).
      // Still run validatePageMatchesShow with skipLlm — titlesMatch() alone
      // has no year-mismatch or short-title-partial-match guard, so a
      // same-title-different-year revival, or a listing-page JSON-LD name
      // that loosely contains the show title, wouldn't otherwise be caught.
      if (isValidShowScorePage(html, url, show.title, { allowOffBroadway: show.category === 'off-broadway', allowWestEnd: isLondonMarket(show.category) || allowsUkShowScorePage(show) })) {
        const pageValidation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null, pageType: 'audience-aggregator', skipLlm: true });
        if (!pageValidation.valid) {
          if (verbose) console.log(`  ✗ Page validator rejected (deterministic): ${pageValidation.reason}`);
          continue;
        }
        // BRO-5866: a plain slug can be a same-title earlier production's page.
        const windowCheck = checkPageProductionWindow(html, show, url);
        if (!windowCheck.ok) {
          console.log(`  ✗ ${url} is another production's page: ${windowCheck.reason}`);
          noteProductionMismatch(show.id, url);
          continue;
        }
        console.log(`  ✓ Discovered: ${url}`);
        return url;
      }
    } catch (error) {
      if (verbose) console.log(`    ${error.message}`);
    }
    await sleep(2000); // Rate limit between discovery attempts
  }
  return null;
}

/**
 * BRO-4358: drop a cached URL that returned Show Score's 404 page and try to
 * find the show's current page. Returns the URL to scrape now (a replacement,
 * or the same URL when it loaded fine on the retry; already cached) or null.
 * With no replacement the show is left uncached, so the listings-discovery
 * step of the next run gets another go at it.
 */
async function rediscoverAfterDeadUrl(show, deadUrl) {
  // Capped per run: a sitewide Show Score change would otherwise send every
  // cached show through ~10 candidate fetches (billed even on 404) and could
  // strip the whole cache in one run.
  if (!(deadUrlRediscoveriesLeft > 0)) {
    console.log(`  Dead URL for ${show.id} left in place: rediscovery budget for this run is spent`);
    // Not a clean "no data" result: don't stamp it fresh, so the next run
    // retries it instead of waiting out --skip-fresh-hours.
    showFetchFailed = true;
    return null;
  }

  // One cheap re-check first: a brief 404 on a URL discovery can't re-guess
  // (off-Broadway venue slugs, listings-found URLs) would otherwise be dropped.
  try {
    const again = await fetchWithFallback(deadUrl, 0);
    if (again && !isShowScoreNotFoundPage(again) && again.includes('"aggregateRating"')) {
      console.log(`  Kept ${deadUrl}: it loaded fine on a re-check`);
      return deadUrl;
    }
  } catch (_) { /* still dead or unreachable: go on to rediscovery */ }

  deadUrlRediscoveriesLeft--;
  if (!urlData._discoveryAttempts) urlData._discoveryAttempts = {};
  urlData._discoveryAttempts[show.id] = new Date().toISOString();

  // Uncache first so discovery doesn't treat the dead URL as owned by this show.
  const shows = urlData.shows || (urlData.shows = {});
  delete shows[show.id];
  const url = await discoverShowScoreUrl(show);
  const conflictId = url ? findConflictingShowId(shows, show.id, url) : null;
  const action = decideDeadUrlAction({ deadUrl, rediscoveredUrl: url, conflictId, budgetLeft: 1 });

  let result = null;
  if (action === 'keep') {
    shows[show.id] = deadUrl;
    result = deadUrl; // caller re-scrapes it this run
    console.log(`  Kept ${deadUrl}: it loaded fine on the retry`);
  } else if (action === 'replace') {
    shows[show.id] = url;
    result = url;
    console.log(`  ✓ Replaced dead URL for ${show.id}: ${deadUrl} → ${url}`);
  } else {
    if (conflictId) console.log(`  [SKIP] ${url} already assigned to ${conflictId}`);
    console.log(`  ✗ Removed dead URL for ${show.id} (${deadUrl}); no replacement found`);
  }
  if (!dryRun) saveUrlCache();
  return result;
}

/**
 * Save URL cache to disk (incremental persist)
 */
function saveUrlCache() {
  urlData._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(urlsPath, JSON.stringify(urlData, null, 2) + '\n');
}

/**
 * Extract audience data from Show Score HTML
 */
function extractAudienceData(html, showId) {
  const result = {
    score: null,
    reviewCount: null,
  };

  // Method 1: Extract from JSON-LD (most reliable)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const jsonContent = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(jsonContent);
        if (data.aggregateRating) {
          result.score = data.aggregateRating.ratingValue;
          result.reviewCount = data.aggregateRating.reviewCount;
          break;
        }
      } catch (e) {
        // Skip invalid JSON-LD
      }
    }
  }

  // Method 2: Fallback - look for score in page content
  if (!result.score) {
    // Show Score displays the score prominently, try to find it
    const scoreMatch = html.match(/class="[^"]*score[^"]*"[^>]*>(\d+)%?</i) ||
                       html.match(/>(\d{2,3})%?\s*<[^>]*class="[^"]*score/i);
    if (scoreMatch) {
      result.score = parseInt(scoreMatch[1]);
    }
  }

  // Method 3: Look for review count
  if (!result.reviewCount) {
    const countMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*(?:member\s*)?reviews?/i) ||
                       html.match(/reviewCount['"]\s*:\s*(\d+)/i);
    if (countMatch) {
      result.reviewCount = parseInt(countMatch[1].replace(/,/g, ''));
    }
  }

  return result;
}

/**
 * Extract metadata (runtime, synopsis) from Show Score HTML via JSDOM.
 * Returns { runtime: string|null, synopsis: string|null }.
 */
function extractMetadata(html) {
  const result = { runtime: null, synopsis: null };

  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // ── Runtime extraction ──
    // Show Score displays "1h 40m" or "2h" in the show header area.
    // Uses non-word-boundary pattern to handle concatenated text from SPA spans.
    // Negative lookahead excludes "Xh ago" timestamps.
    const runtimePattern = /(?:^|[^a-zA-Z])(\d{1,2})\s*h(?:r?s?)?\s*(?:(\d{1,2})\s*m(?:in)?)?(?!\s*ago)/i;
    const runtimePatternMinOnly = /(?:^|[^a-zA-Z])(\d{2,3})\s*min(?:ute)?s?/i;

    function parseRuntime(text) {
      const match = text.match(runtimePattern);
      if (match) {
        const hours = parseInt(match[1]);
        const mins = match[2] ? parseInt(match[2]) : 0;
        if (hours >= 1 && hours <= 5 && mins >= 0 && mins < 60) {
          return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
      }
      const minMatch = text.match(runtimePatternMinOnly);
      if (minMatch) {
        const totalMins = parseInt(minMatch[1]);
        if (totalMins >= 30 && totalMins <= 300) {
          const h = Math.floor(totalMins / 60);
          const m = totalMins % 60;
          return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${totalMins}m`;
        }
      }
      return null;
    }

    // Check individual child spans in header elements (handles SPA-rendered spans)
    const headerCandidates = doc.querySelectorAll('h1, h2, [class*="detail"], [class*="header"], [class*="info"], [class*="show"], [class*="meta"]');
    for (const el of headerCandidates) {
      for (const child of el.querySelectorAll('span, div, p, a, li')) {
        const childText = child.textContent || '';
        if (childText.length > 2 && childText.length < 30) {
          const rt = parseRuntime(childText);
          if (rt) { result.runtime = rt; break; }
        }
      }
      if (result.runtime) break;
      const text = el.textContent || '';
      const rt = parseRuntime(text);
      if (rt) { result.runtime = rt; break; }
    }

    // Fallback: scan first 5000 chars of body text
    if (!result.runtime) {
      const bodyText = (doc.body?.textContent || '').slice(0, 5000);
      result.runtime = parseRuntime(bodyText);
    }

    // ── Synopsis extraction ──
    // About-the-Show text cut at a sentence end, never mid-word (BRO-5859).
    result.synopsis = extractShowScoreSynopsis(doc);

    dom.window.close();
  } catch (e) {
    if (verbose) console.log(`  Metadata extraction error: ${e.message}`);
  }

  return result;
}

/**
 * Get cached Show Score URL for a show (cache-only, no discovery)
 */
function getCachedUrl(showId) {
  if (urlData.shows && urlData.shows[showId]) {
    return urlData.shows[showId];
  }
  return null;
}

// Shard output (main() fills these in shard mode), module-level so the
// wrong-production path in processShow can hand its finding to the merge.
let shardOutput = null;
let shardPath = null;

/**
 * BRO-5866: record a page proven to be another production's. Shard runs
 * don't save the URL cache or audience-buzz, so the finding rides the shard
 * file and merge-show-score-shards.js applies it.
 */
function noteProductionMismatch(showId, url) {
  recordProductionMismatch(urlData, showId, url);
  if (shardOutput && shardPath) {
    if (!shardOutput.productionMismatch) shardOutput.productionMismatch = {};
    shardOutput.productionMismatch[showId] = url;
    fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
  }
}

// BRO-4215: set when processShow's fetch THREW for the current show, as
// opposed to cleanly finding no usable data (404, wrong page, empty page).
// Both return null; only a clean no-data result may stamp
// showScoreLastAttempted, or a proxy outage would mark every show fresh and
// suppress retries for the whole --skip-fresh-hours window.
let showFetchFailed = false;

/**
 * A US show whose Show Score page turned out to be London's: clear any rating an earlier run attached
 * (and recompute the combined score from what remains) so the bad number does not wait for the purge.
 */
function dropUkShowScoreSource(show, html) {
  const rec = audienceBuzz.shows && audienceBuzz.shows[show.id];
  if (dryRun || !rec || !rec.sources || !rec.sources.showScore) return;
  // Only when the stored rating IS the UK page's rating: a transient London page says nothing about a
  // rating scraped earlier from the right page (same proof as purge-uk-show-score-audience.js).
  if (!storedRatingMatchesPage(rec.sources.showScore, pageRatingOf(html))) return;
  removeSourceWithTombstone(rec, 'showScore', 'Show Score page is a UK production page (canonical /uk/london/...) (BRO-5499)');
  const { score } = calculateCombinedScore(rec.sources, { status: show.status, closingDate: show.closingDate, category: show.category });
  rec.combinedScore = score ?? null;
  rec.designation = score == null ? null : getDesignation(score);
  console.log(`  Cleared stale Show Score rating for ${show.id}; combinedScore now ${rec.combinedScore}`);
  // processShow returns null here, so the main loop's save-on-success never runs for this show.
  // Shard runs merge through merge-show-score-shards.js instead of writing audience-buzz directly.
  if (!shardMode) saveAudienceBuzz(audienceBuzz);
}

/**
 * BRO-5866: the cached page was another production's, so any rating stored
 * from it belongs to that production. Clear it (tombstoned, so reconcile
 * does not refill it) and recompute, like dropUkShowScoreSource.
 */
function dropWrongProductionShowScoreSource(show, url) {
  if (dryRun) return;
  const r = removeWrongProductionShowScore({ showId: show.id, url, audienceBuzz, show });
  if (!r.audienceRemoved) return;
  console.log(`  Cleared Show Score rating from another production's page for ${show.id}; combinedScore now ${r.combinedScore}`);
  // Shard runs hand the finding to merge-show-score-shards.js instead.
  if (!shardMode) saveAudienceBuzz(audienceBuzz);
}

/**
 * Process a single show (cache-only — URL must already be in show-score-urls.json)
 */
async function processShow(show, { rediscovered = false } = {}) {
  showFetchFailed = false;
  // Multi-production guard: older productions only processed if they have their own page
  if (!isMostRecentProduction(show)) {
    const myUrl = getCachedUrl(show.id);
    const newestUrl = getNewestProductionUrl(show);
    if (!myUrl) {
      if (verbose) console.log(`\n  SKIP: ${show.id} — older production, no own ShowScore page`);
      return null;
    }
    if (newestUrl && myUrl === newestUrl) {
      console.log(`\n  SKIP: ${show.id} — same URL as newest production, removing duplicate`);
      if (urlData.shows) delete urlData.shows[show.id];
      if (!dryRun) saveUrlCache();
      return null;
    }
    console.log(`\n  ${show.id}: older production with own ShowScore page`);
  }

  const url = getCachedUrl(show.id);
  if (!url) {
    if (verbose) console.log(`\n  SKIP: ${show.title} — no cached URL`);
    return null;
  }

  console.log(`\nProcessing: ${show.title}`);
  console.log(`  URL: ${url}`);

  try {
    const html = await fetchWithFallback(url);

    // Validate page
    // BRO-4358: a cached URL that 404s used to be kept forever, because this
    // check never matched Show Score's real 404 page and discovery only runs
    // for UNCACHED shows (School Girls: the page moved from ...-broadway to
    // ...-broadway-2026 and the show had no Show Score audience score through
    // opening night). Show Score's own 404 template → rediscover now.
    if (isShowScoreNotFoundPage(html)) {
      console.log(`  SKIP: Show not found on Show Score`);
      if (!rediscovered) {
        const replacement = await rediscoverAfterDeadUrl(show, url);
        if (replacement) return processShow(show, { rediscovered: true });
      }
      return null;
    }
    // Looser legacy markers: skip only, never uncache on them.
    if (!html || html.includes('Page not found') || html.includes('404 -')) {
      console.log(`  SKIP: Show not found on Show Score`);
      return null;
    }

    // BRO-5499 follow-up: Show Score serves the London page at a US slug until the transfer has a
    // NYC page. This is the path every cached URL takes, so the guard must live here too (it was
    // discovery-only, which let Midnight's cached URL re-attach London's 92%/353 ratings each run).
    if (isUkPageForShow(show, html, url)) {
      console.log(`  SKIP: ${url} is a UK Show Score page (canonical /uk/london/...), not this US production`);
      dropUkShowScoreSource(show, html);
      return null;
    }

    if (!html.includes('show-score.com') && !html.includes('Show Score')) {
      console.log(`  SKIP: Page doesn't appear to be Show Score`);
      // Usually a bot-challenge/interstitial page: treat as a fetch failure so
      // it isn't stamped fresh and suppressed for --skip-fresh-hours.
      showFetchFailed = true;
      return null;
    }

    // Title validation: reject if page is for a different show
    const jsonLdName = extractJsonLdName(html);
    if (jsonLdName && !titlesMatch(jsonLdName, show.title)) {
      console.log(`  SKIP: Title mismatch — page="${jsonLdName}", expected="${show.title}"`);
      console.log(`  Removing bad cached URL for ${show.id}`);
      if (urlData.shows) delete urlData.shows[show.id];
      if (!dryRun) saveUrlCache();
      return null;
    }

    // Deterministic checks (year-mismatch, short-title partial-match guard —
    // titlesMatch() above has no year logic, so a same-title different-year
    // revival wouldn't otherwise be caught). skipLlm avoids the flaky LLM
    // heading tiebreaker (see page-validator.js), which was rejecting
    // genuinely correct pages.
    const pageCheck = await checkShowScorePage(html, show, { jsonLdName, url });
    if (!pageCheck.valid) {
      console.log(`  SKIP: Page validator rejected — ${pageCheck.reason}`);
      console.log(`  Removing bad cached URL for ${show.id}`);
      if (urlData.shows) delete urlData.shows[show.id];
      if (pageCheck.productionMismatch) {
        noteProductionMismatch(show.id, url);
        dropWrongProductionShowScoreSource(show, url);
      }
      if (!dryRun) saveUrlCache();
      return null;
    }

    const data = extractAudienceData(html, show.id);
    const metadata = extractMetadata(html);

    if (metadata.runtime) console.log(`  Runtime: ${metadata.runtime}`);
    if (metadata.synopsis) console.log(`  Synopsis: ${metadata.synopsis.slice(0, 80)}...`);

    if (!data.score && !metadata.runtime && !metadata.synopsis) {
      // Distinguish between "page exists but has no data" (Show-Score broken) vs truly empty
      const hasPageStructure = html.includes('show-page') || html.includes('aggregateRating') || html.includes('show-score.com');
      if (hasPageStructure) {
        console.log(`  SKIP: Page loaded but no data extracted (Show-Score may not be displaying reviews)`);
      } else {
        console.log(`  SKIP: No audience score or metadata found`);
      }
      return null;
    }

    if (data.score) {
      console.log(`  Score: ${data.score}%, Reviews: ${data.reviewCount || 'unknown'}`);
    }

    return {
      score: data.score,
      reviewCount: data.reviewCount || 0,
      metadata,
    };

  } catch (error) {
    console.error(`  ERROR: ${error.message}`);
    showFetchFailed = true;
    return null;
  }
}

// calculateCombinedScore imported from ./lib/audience-weighting.js

/**
 * Update audience-buzz.json with Show Score data
 */
function updateAudienceBuzz(showId, showTitle, showScoreData) {
  // Initialize show entry if it doesn't exist
  if (!audienceBuzz.shows[showId]) {
    audienceBuzz.shows[showId] = {
      title: showTitle,
      designation: null,
      combinedScore: null,
      sources: {
        showScore: null,
        mezzanine: null,
        reddit: null,
        theatr: null,
      }
    };
  }

  // Update Show Score data
  audienceBuzz.shows[showId].sources.showScore = {
    score: showScoreData.score,
    reviewCount: showScoreData.reviewCount,
    // BRO-4215: lets --skip-fresh-hours skip a show scraped minutes ago
    // (same field the reddit source record already carries).
    lastUpdated: new Date().toISOString(),
  };

  // Recalculate combined score with dynamic weighting
  const sources = audienceBuzz.shows[showId].sources;
  const sd = showMapById[showId];
  const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status, category: sd.category } : undefined;
  const { score, weights } = calculateCombinedScore(sources, showInfo);

  if (score !== null) {
    audienceBuzz.shows[showId].combinedScore = score;

    audienceBuzz.shows[showId].designation = getDesignation(score);

    // Log the weights used
    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('Show Score Audience Data Scraper');
  console.log('================================\n');

  // Check that at least one scraping method is available
  const hasScraper = SCRAPINGBEE_KEY || process.env.BRIGHTDATA_TOKEN;
  let hasPlaywright = false;
  try { require.resolve('playwright'); hasPlaywright = true; } catch (_) {}
  if (!hasScraper && !hasPlaywright) {
    console.error('Error: No scraping method available. Set SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN, or install playwright.');
    process.exit(1);
  }
  if (!SCRAPINGBEE_KEY) {
    console.log('Note: SCRAPINGBEE_API_KEY not set — using fallback scrapers');
  }

  // Get shows to process — open shows only by default, --all includes closed
  const allActiveShows = showsData.shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'closed');
  let shows = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open' || s.status === 'previews');

  // Handle single show filter (can target any status)
  if (showFilter) {
    shows = allActiveShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  } else if (showsArg) {
    // Handle multiple shows (comma-separated) or special keywords
    if (showsArg === 'missing') {
      // Filter to shows without Show Score data
      const base = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open');
      shows = base.filter(s => {
        const b = (audienceBuzz.shows || {})[s.id];
        return !b || !b.sources || !b.sources.showScore;
      });
      console.log(`Found ${shows.length} shows missing Show Score data${includeAll ? ' (all statuses)' : ' (open only)'}`);
    } else {
      const showIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);
      shows = allActiveShows.filter(s => showIds.includes(s.id) || showIds.includes(s.slug));
      if (shows.length === 0) {
        console.error(`No shows found matching: ${showsArg}`);
        process.exit(1);
      }
      if (skipFreshHours > 0) {
        const fresh = shows.filter(s => isSourceFresh((audienceBuzz.shows || {})[s.id], 'showScore', skipFreshHours, { attemptField: 'showScoreLastAttempted' }));
        if (fresh.length > 0) {
          console.log(`Skipping ${fresh.length} show(s) with Show Score updated in the last ${skipFreshHours}h: ${fresh.map(s => s.id).join(', ')}`);
          shows = shows.filter(s => !fresh.includes(s));
        }
        if (shows.length === 0) {
          console.log('All requested shows are fresh — nothing to scrape.');
          process.exit(0);
        }
      }
      console.log(`Processing specific shows: ${shows.map(s => s.title).join(', ')}`);
    }
  } else if (!includeAll) {
    console.log(`Processing open shows only (${shows.length}). Use --all for all shows.`);
  }

  // Shard mode: partition shows across parallel workers
  if (shardMode) {
    shows = shows.filter((_, i) => i % totalShards === shard);
    console.log(`Shard ${shard}/${totalShards}: processing ${shows.length} shows`);
  }

  // Initialize shard output for incremental writing (survives timeout/crash)
  if (shardMode && !dryRun) {
    const shardDir = path.join(__dirname, '../data/show-score-shards');
    if (!fs.existsSync(shardDir)) fs.mkdirSync(shardDir, { recursive: true });
    shardOutput = { discoveredUrls: {}, scores: {} };
    shardPath = path.join(shardDir, `shard-${shard}.json`);
  }

  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  // ── Phase 0: Listings-based discovery (scrapes Show Score's actual listings pages) ──
  // This is the PRIMARY discovery method. Phase A (slug guessing) is a fallback.
  const uncachedBefore = shows.filter(s => !getCachedUrl(s.id)).length;
  if (uncachedBefore > 0 && !shardMode) {
    // Only run listings discovery in non-shard mode (shard runs are for scoring, not discovery)
    console.log(`\n── Listings Discovery Phase: ${uncachedBefore} uncached shows ──`);
    try {
      const { execSync } = require('child_process');
      // /what-else follow-up (BRO-4055): this call used to never forward
      // --dry-run, so a "safe preview" run of THIS script still performed
      // real writes via the child process (caught live: a --dry-run run
      // wrote a new url to show-score-urls.json on disk). Forward it.
      const childCmd = dryRun
        ? 'node scripts/discover-show-score-urls-from-listings.js --dry-run'
        : 'node scripts/discover-show-score-urls-from-listings.js';
      const result = execSync(childCmd, {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 120000,
      });
      console.log(result);
      // Reload URL cache after listings discovery
      const freshUrlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
      urlData.shows = freshUrlData.shows;
      urlData._meta = freshUrlData._meta;
      urlData._discoveryAttempts = freshUrlData._discoveryAttempts || urlData._discoveryAttempts;
      const uncachedAfter = shows.filter(s => !getCachedUrl(s.id)).length;
      console.log(`Listings discovery resolved ${uncachedBefore - uncachedAfter} URLs (${uncachedAfter} still uncached)\n`);
    } catch (err) {
      console.error(`Listings discovery failed: ${err.message}`);
      console.log('Falling back to slug-based discovery...\n');
    }
  }

  // ── Phase A: Slug-based discovery fallback (uncached shows only, capped) ──
  const uncachedShows = shows.filter(s => !getCachedUrl(s.id));
  if (uncachedShows.length > 0) {
    // Filter out shows we attempted recently
    const now = Date.now();
    const discoveryTargets = uncachedShows.filter(s => {
      const meta = urlData._discoveryAttempts && urlData._discoveryAttempts[s.id];
      if (!meta) return true;
      return (now - new Date(meta).getTime()) > DISCOVERY_COOLDOWN_MS;
    }).slice(0, MAX_DISCOVERIES);

    if (discoveryTargets.length > 0) {
      console.log(`\n── Discovery Phase: ${discoveryTargets.length} uncached shows (max ${MAX_DISCOVERIES}) ──\n`);

      for (const show of discoveryTargets) {
        console.log(`Discovering: ${show.title} (${show.id})`);
        const url = await discoverShowScoreUrl(show);

        // Track attempt timestamp
        if (!urlData._discoveryAttempts) urlData._discoveryAttempts = {};
        urlData._discoveryAttempts[show.id] = new Date().toISOString();

        if (url) {
          // BRO-4055: a show that just lost its mapping (a hand-removed
          // wrong-production URL, e.g. BRO-3416) is "uncached" and lands
          // right back in this discovery loop — without this check,
          // slug-guessing would immediately re-match it to the same page
          // another showId already owns, undoing the removal.
          if (!urlData.shows) urlData.shows = {};
          const conflictId = findConflictingShowId(urlData.shows, show.id, url);
          if (conflictId) {
            console.log(`  [SKIP] ${url} already assigned to ${conflictId} — refusing to also assign it to ${show.id}`);
            if (!dryRun) saveUrlCache(); // persist the attempt timestamp above
            continue;
          }
          urlData.shows[show.id] = url;
          if (!dryRun) saveUrlCache();
          // Update shard incrementally
          if (shardOutput) {
            shardOutput.discoveredUrls[show.id] = url;
            fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
          }
          console.log(`  ✓ Cached URL for ${show.id}`);
        } else {
          console.log(`  ✗ No Show Score page found for ${show.title}`);
          if (!dryRun) saveUrlCache(); // Save attempt timestamp
        }

        await sleep(3000);
      }
      console.log('');
    } else if (uncachedShows.length > 0) {
      console.log(`\n${uncachedShows.length} uncached shows skipped (discovery cooldown)\n`);
    }
  }

  // ── Phase B: Score scraping (cached URLs only) ──
  const showsWithUrls = shows.filter(s => getCachedUrl(s.id));
  console.log(`Processing ${showsWithUrls.length} shows with cached URLs...\n`);

  // Snapshot existing scores for guard comparison
  const previousScores = {};
  let previousScoredCount = 0;
  for (const show of showsWithUrls) {
    const existing = audienceBuzz.shows && audienceBuzz.shows[show.id];
    if (existing && existing.sources && existing.sources.showScore && existing.sources.showScore.score != null) {
      previousScores[show.id] = existing.sources.showScore.score;
      previousScoredCount++;
    }
  }

  let processed = 0;
  let successful = 0;
  let metadataEnriched = 0;
  const scoreDrops = [];
  // Track scraped results by title to detect cross-contamination:
  // when different URLs for same-title shows return identical data,
  // only the most recent production keeps it.
  const scrapedByTitle = new Map(); // normalized title → { showId, score, reviewCount }

  for (const show of showsWithUrls) {
    try {
      const data = await processShow(show);
      processed++;

      if (data) {
        // Check for score drops
        if (previousScores[show.id] != null && data.score == null) {
          scoreDrops.push(show.id);
        }

        // Cross-contamination guard: if a same-title sibling scraped identical
        // data from a different URL, this is likely the same Show-Score production.
        // Keep only the most recent/relevant show's data.
        if (data.score) {
          const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
          const key = `${titleBase}|${data.score}|${data.reviewCount}`;
          const existing = scrapedByTitle.get(key);
          if (existing && existing.showId !== show.id) {
            // Compare: prefer open/previews, then most recent opening
            const isBetter = (show.status === 'open' || show.status === 'previews') &&
              existing.status !== 'open' && existing.status !== 'previews' ||
              (show.openingDate || '') > (existing.openingDate || '');
            if (isBetter) {
              console.log(`  Superseding ${existing.showId} — this show is more recent`);
              // Clear the older show's data from audience-buzz
              if (audienceBuzz.shows[existing.showId]?.sources?.showScore) {
                audienceBuzz.shows[existing.showId].sources.showScore = null;
              }
              scrapedByTitle.set(key, { showId: show.id, score: data.score, reviewCount: data.reviewCount, status: show.status, openingDate: show.openingDate });
            } else {
              console.log(`  SKIP audience data: identical to ${existing.showId} (same Show-Score production)`);
              data.score = null; // prevent writing to audience-buzz
            }
          } else {
            scrapedByTitle.set(key, { showId: show.id, score: data.score, reviewCount: data.reviewCount, status: show.status, openingDate: show.openingDate });
          }
        }

        if (!dryRun) {
          if (data.score) {
            updateAudienceBuzz(show.id, show.title, data);
          }
          successful++;

          // ── Metadata enrichment: fill missing runtime/synopsis in shows.json ──
          if (data.metadata) {
            let enriched = false;
            if (data.metadata.runtime && !show.runtime) {
              show.runtime = data.metadata.runtime;
              enriched = true;
              console.log(`  ✓ Enriched runtime: ${data.metadata.runtime}`);
            }
            if (data.metadata.synopsis && !show.synopsis) {
              // Show Score's blurb is producer marketing copy. Gate it (BRO-4853:
              // it put a false Tony claim on Other Desert Cities) so a bad blurb is
              // left unwritten for Wikipedia enrichment instead of going live.
              const gate = gateScrapedSynopsis(show, data.metadata.synopsis, { showsById: showMapById });
              if (gate.ok) {
                setSynopsis(show, data.metadata.synopsis, 'show-score');
                enriched = true;
                console.log(`  ✓ Enriched synopsis (${data.metadata.synopsis.length} chars)`);
              } else {
                console.log(`  ✗ Skipped Show Score synopsis (${gate.reason})`);
              }
            }
            if (enriched) metadataEnriched++;
          }

          // Save incrementally after each successful show
          audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
          audienceBuzz._meta.notes = 'Proportional weighting by reviewCount volume (max 80% single source)';
          saveAudienceBuzz(audienceBuzz);
          // Update shard incrementally (survives timeout)
          if (shardOutput) {
            const entry = audienceBuzz.shows && audienceBuzz.shows[show.id];
            if (entry && entry.sources && entry.sources.showScore) {
              shardOutput.scores[show.id] = entry.sources.showScore;
            }
            const cachedUrl = getCachedUrl(show.id);
            if (cachedUrl) shardOutput.discoveredUrls[show.id] = cachedUrl;
            fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
          }
          console.log(`  ✓ Saved (${successful}/${showsWithUrls.length})`);
        } else {
          successful++;
          // Log metadata findings in dry-run mode
          if (data.metadata) {
            if (data.metadata.runtime && !show.runtime) console.log(`  [dry-run] Would enrich runtime: ${data.metadata.runtime}`);
            if (data.metadata.synopsis && !show.synopsis) console.log(`  [dry-run] Would enrich synopsis (${data.metadata.synopsis.length} chars)`);
          }
        }
      } else if (previousScores[show.id] != null) {
        scoreDrops.push(show.id);
      }

      // BRO-4215: a clean scrape that produced no score (no page yet, empty page,
      // identical-to-sibling) is stamped so --skip-fresh-hours doesn't re-fetch it
      // on every orchestrator dispatch. Fetch errors are never stamped.
      if (skipFreshHours > 0 && !dryRun && !shardOutput && !showFetchFailed && !(data && data.score)) {
        audienceBuzz.shows[show.id] = audienceBuzz.shows[show.id] || { sources: {} };
        audienceBuzz.shows[show.id].showScoreLastAttempted = new Date().toISOString();
        saveAudienceBuzz(audienceBuzz);
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
    }

    // Rate limiting
    await sleep(3000);
  }

  // ── Validation guards ──
  if (showsWithUrls.length > 0) {
    const successRate = successful / showsWithUrls.length;
    if (successRate < 0.5) {
      console.error(`\nGUARD: Only ${successful}/${showsWithUrls.length} shows returned scores (${(successRate * 100).toFixed(0)}% < 50% minimum)`);
      console.error('Possible systemic failure. Check ScrapingBee and Show Score status.');
    }
  }

  if (scoreDrops.length > 0) {
    console.warn(`\n⚠ ${scoreDrops.length} shows lost their score this run:`);
    for (const id of scoreDrops) {
      console.warn(`  - ${id} (was: ${previousScores[id]})`);
    }
  }

  if (previousScoredCount > 0 && successful < previousScoredCount - 5) {
    console.warn(`\n⚠ Score count dropped: ${successful} (was ${previousScoredCount}, delta: -${previousScoredCount - successful})`);
  }

  // Log shard summary (data already written incrementally above)
  if (shardOutput) {
    console.log(`\nShard ${shard} output: ${Object.keys(shardOutput.scores).length} scores, ${Object.keys(shardOutput.discoveredUrls).length} URLs`);
  }

  // ── Save shows.json if metadata was enriched ──
  if (metadataEnriched > 0 && !dryRun) {
    saveShows(showsData);
    console.log(`\nshows.json updated with ${metadataEnriched} metadata enrichments.`);
  }

  // Clean up Playwright browser if it was started
  await cleanupPlaywright();

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Show Score data.`);
  if (metadataEnriched > 0) console.log(`  Metadata enriched: ${metadataEnriched} shows (runtime/synopsis)`);
  console.log(`  Cached URLs: ${Object.keys(urlData.shows || {}).length}`);
  console.log(`  Uncached shows: ${uncachedShows.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
