/**
 * Collect Review Texts - Multi-Tier Fallback System
 *
 * TIER 0: Archive.org (for archiveFirstSites - paywalled domains where Archive.org excels)
 * TIER 1: Playwright-extra with stealth plugin + login for paywalls + Google referrer header
 * TIER 1.1: AMP page variant (/amp/ URL — many soft paywalls serve full text on AMP)
 * TIER 1.5: Browserbase (managed browser cloud with CAPTCHA solving) - SPENDING LIMITS APPLY
 * TIER 2: ScrapingBee API
 * TIER 3: Bright Data Web Unlocker
 * TIER 3.6: Archive.today (archive.ph — community-archived paywall bypasses)
 * TIER 4: Archive.org Wayback Machine (final fallback)
 *
 * SUCCESS RATES (Jan 2026 data):
 *   Archive.org:  11.1% (best performer!)
 *   Playwright:    6.7%
 *   Browserbase:   NEW - $0.10/browser hour, has CAPTCHA solving
 *   ScrapingBee:   3.6%
 *   BrightData:    3.7%
 *
 * Environment variables:
 *   NYT_EMAIL, NYT_PASSWORD - New York Times credentials
 *   VULTURE_EMAIL, VULTURE_PASSWORD - Vulture/NY Mag credentials
 *   WAPO_EMAIL, WAPO_PASSWORD - Washington Post credentials
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key
 *   BRIGHTDATA_TOKEN - Bright Data API token
 *   BRIGHTDATA_CUSTOMER_ID - Bright Data customer ID
 *   BROWSERBASE_API_KEY - Browserbase API key (for managed browser cloud)
 *   BROWSERBASE_PROJECT_ID - Browserbase project ID
 *   BROWSERBASE_ENABLED - 'true' to enable Browserbase tier
 *   BROWSERBASE_MAX_SESSIONS_PER_DAY - Daily limit (default: 30 = ~$3/day)
 *   BROWSERBASE_MAX_SESSIONS_PER_RUN - Per-run limit (default: 10)
 *   WSJ_COOKIES - Base64-encoded JSON cookie array for WSJ paywall bypass
 *   NEWYORKER_COOKIES - Base64-encoded JSON cookie array for New Yorker paywall bypass
 *   NYT_COOKIES - Base64-encoded JSON cookie array for NYT paywall bypass
 *   VULTURE_COOKIES - Base64-encoded JSON cookie array for Vulture/NYMag paywall bypass
 *   WAPO_COOKIES - Base64-encoded JSON cookie array for Washington Post paywall bypass
 *   BATCH_SIZE - Reviews per batch (default: 10)
 *   MAX_REVIEWS - Max reviews to process (default: 50, 0 = all)
 *   PRIORITY - 'tier1' or 'all' (default: all)
 *   SHOW_FILTER - Only process specific show ID
 *   RETRY_FAILED - 'true' to retry previously failed reviews
 *   DOMAIN_FILTER - Comma-separated domain(s) to filter by URL (e.g., 'theatermania.com,timeout.com')
 *   EXCLUDE_DOMAINS - Comma-separated domain(s) to exclude (inverse of DOMAIN_FILTER)
 *
 * CLI Flags:
 *   --aggressive - Skip Playwright for known-blocked sites, start with ScrapingBee
 *   --tier=N - Force specific tier (1-4) for testing
 *   --test-url="URL" - Test single URL with all tiers
 */

const fs = require('fs');
const path = require('path');
const { loadCookiesForDomain, hasCookiesForUrl, buildCookieHeaderForUrl, COOKIE_DOMAIN_MAP } = require('./lib/cookie-loader');
const https = require('https');
// const { HttpsProxyAgent } = require('https-proxy-agent'); // Not used - Bright Data needs zone setup

// Catch unhandled promise rejections from playwright-extra stealth plugin
// (cdpSession.send / onPageCreated errors when browser dies mid-operation)
let unhandledRejectionCount = 0;
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  const isPlaywrightCrash = msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Target closed') ||
    msg.includes('Browser has been closed') ||
    msg.includes('Protocol error') ||
    msg.includes('cdpSession.send') ||
    msg.includes('onPageCreated');
  if (isPlaywrightCrash) {
    unhandledRejectionCount++;
    console.log(`  ⚠ Caught browser crash (rejection #${unhandledRejectionCount}): ${msg.slice(0, 100)}`);
    // Don't exit — the main loop's timeout handler will restart the browser
  } else {
    console.error('Unhandled rejection:', msg);
    // For non-Playwright errors, exit after saving state
    if (unhandledRejectionCount > 20) {
      console.error('Too many unhandled rejections, exiting');
      process.exit(1);
    }
  }
});

// Score extraction for original scores
const { extractScore, extractDesignation, OUTLET_VERIFIED_SOURCES } = require('./lib/score-extractors');
const { extractExplicitScore } = require('./lib/llm-score-extractor');

// Text cleaning (entity decoding, junk stripping)
const { cleanText, stripTrailingJunk, TRAILING_JUNK_PATTERNS } = require('./lib/text-cleaning');

// LLM-based content verification
const { verifyContent, quickValidityCheck } = require('./lib/content-verifier');

// Content quality detection (garbage/invalid content filter)
const { assessTextQuality, isGarbageContent, validateShowMentioned, extractByline, matchesCritic, computeContentFingerprint, classifyContentTier, verifyFullTextContent, extractAuthorFromHtml } = require('./lib/content-quality');
const { resolveOutletFromUrl, getOutletDisplayName, generateReviewFilename, normalizeOutlet } = require('./lib/review-normalization');
const { classifyIncompleteReason } = require('./lib/incomplete-reason');
const { isTourReviewExcerpt, isFilmTvReview } = require('./lib/excerpt-validation');
const { isLondonMarket } = require('./lib/venue-classification');
const { shouldSkipScoredReview } = require('./lib/review-guards');

// Domain-specific tier ordering — prioritizes tiers by historical success rate per domain.
// Generated from 30K+ review collection results. Tiers not listed for a domain stay in default order.
const DOMAIN_TIER_ORDER = (() => {
  try {
    return require('./config/domain-tier-order.json');
  } catch { return {}; }
})();

// Domain-specific tier skip list — tiers with 3+ failures and 0 successes per domain.
// These are proven dead ends. Skipping saves 15-30s per tier per review.
const DOMAIN_TIER_SKIP = (() => {
  try {
    return require('./config/domain-tier-skip.json');
  } catch { return {}; }
})();

// Parse CLI arguments
const args = process.argv.slice(2);
const CLI = {
  aggressive: args.includes('--aggressive'),
  forceTier: args.find(a => a.startsWith('--tier='))?.split('=')[1],
  testUrl: args.find(a => a.startsWith('--test-url='))?.split('=')[1],
  stealthProxy: args.includes('--stealth-proxy'), // Use ScrapingBee stealth proxy (25 credits/req)
  // LLM verification now runs by default when ANTHROPIC_API_KEY is available (no opt-in needed)
};

// Dependencies (loaded dynamically)
let chromium, axios;
let stealthLoaded = false;

async function loadDependencies() {
  console.log('Loading dependencies...');

  // Try playwright-extra with stealth
  try {
    const playwrightExtra = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium = playwrightExtra.chromium;
    chromium.use(stealth);
    stealthLoaded = true;
    console.log('✓ Loaded playwright-extra with stealth plugin');
  } catch (e) {
    // Fallback to regular playwright
    console.log('⚠ playwright-extra not available, using regular playwright');
    console.log('  Install with: npm install playwright-extra puppeteer-extra-plugin-stealth');
    const playwright = require('playwright');
    chromium = playwright.chromium;
  }

  // Load axios for API tiers
  try {
    axios = require('axios');
    console.log('✓ Loaded axios for API fallbacks');
  } catch (e) {
    console.log('⚠ axios not available - Tiers 2-4 disabled');
    console.log('  Install with: npm install axios');
  }
}

// Configuration
const CONFIG = {
  batchSize: parseInt(process.env.BATCH_SIZE || '10'),
  pushEveryNBatches: parseInt(process.env.PUSH_EVERY_N_BATCHES || '5'), // Push every N batches (default: every 50 reviews)
  maxReviews: parseInt(process.env.MAX_REVIEWS || '1000'),
  priority: process.env.PRIORITY || 'all',
  showFilter: process.env.SHOW_FILTER || '',
  showFilterSet: new Set((process.env.SHOW_FILTER || '').split(',').map(s => s.trim()).filter(Boolean)),
  retryFailed: process.env.RETRY_FAILED === 'true',
  commitEvery: parseInt(process.env.COMMIT_EVERY || '10'), // Git commit after every N reviews
  outletTier: process.env.OUTLET_TIER || '', // Filter by outlet tier: tier1, tier2, tier3
  contentTierFilter: process.env.CONTENT_TIER_FILTER || '', // Filter by content tier: excerpt, truncated, needs-rescrape
  domainFilter: (process.env.DOMAIN_FILTER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), // Filter by URL domain(s)
  excludeDomains: (process.env.EXCLUDE_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), // Exclude these domains
  incompleteReasonFilter: (process.env.INCOMPLETE_REASON_FILTER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean), // Filter by incompleteReason
  marketFilter: process.env.MARKET_FILTER || '', // Filter by market: west-end, off-broadway (matches show ID suffix)
  reviewFilter: new Set((process.env.REVIEW_FILTER || '').split(',').map(s => s.trim()).filter(Boolean)), // Filter to specific review filenames
  archiveFirst: process.env.ARCHIVE_FIRST !== 'false', // Archive.org first for older reviews (opt-OUT via ARCHIVE_FIRST=false)

  // API Keys
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
  brightDataKey: process.env.BRIGHTDATA_TOKEN || '',
  brightDataCustomerId: process.env.BRIGHTDATA_CUSTOMER_ID || '',
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || '',
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID || '',

  // Browserbase spending limits (to control costs - $0.10/browser hour)
  browserbaseEnabled: process.env.BROWSERBASE_ENABLED === 'true',
  browserbaseMaxSessionsPerDay: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY || '200'), // ~$20/day max (Startup plan: 500h)
  browserbaseMaxSessionsPerRun: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_RUN || '40'), // Per workflow run
  browserbaseMaxSessionsPerDomain: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DOMAIN || '15'), // Prevent one domain starving others
  browserbaseUsageFile: 'data/collection-state/browserbase-usage.json',

  // Directories
  reviewTextsDir: 'data/review-texts',
  archivesDir: 'data/archives/reviews',
  stateDir: 'data/collection-state',
  auditDir: 'data/audit/validation',

  // Tier 1 outlets (highest priority for scoring - weight 1.0)
  tier1Outlets: ['nytimes', 'nyt', 'vulture', 'vult', 'variety', 'hollywood-reporter', 'thr', 'newyorker'],

  // Tier 2 outlets (weight 0.70)
  tier2Outlets: ['theatermania', 'nypost', 'new-york-post', 'time-out', 'timeout', 'wsj', 'wapo', 'washington-post', 'deadline', 'the-wrap', 'thewrap', 'observer', 'daily-beast', 'ew', 'entertainment-weekly', 'guardian'],

  // Tier 3 outlets (weight 0.40 - blogs and smaller sites)
  tier3Outlets: ['theatrely', 'broadway-news', 'cititour', 'culture-sauce', 'stage-and-cinema', 'forward', 'ny-stage-review', 'new-york-stage-review', 'am-new-york', 'chicago-tribune', 'nj-arts', 'dctheatrescene', 'talkin-broadway'],

  // Paywalled domains and their credential env vars
  paywalledDomains: {
    'nytimes.com': { emailVar: 'NYT_EMAIL', passVar: 'NYT_PASSWORD', altPassVar: 'NYTIMES_PASSWORD' },
    'vulture.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'nymag.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'newyorker.com': { emailVar: 'NEW_YORKER_EMAIL', passVar: 'NEW_YORKER_PASSWORD' },
    'washingtonpost.com': { emailVar: 'WAPO_EMAIL', passVar: 'WAPO_PASSWORD', altPassVar: 'WASHPOST_PASSWORD' },
    'wsj.com': { emailVar: 'WSJ_EMAIL', passVar: 'WSJ_PASSWORD' },
    'bloomberg.com': { emailVar: 'BLOOMBERG_EMAIL', passVar: 'BLOOMBERG_PASSWORD' },
    'northjersey.com': { emailVar: 'NORTHJERSEY_EMAIL', passVar: 'NORTHJERSEY_PASSWORD' },
    'usatoday.com': { emailVar: 'NORTHJERSEY_EMAIL', passVar: 'NORTHJERSEY_PASSWORD' },
    // thestage.co.uk: cookie-only auth (no email/password login — avoids session limit)
    'ft.com': { emailVar: 'FT_EMAIL', passVar: 'FT_PASSWORD' },
  },

  // Sites known to block aggressively (skip Playwright, start with ScrapingBee)
  knownBlockedSites: [
    'thewrap.com',
    'theatermania.com', 'observer.com', 'chicagotribune.com',
    'dailybeast.com', 'thedailybeast.com', 'amny.com', 'newsday.com',
    'nypost.com', 'nydailynews.com', 'indiewire.com',
    'nytimes.com',  // DataDome CAPTCHA in headless — skip to Browserbase
    'wsj.com',  // Dow Jones SSO anti-bot detection — fake-rejects correct password in automated browsers
    'newyorker.com',  // Condé Nast id.condenast.com — routes automated browsers to OTP, not password login
    'hollywoodreporter.com', 'variety.com', 'deadline.com', // PMC sites — CAPTCHA-block Playwright consistently
    'bloomberg.com',  // PerimeterX anti-bot — needs Browserbase CAPTCHA solving for login
    'ft.com',  // hCaptcha on login — needs Browserbase CAPTCHA solving
  ],

  // Sites that need residential proxies (Bright Data preferred)
  brightDataPreferred: [
    'nytimes.com', 'vulture.com', 'nymag.com', 'washingtonpost.com',
    'wsj.com', 'newyorker.com',
  ],

  // Sites where Archive.org works best (paywalled sites - Wayback often has pre-paywall content)
  // SUCCESS RATES (2026-01-27): Archive.org 11.1%, Playwright 6.7%, ScrapingBee 3.6%, BrightData 3.7%
  // Archive.org is our MOST SUCCESSFUL scraper - prioritize it for these domains
  archiveFirstSites: [
    // Major paywalled publications
    'nytimes.com', 'vulture.com', 'nymag.com', 'washingtonpost.com',
    'wsj.com', 'newyorker.com', 'ew.com', 'latimes.com',
    // Entertainment/trade publications (free content, but archive useful for old/deleted URLs)
    'rollingstone.com',
    // Regional papers with paywalls
    'chicagotribune.com', 'nypost.com', 'nydailynews.com',
    // Sites where Archive.org has proven successful
    'theatrely.com', 'amny.com', 'forward.com',
    // Sites with CAPTCHA that block Playwright
    'timeout.com',
    // BroadwayNews: WordPress paywall, but Archive.org has excellent coverage (7-8 snapshots per URL)
    'broadwaynews.com',
    // Free outlets with excellent Archive.org coverage (6K+ / 9K+ pages archived)
    'talkinbroadway.com', 'huffpost.com',
    // Hard-paywall sites — Playwright/ScrapingBee/BrightData can't crack these anyway
    'usatoday.com', 'northjersey.com',   // Gannett paywall
    'bloomberg.com',                      // Hard paywall
    'backstage.com',                      // Paywall + JSP URLs
    'thestage.co.uk',                     // UK theater paywall
  ],

  // Minimum word count for valid review
  minWordCount: 300,

  // Timeouts
  loginTimeout: 90000,    // 90s for slow logins
  pageTimeout: 60000,     // 60s for page load
  apiTimeout: 20000,      // 20s for API calls (Archive.org/scrapers respond fast or not at all)
  reviewTimeout: 180000,  // 3 min hard timeout per review (kills hung Playwright)

  // Retry settings
  maxRetries: 3,
  retryDelays: [2000, 4000, 8000], // Exponential backoff

  // Request delays
  requestDelay: 500,      // 500ms between reviews (polite but not wasteful)
  // Note: outletDomains mapping is now derived from outlet-registry.json
  // in url-discovery.js (single source of truth, 1,242 entries)
};

// Uncollectable outlets: built from outlet-registry.json accessModel field.
// Outlets marked 'print-only' or 'defunct' have no online content — skip SERP discovery.
// Single source of truth: outlet-registry.json (shared with collect-outlet-reviews.js).
const UNCOLLECTABLE_OUTLETS = (() => {
  const set = new Set();
  try {
    const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    for (const [id, info] of Object.entries(registry.outlets || {})) {
      if (info.accessModel === 'print-only' || info.accessModel === 'defunct') {
        set.add(id);
      }
    }
    console.log(`Loaded ${set.size} uncollectable outlets from registry (print-only + defunct)`);
  } catch (e) {
    console.warn('Warning: Could not load outlet-registry.json for uncollectable outlets:', e.message);
  }
  return set;
})();

// Domain alias matching — imported from shared lib (scraper.js)
const { domainMatchesExpected, checkScrapingBeeCredits } = require('./lib/scraper');
const { discoverCorrectUrl: _sharedDiscoverUrl } = require('./lib/url-discovery');

// Outlet-specific Playwright wait configurations
// Some outlets render content via JS and need specific selectors/waits
const OUTLET_WAIT_CONFIGS = {
  'broadwaynews.com': {
    waitForSelector: '.entry-content',
    waitTimeout: 20000,
    extraWait: 5000,   // BroadwayNews renders article via JS; extra wait for content
  },
  'broadwayworld.com': {
    waitForSelector: '.article-body, .bsp-article-content',
    waitTimeout: 15000,
    extraWait: 3000,
  },
  'timeout.com': {
    waitForSelector: '[class*="_articleContent_"], [class*="_content_"]',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  // PMC sites (Variety, THR, Deadline) - free content, standard WordPress rendering
  'variety.com': {
    waitForSelector: '.a-content, .entry-content, article',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  'hollywoodreporter.com': {
    waitForSelector: '.a-content, .entry-content, article',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  'deadline.com': {
    waitForSelector: '.entry-content, article',
    waitTimeout: 15000,
    extraWait: 2000,
  },
  // Condé Nast - New Yorker uses specific body container
  'newyorker.com': {
    waitForSelector: '.body__inner-container, [class*="BodyWrapper"]',
    waitTimeout: 20000,
    extraWait: 3000,
  },
};

// ============================================================================
// COOKIE INJECTION (bypass paywall login via exported browser cookies)
// ============================================================================
// Cookie loading is centralized in scripts/lib/cookie-loader.js
// Provides 3-tier fallback: COOKIES_BUNDLE_* → individual env vars → local files

// Domains where login triggers OTC/OTP emails — use cookie injection ONLY, never attempt login
const COOKIE_ONLY_DOMAINS = ['newyorker.com'];

/**
 * Inject cookies into a Playwright browser context.
 * Filters cookies to ensure they have required fields for Playwright's addCookies().
 */
async function injectCookies(browserContext, domain) {
  const cookies = loadCookiesForDomain(domain);
  if (!cookies || cookies.length === 0) return false;

  try {
    // Ensure each cookie has the minimum required fields for Playwright
    const validCookies = cookies
      .filter(c => c.name && c.value && c.domain)
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
        secure: c.secure !== undefined ? c.secure : true,
        sameSite: c.sameSite || 'None',
        // Playwright needs expires as a Unix timestamp (seconds), not ms
        ...(c.expires && c.expires > 0 ? { expires: c.expires > 1e12 ? Math.floor(c.expires / 1000) : c.expires } : {}),
      }));

    if (validCookies.length === 0) {
      console.log(`  ⚠ No valid cookies found for ${domain} (missing name/value/domain)`);
      return false;
    }

    await browserContext.addCookies(validCookies);
    console.log(`  🍪 Injected ${validCookies.length} cookies for ${domain}`);
    return true;
  } catch (e) {
    console.log(`  ⚠ Failed to inject cookies for ${domain}: ${e.message}`);
    return false;
  }
}

// Track domains where cookies have been injected (to skip login)
const cookieInjectedDomains = new Set();

// Statistics tracking
const stats = {
  tier1Attempts: 0,
  tier1Success: 0,
  tier1_5Attempts: 0,  // Browserbase
  tier1_5Success: 0,
  tier2Attempts: 0,
  tier2Success: 0,
  tier3Attempts: 0,
  tier3Success: 0,
  tier3_6Attempts: 0,  // Archive.today
  tier3_6Success: 0,
  tier4Attempts: 0,
  tier4Success: 0,
  ampAttempts: 0,      // AMP variant
  ampSuccess: 0,
  totalFailed: 0,
  scrapingBeePageCredits: 0,
  scrapingBeeSerpCredits: 0,
  browserbaseSessionsUsed: 0,
  browserbaseMinutesUsed: 0,
  // Track failures by outlet for end-of-run reporting
  failuresByOutlet: {},  // { outletName: { count, urls: [], domain, hasCredentials, isPaywalled } }
  // URL discovery stats
  urlDiscoveryAttempts: 0,
  urlDiscoverySuccess: 0,
  urlDiscoveryCapped: 0,  // Skipped due to per-run cap
  urlDiscoveryDetails: [],  // { reviewId, oldUrl, newUrl }
};

// State tracking
let state = {
  processed: [],
  failed: [],
  skipped: [],
  tierBreakdown: {
    playwright: [],
    amp: [],
    browserbase: [],
    directCookies: [],
    scrapingbee: [],
    brightdata: [],
    archiveToday: [],
    archive: [],
  },
  startTime: new Date().toISOString(),
  lastProcessed: null,
  log: [],  // Recent activity log for real-time monitoring
};

// Browserbase usage tracking (persisted to disk)
let browserbaseUsage = {
  date: new Date().toISOString().split('T')[0],
  sessionsToday: 0,
  sessionsThisRun: 0,
  minutesToday: 0,
  sessionsPerDomain: {},  // { 'wsj.com': 3, 'nytimes.com': 2, ... } — per-run cap prevents starvation
  history: [],
};

// Archive.org rate-limit tracking (backoff with cooldown instead of permanent disable)
let archiveOrgConsecutiveFailures = 0;
let archiveOrgDisabledForBatch = false;
let archiveOrgCooldownCount = 0; // How many times we've hit the cooldown threshold
let archiveOrgLastRequestTime = 0; // Timestamp of last Archive.org API call
const ARCHIVE_ORG_MIN_DELAY_MS = 1500; // 1.5s between requests to avoid rate limits
const ARCHIVE_ORG_COOLDOWN_THRESHOLD = 3; // Consecutive failures before cooldown
const ARCHIVE_ORG_COOLDOWN_MS = 15000; // 15s cooldown after hitting threshold
const ARCHIVE_ORG_MAX_COOLDOWNS = 3; // After 3 cooldowns (9+ failures), disable for batch

// Browser and context (reused)
let browser = null;
let context = null;
let page = null;
const loggedInDomains = new Set();
let browserCrashCount = 0;
const MAX_BROWSER_CRASHES = 5;

// ============================================================================
// PAGE HELPERS (scroll, paywall dismissal)
// ============================================================================

/**
 * Scroll to bottom of page to trigger lazy-loaded content.
 * Uses incremental scrolling to mimic human behavior and trigger scroll-based loaders.
 */
async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight || totalHeight > 15000) {
            clearInterval(timer);
            // Scroll back to top so extraction starts from beginning
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });
  } catch (e) {
    // Non-fatal - continue with extraction even if scroll fails
  }
}

/**
 * Try to dismiss paywall overlays and expand hidden article content.
 * Handles common paywall patterns from NYT, Vulture/Condé Nast, WSJ, WaPo.
 */
async function dismissPaywallOverlays(page) {
  try {
    await page.evaluate(() => {
      // Remove common paywall overlay elements
      const overlaySelectors = [
        // NYT
        '[data-testid="paywall"]', '[data-testid="inline-message"]',
        '#gateway-content', '.css-mcm29f', '[class*="paywall"]',
        // Condé Nast (Vulture, New Yorker, NY Mag)
        '[class*="PaywallBarrier"]', '[class*="paywall-bar"]',
        '[data-testid="PaywallBarrier"]', '.paywall-bar',
        '[class*="PaywallModal"]', '.paywall-modal',
        '[class*="consumer-marketing-unit"]',
        '[class*="RecircList"]', '.recirc-list-wrapper',
        // WSJ
        '.wsj-snippet-login', '#cx-snippet-overlay', '[class*="snippet"]',
        // WaPo
        '[data-qa="subscribe-promo"]', '.paywall-overlay',
        // Generic
        '[id*="paywall"]', '[class*="subscription-wall"]',
        '[class*="meter-"]', '.overlay-gate', '#piano-modal',
        '[class*="PianoBarrier"]',
      ];

      for (const sel of overlaySelectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }

      // Unhide article content that may be CSS-hidden behind paywall
      const hiddenContentSelectors = [
        // NYT: article body paragraphs after paywall cutoff
        'article p[style*="display: none"]',
        'article p[style*="visibility: hidden"]',
        // Generic hidden sections
        '[class*="article-body"] [hidden]',
        '[class*="ArticleBody"] [hidden]',
        '[data-testid="article-body"] [hidden]',
      ];

      for (const sel of hiddenContentSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          el.style.display = '';
          el.style.visibility = '';
          el.removeAttribute('hidden');
        });
      }

      // Remove overflow:hidden from body (some paywalls lock scrolling)
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';

      // Try to expand "continue reading" or "read more" sections
      const expandButtons = document.querySelectorAll(
        '[class*="continue-reading"], [class*="read-more"], [class*="expand"], [data-testid="continue-reading"]'
      );
      expandButtons.forEach(btn => {
        try { btn.click(); } catch(e) {}
      });
    });

    // Brief wait for any content expansion to render
    await page.waitForTimeout(500);
  } catch (e) {
    // Non-fatal
  }
}

// ============================================================================
// TIER 1: Playwright with Stealth Plugin
// ============================================================================

async function fetchWithPlaywright(url, review) {
  stats.tier1Attempts++;

  // Ensure browser is healthy before attempting
  const browserOk = await ensureBrowserHealthy();
  if (!browserOk) {
    throw new Error('Browser unavailable - too many crashes');
  }

  // Check for paywall and login if needed
  // Skip login entirely if cookies exist for this domain (avoids OTC email spam)
  // Also skip login for domains that route automated browsers to OTP (use cookies only)
  const paywallCreds = getPaywallCredentials(url);
  const hasCookiesForDomain = paywallCreds && hasCookiesForUrl(url);
  const isCookieOnlyDomain = paywallCreds && COOKIE_ONLY_DOMAINS.includes(paywallCreds.domain);
  if (paywallCreds && paywallCreds.email && !loggedInDomains.has(paywallCreds.domain) && !hasCookiesForDomain && !isCookieOnlyDomain) {
    const loginSuccess = await loginToSite(paywallCreds.domain, paywallCreds.email, paywallCreds.password);
    if (loginSuccess) {
      loggedInDomains.add(paywallCreds.domain);
    }
  }

  // Navigate with retry logic
  let lastError = null;
  for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`    Retry ${attempt + 1}/${CONFIG.maxRetries}...`);
        await sleep(CONFIG.retryDelays[attempt - 1]);

        // Re-check browser health before retry
        const retryBrowserOk = await ensureBrowserHealthy();
        if (!retryBrowserOk) {
          throw new Error('Browser unavailable after crash');
        }
      }

      // Set Google referrer to bypass metered paywalls (many soft paywalls allow search traffic)
      await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com/' });

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.pageTimeout,
      });

      // Check for outlet-specific wait configuration
      const urlDomain = new URL(url).hostname.replace(/^www\./, '');
      const outletWait = OUTLET_WAIT_CONFIGS[urlDomain];

      if (outletWait) {
        // Use outlet-specific wait strategy (e.g., BroadwayNews JS rendering)
        await page.waitForSelector(outletWait.waitForSelector, {
          timeout: outletWait.waitTimeout,
        }).catch(() => {});
        if (outletWait.extraWait) {
          await page.waitForTimeout(outletWait.extraWait);
        }
      } else {
        // Generic wait for content to load
        await Promise.race([
          page.waitForSelector('article', { timeout: 15000 }),
          page.waitForSelector('[class*="article"]', { timeout: 15000 }),
          page.waitForSelector('[class*="story"]', { timeout: 15000 }),
          page.waitForSelector('main p', { timeout: 15000 }),
          page.waitForTimeout(10000),
        ]).catch(() => {});
      }

      // Scroll to bottom to trigger lazy-loaded content
      await autoScroll(page);

      // Additional wait for JS rendering after scroll
      await page.waitForTimeout(2000);

      // Dismiss paywall overlays and expand hidden content
      await dismissPaywallOverlays(page);

      // Verify we're on the expected domain (prevents cross-domain contamination
      // from redirects, ad interstitials, or stale page state)
      const actualUrl = page.url();
      if (!actualUrl || actualUrl === 'about:blank' || actualUrl.startsWith('chrome-error')) {
        throw new Error(`Page failed to load: ${actualUrl || '(empty)'}`);
      }
      try {
        const expectedDomain = new URL(url).hostname.replace(/^www\./, '');
        const actualDomain = new URL(actualUrl).hostname.replace(/^www\./, '');
        if (!domainMatchesExpected(expectedDomain, actualDomain)) {
          throw new Error(`Domain mismatch: expected ${expectedDomain} but landed on ${actualDomain} (${actualUrl})`);
        }
      } catch (e) {
        if (e.message.startsWith('Domain mismatch') || e.message.startsWith('Page failed')) throw e;
        // Fail open on URL parse errors (don't block on edge cases)
      }

      // Get page content
      const html = await page.content();

      // Check for blocking/CAPTCHA
      if (isBlocked(html)) {
        throw new Error('CAPTCHA or access blocked');
      }

      // Check for paywall text (not fully logged in)
      if (isPaywalled(html)) {
        throw new Error('Paywall detected - login may have failed');
      }

      // Check for 404
      const title = await page.title();
      if (title.toLowerCase().includes('404') || title.toLowerCase().includes('not found')) {
        throw new Error('404 - Page not found');
      }

      // Extract text
      const text = await extractArticleText(page);

      if (text && text.length > 500) {
        stats.tier1Success++;
        return { html, text };
      }

      throw new Error(`Insufficient text extracted: ${text?.length || 0} chars`);

    } catch (e) {
      lastError = e;
      if (e.message.includes('404')) {
        throw e; // Don't retry 404s
      }
      // Detect browser crash errors
      if (e.message.includes('Target page, context or browser has been closed') ||
          e.message.includes('Target closed') ||
          e.message.includes('Browser has been closed') ||
          e.message.includes('Protocol error')) {
        console.log(`    ⚠ Browser crash detected, will restart...`);
        // Don't count this as a regular failure - let health check handle it
      }
    }
  }

  throw lastError || new Error('Playwright failed after all retries');
}

async function loginToSite(domain, email, password) {
  console.log(`    → Logging in to ${domain}...`);

  try {
    if (domain === 'nytimes.com') {
      // NYT login is behind DataDome CAPTCHA - headless Playwright cannot solve it.
      // Strategy: Navigate to the login page. If CAPTCHA is detected, skip login
      // and rely on Archive.org / other tiers for NYT content.
      // Browserbase (Tier 1.5) has CAPTCHA solving and handles NYT separately.
      await page.goto('https://myaccount.nytimes.com/auth/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Check for CAPTCHA / bot detection (DataDome)
      const hasCaptcha = await page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe');
        for (const f of iframes) {
          if (f.src && f.src.includes('captcha-delivery.com')) return true;
        }
        const text = document.body?.innerText || '';
        if (text.includes('confirm that you are human') || text.includes('Slide right to complete')) return true;
        return false;
      });

      if (hasCaptcha) {
        console.log('    ✗ NYT login blocked by CAPTCHA (DataDome) - skipping Playwright login');
        console.log('      → NYT articles will use Archive.org or Browserbase (CAPTCHA-solving) tiers');
        return false;
      }

      // If no CAPTCHA, try the standard login flow
      const emailInput = await page.$('input[name="email"], input[type="email"], #email');
      if (emailInput) {
        await emailInput.type(email, { delay: 50 });
        await page.click('button[data-testid="submit-email"], button[type="submit"]').catch(() => {});
        await page.waitForTimeout(3000);

        const passInput = await page.$('input[name="password"], input[type="password"]');
        if (passInput) {
          await passInput.type(password, { delay: 50 });
          await page.click('button[data-testid="login-button"], button[type="submit"]').catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }

      const verified = await page.evaluate(() => {
        const userMenu = document.querySelector('[data-testid="user-menu"], [data-testid="user-settings-button"]');
        const loginForm = document.querySelector('input[name="email"]');
        const errorMsg = document.querySelector('[data-testid="error-message"]');
        return { hasUserMenu: !!userMenu, hasLoginForm: !!loginForm, hasError: !!errorMsg };
      });

      if (verified.hasUserMenu) {
        console.log('    ✓ NYT login verified (user menu found)');
        return true;
      }
      if (verified.hasError) {
        console.log('    ✗ NYT login FAILED (error message shown - check credentials)');
        return false;
      }
      if (!verified.hasLoginForm) {
        console.log('    ✓ NYT login likely succeeded (login form gone)');
        return true;
      }
      console.log('    ⚠ NYT login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'newyorker.com') {
      // The New Yorker uses Condé Nast centralized auth at id.condenast.com
      // Separate subscription from Vulture/NYMag despite both being Condé Nast
      // Two-step flow: 1) enter email + "Continue with e-mail", 2) enter password + "Sign in"
      const loginUrl = 'https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB';
      try {
        await page.goto(loginUrl, { timeout: CONFIG.loginTimeout });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      } catch(e) {
        console.log('    ✗ New Yorker login FAILED (could not load id.condenast.com)');
        return false;
      }

      // Step 1: Enter email
      const emailField = await page.$('input[type="email"], input[name="email"], [role="textbox"]');
      if (!emailField) {
        console.log('    ✗ New Yorker login FAILED (no email field found)');
        return false;
      }
      await emailField.click();
      await emailField.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Continue with e-mail" button
      const continueBtn = await page.$('button:has-text("Continue with e-mail"), button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(5000);

      // Step 2: Enter password
      const passwordField = await page.$('input[type="password"]');
      if (!passwordField) {
        console.log('    ✗ New Yorker login FAILED (no password field - may need different auth method)');
        return false;
      }
      await passwordField.click();
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Sign in" button
      const signInBtn = await page.$('button:has-text("Sign in"), button[type="submit"]');
      if (signInBtn) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);

      // Verify: should have redirected to newyorker.com
      const postLoginUrl = page.url();
      if (postLoginUrl.includes('newyorker.com') && !postLoginUrl.includes('id.condenast.com')) {
        console.log('    ✓ New Yorker login verified (redirected to newyorker.com)');
        return true;
      }
      // Check for errors
      const hasError = await page.$('[class*="error"], [class*="Error"], [role="alert"]').catch(() => null);
      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ New Yorker login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      console.log('    ⚠ New Yorker login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'vulture.com' || domain === 'nymag.com') {
      // NY Magazine / Vox Media centralized auth at subs.nymag.com
      // Two-step flow: 1) enter email + submit, 2) enter password + sign in
      const loginUrl = 'https://subs.nymag.com/account';
      try {
        await page.goto(loginUrl, { timeout: CONFIG.loginTimeout });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      } catch(e) {
        console.log('    ✗ Vulture login FAILED (could not load subs.nymag.com/account)');
        return false;
      }

      // Step 1: Enter email and submit
      // IMPORTANT: Must use type() not fill() - the "Submit Email" button is disabled
      // until React detects input events, which fill() doesn't trigger
      const emailField = await page.$('input[type="email"], input[name="email"], [role="textbox"]');
      if (!emailField) {
        console.log('    ✗ Vulture login FAILED (no email field found on subs.nymag.com)');
        return false;
      }
      await emailField.click();
      await emailField.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Submit Email" button (should now be enabled after typing)
      const submitEmailBtn = await page.$('button:has-text("Submit Email"):not([disabled])');
      if (submitEmailBtn) {
        await submitEmailBtn.click();
      } else {
        // Fallback: try pressing Enter
        console.log('    ⚠ Submit Email button still disabled, trying Enter key');
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password (page transitions to password form)
      const passwordField = await page.$('input[type="password"]');
      if (!passwordField) {
        console.log('    ✗ Vulture login FAILED (no password field after email submit - may be magic link flow)');
        return false;
      }
      await passwordField.click();
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Sign In" button
      const signInBtn = await page.$('button:has-text("Sign In"), button[type="submit"]');
      if (signInBtn) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Verify login success
      const postLoginUrl = page.url();
      const hasError = await page.$('[class*="error"], [class*="Error"], [role="alert"]').catch(() => null);

      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ Vulture login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      // Success if redirected away from account page or if URL contains account (logged in state)
      if (!postLoginUrl.includes('subs.nymag.com/account') || postLoginUrl.includes('#/account')) {
        console.log('    ✓ Vulture login verified (authenticated via subs.nymag.com)');
        return true;
      }
      // Check for user-specific elements that indicate logged-in state
      const userElement = await page.$('[class*="account"], [class*="profile"], [class*="user"]').catch(() => null);
      if (userElement) {
        console.log('    ✓ Vulture login verified (user element detected)');
        return true;
      }
      console.log('    ⚠ Vulture login uncertain (still on account page) - continuing anyway');
      return true;
    }

    if (domain === 'washingtonpost.com') {
      // WaPo uses a two-step login: email → "Next" button → password → submit
      await page.goto('https://www.washingtonpost.com/subscribe/signin/', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Step 1: Enter email
      const emailInput = await page.$('input[type="email"], input[name="email"], [role="textbox"]');
      if (!emailInput) {
        console.log('    ✗ WaPo login FAILED (no email field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Next" button (not "submit")
      const nextBtn = await page.$('button:has-text("Next"), button:has-text("Sign in"), button[type="submit"]');
      if (nextBtn) {
        await nextBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password (page transitions to password form)
      const passInput = await page.$('input[type="password"], input[name="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);

        // Click sign in button
        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Submit"), button[type="submit"]');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('    ✗ WaPo login FAILED (no password field after email step)');
        return false;
      }

      // Verify: check if redirected away from signin or user indicator appears
      const postUrl = page.url();
      const signedIn = !postUrl.includes('signin');
      const hasUserEl = await page.$('[data-qa="user-button"], [class*="signed-in"], [data-testid="user"]').catch(() => null);
      const hasError = await page.$('[class*="error"], [data-testid="error"]').catch(() => null);

      if (hasError) {
        console.log('    ✗ WaPo login FAILED (error shown - check credentials)');
        return false;
      }
      if (hasUserEl || signedIn) {
        console.log('    ✓ WaPo login verified');
        return true;
      }
      console.log('    ⚠ WaPo login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'bloomberg.com') {
      // Bloomberg two-step login: email → "Continue" → password → "Sign in"
      // Has PerimeterX (PX) anti-bot detection — Playwright may be blocked
      await page.goto('https://www.bloomberg.com/account/signin', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // Dismiss consent modal if present (Bloomberg shows "We've updated our terms" overlay)
      const consentBtn = await page.$('#cmp-consent-modal button, button:has-text("Accept All"), button:has-text("I Agree")');
      if (consentBtn) {
        const isVisible = await consentBtn.isVisible().catch(() => false);
        if (isVisible) {
          console.log('    → Dismissing Bloomberg consent modal...');
          await consentBtn.click();
          await page.waitForTimeout(2000);
        }
      }

      // Check for PerimeterX challenge
      const hasPxChallenge = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return text.includes('Press & Hold') || text.includes('Human Challenge') ||
               !!document.querySelector('#px-captcha, [id*="perimeterx"]');
      });
      if (hasPxChallenge) {
        console.log('    ✗ Bloomberg login blocked by PerimeterX — skipping Playwright login');
        console.log('      → Bloomberg articles will use cookies or Browserbase tier');
        return false;
      }

      // Step 1: Enter email
      const emailInput = await page.$('input[type="text"][placeholder*="email"], input[type="email"], input[name="email"]');
      if (!emailInput) {
        console.log('    ✗ Bloomberg login FAILED (no email field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Continue" button
      const continueBtn = await page.$('button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);

        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Continue"), button[type="submit"]');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('    ✗ Bloomberg login FAILED (no password field after email step)');
        return false;
      }

      // Verify: check if redirected away from signin or user indicator appears
      const postUrl = page.url();
      const hasError = await page.$('[class*="error"], [data-testid="error"], [role="alert"]').catch(() => null);
      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ Bloomberg login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      if (!postUrl.includes('/account/signin')) {
        console.log('    ✓ Bloomberg login verified (left signin page)');
        return true;
      }
      console.log('    ⚠ Bloomberg login uncertain - continuing anyway');
      return true;
    }

    if (domain === 'northjersey.com' || domain === 'usatoday.com') {
      const returnUrl = domain === 'northjersey.com' ? 'https://www.northjersey.com/' : 'https://www.usatoday.com/';
      await page.goto(`https://login.usatoday.com/?return-url=${encodeURIComponent(returnUrl)}`, { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const emailInput = await page.$('input[type="email"], input[name="email"], input[id*="email"]');
      if (!emailInput) { console.log(`    ✗ ${domain} login FAILED (no email field)`); return false; }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);
      const passInput = await page.$('input[type="password"], input[name="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);
        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
        if (signInBtn) await signInBtn.click();
        else await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else { console.log(`    ✗ ${domain} login FAILED (no password field)`); return false; }
      const postUrl = page.url();
      if (!postUrl.includes('login.usatoday.com')) { console.log(`    ✓ ${domain} login verified`); return true; }
      console.log(`    ⚠ ${domain} login uncertain - continuing`);
      return true;
    }

    if (domain === 'thestage.co.uk') {
      await page.goto('https://www.thestage.co.uk/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const cookieBtn = await page.$('button:has-text("Accept All Cookies"), button:has-text("Accept All"), button:has-text("Accept")');
      if (cookieBtn) { const v = await cookieBtn.isVisible().catch(() => false); if (v) { console.log('    → Dismissing cookie consent...'); await cookieBtn.click(); await page.waitForTimeout(1000); } }
      // /login has two forms (main + nav) — find the visible one
      const emailInputs = await page.$$('input[type="email"], input[name="email"], input[id*="email"]');
      let emailInput = null;
      for (const inp of emailInputs) { if (await inp.isVisible().catch(() => false)) { emailInput = inp; break; } }
      if (!emailInput) { console.log('    ✗ The Stage login FAILED (no visible email field)'); return false; }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);
      const passInputs = await page.$$('input[type="password"], input[name="password"]');
      let passInput = null;
      for (const inp of passInputs) { if (await inp.isVisible().catch(() => false)) { passInput = inp; break; } }
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);
        const signInBtns = await page.$$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), button[type="submit"], input[type="submit"]');
        let signInBtn = null;
        for (const btn of signInBtns) { if (await btn.isVisible().catch(() => false)) { signInBtn = btn; break; } }
        if (signInBtn) await signInBtn.click();
        else await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else { console.log('    ✗ The Stage login FAILED (no visible password field)'); return false; }
      const postUrl = page.url();
      if (!postUrl.includes('/login')) { console.log('    ✓ The Stage login verified'); return true; }
      console.log('    ⚠ The Stage login uncertain - continuing');
      return true;
    }

    if (domain === 'ft.com') {
      await page.goto('https://accounts.ft.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const hasHcaptcha = await page.$('iframe[src*="hcaptcha"], .h-captcha, [data-hcaptcha-widget-id]');
      if (hasHcaptcha) { console.log('    ✗ FT login blocked by hCaptcha — skipping Playwright'); return false; }
      const emailInput = await page.$('input[type="email"], input[name="email"], input[id*="email"]');
      if (!emailInput) { console.log('    ✗ FT login FAILED (no email field)'); return false; }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);
      const nextBtn = await page.$('button:has-text("Next"), button:has-text("Enter"), button[type="submit"]');
      if (nextBtn) await nextBtn.click();
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      const passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);
        const signInBtn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]');
        if (signInBtn) await signInBtn.click();
        else await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else { console.log('    ✗ FT login FAILED (no password field)'); return false; }
      const postUrl = page.url();
      if (!postUrl.includes('accounts.ft.com')) { console.log('    ✓ FT login verified'); return true; }
      console.log('    ⚠ FT login uncertain - continuing');
      return true;
    }

    if (domain === 'wsj.com') {
      // WSJ redirects to sso.accounts.dowjones.com for login
      // Two-step: email/username → "Continue" button → password → "Continue" button
      await page.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000); // Allow redirect to sso.accounts.dowjones.com

      // Step 1: Enter email/username
      // WSJ uses name="emailOrUsername" and id="emailOrUsername-form-item"
      const emailInput = await page.$('input[name="emailOrUsername"], input#emailOrUsername-form-item, input[type="email"], input[name="username"], input[name="email"]');
      if (!emailInput) {
        console.log('    ✗ WSJ login FAILED (no email/username field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Continue" button (WSJ uses "Continue" not "Submit" on email step)
      const continueBtn = await page.$('button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password
      const passInput = await page.$('input[type="password"], input[name="password"]');
      if (passInput) {
        await passInput.click();
        await passInput.type(password, { delay: 30 });
        await page.waitForTimeout(500);

        // Click Sign In for password step (prefer "Sign In" over "Continue" to avoid re-clicking email step)
        const signInBtn = await page.$('button:has-text("Sign In"), button:has-text("Continue"), button[type="submit"]');
        if (signInBtn) {
          await signInBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('    ✗ WSJ login FAILED (no password field after email step)');
        return false;
      }

      // Verify: check if redirected away from SSO domain (hostname-based)
      const postUrl = page.url();
      const postHost = new URL(postUrl).hostname;
      const leftSso = !postHost.includes('accounts.dowjones.com') && !postHost.includes('accounts.wsj.com');
      const hasError = await page.$('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error').catch(() => null);

      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ WSJ login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      if (leftSso) {
        console.log('    ✓ WSJ login verified (left SSO domain)');
        return true;
      }
      console.log('    ⚠ WSJ login uncertain (still on SSO domain) - continuing anyway');
      return true;
    }

    return false;
  } catch (e) {
    console.log(`    ✗ Login error: ${e.message}`);
    return false;
  }
}

// ============================================================================
// TIER 1.5: Browserbase (Managed Browser Cloud with CAPTCHA solving)
// Cost: $0.10/browser hour - USE SPARINGLY with spending limits
// ============================================================================

/**
 * Login to paywalled sites via Browserbase (same flow as Playwright but with CAPTCHA solving).
 * Supports WSJ, NYT, WaPo, Vulture/NYMag. Returns true if login appears successful.
 */
async function browserbaseLogin(bbPage, domain, email, password) {
  if (domain === 'wsj.com') {
    // WSJ uses Dow Jones SSO - an SPA that requires JS rendering
    // accounts.wsj.com/login redirects to sso.accounts.dowjones.com
    // The SSO page has DataDome CAPTCHA - Browserbase's solveCaptchas handles it
    console.log(`    → Browserbase: navigating to WSJ login...`);
    await bbPage.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout, waitUntil: 'domcontentloaded' });

    // Check for and wait for CAPTCHA resolution (DataDome on Dow Jones SSO)
    const hasCaptcha = await bbPage.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        if (f.src && f.src.includes('captcha-delivery.com')) return true;
      }
      return false;
    });
    if (hasCaptcha) {
      console.log(`    → CAPTCHA detected on WSJ login - waiting for Browserbase to solve...`);
      // Wait for the CAPTCHA iframe to disappear (Browserbase solves it automatically)
      try {
        await bbPage.waitForFunction(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && f.src.includes('captcha-delivery.com')) return false;
          }
          return true;
        }, { timeout: 45000 });
        console.log(`    → CAPTCHA resolved, proceeding with login...`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ CAPTCHA not resolved after 45s - continuing anyway`);
      }
    }

    // Wait for the SPA to render the login form (up to 30s)
    const currentUrl = bbPage.url();
    console.log(`    → WSJ login page URL: ${currentUrl.substring(0, 80)}`);

    // Dump page title and visible inputs for diagnostics
    const pageInfo = await bbPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 30));
      const errorMsg = document.querySelector('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error');
      return { title: document.title, inputs, buttons, error: errorMsg?.textContent?.trim() };
    });
    console.log(`    → WSJ page title: "${pageInfo.title}"`);
    console.log(`    → WSJ form inputs: ${JSON.stringify(pageInfo.inputs)}`);
    console.log(`    → WSJ buttons: ${JSON.stringify(pageInfo.buttons)}`);
    if (pageInfo.error) console.log(`    → WSJ error on page: "${pageInfo.error}"`);

    let emailInput = null;
    // Try broad set of selectors including generic text input
    const emailSelectors = 'input[type="email"], input[name="email"], input[name="emailOrUsername"], input[name="username"], input[type="text"]:not([name="search"])';
    try {
      await bbPage.waitForSelector(emailSelectors, { timeout: 30000 });
      emailInput = await bbPage.$(emailSelectors);
    } catch (e) {
      console.log(`    → WSJ login SPA slow to render, waiting...`);
      await bbPage.waitForTimeout(10000);
      emailInput = await bbPage.$(emailSelectors);
    }
    if (!emailInput) {
      console.log(`    ✗ WSJ login FAILED (no email/username field found after CAPTCHA wait)`);
      return false;
    }
    console.log(`    → Found email input, typing credentials...`);
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);

    const continueBtn = await bbPage.$('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]');
    if (continueBtn) {
      console.log(`    → Clicking continue/sign-in button...`);
      await continueBtn.click();
    } else {
      console.log(`    → No continue button found, pressing Enter...`);
      await bbPage.keyboard.press('Enter');
    }

    // Wait for password step (Dow Jones SSO is two-step)
    let passInput = null;
    try {
      await bbPage.waitForSelector('input[type="password"]', { timeout: 15000 });
      passInput = await bbPage.$('input[type="password"]');
    } catch (e) {
      await bbPage.waitForTimeout(5000);
      passInput = await bbPage.$('input[type="password"]');
    }
    if (!passInput) {
      // Dump current page state for debugging
      const postEmailUrl = bbPage.url();
      const postEmailInfo = await bbPage.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name }));
        const errorMsg = document.querySelector('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error');
        return { inputs, error: errorMsg?.textContent?.trim() };
      });
      console.log(`    ✗ WSJ login FAILED (no password field found)`);
      console.log(`    → Post-email URL: ${postEmailUrl.substring(0, 80)}`);
      console.log(`    → Post-email inputs: ${JSON.stringify(postEmailInfo.inputs)}`);
      if (postEmailInfo.error) console.log(`    → Post-email error: "${postEmailInfo.error}"`);
      return false;
    }
    console.log(`    → Found password input, typing...`);
    await passInput.click();
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    // Dump pre-submit state to diagnose button targeting
    const preSubmitInfo = await bbPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
        type: i.type, name: i.name, visible: i.offsetParent !== null,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().substring(0, 40),
        visible: b.offsetParent !== null, type: b.type,
      }));
      return { inputs, buttons };
    });
    console.log(`    → Pre-submit buttons: ${JSON.stringify(preSubmitInfo.buttons)}`);

    // Use password field's closest form to find the right submit button
    // Avoid re-clicking the email "Continue" — prefer "Sign In"/"Log In" first
    let signInBtn = await bbPage.$('button:has-text("Sign In"), button:has-text("Log In")');
    if (!signInBtn) {
      // Fall back to submit button near the password field
      signInBtn = await bbPage.$('input[type="password"] ~ button, input[type="password"] + div button, button[type="submit"]');
    }
    if (!signInBtn) {
      // Last resort: any Continue button
      signInBtn = await bbPage.$('button:has-text("Continue")');
    }
    if (signInBtn) {
      const btnText = await signInBtn.evaluate(el => el.textContent?.trim());
      console.log(`    → Clicking button: "${btnText}"...`);
      await signInBtn.click();
    } else {
      console.log(`    → No submit button found, pressing Enter on password field...`);
      await passInput.press('Enter');
    }
    // Wait for redirect away from SSO domain (hostname-based, not URL path)
    // The SSO URL always contains /login-page and #/signin-password, so path checks always fail
    let leftSsoDomain = false;
    try {
      await bbPage.waitForFunction(() => {
        const host = window.location.hostname;
        return !host.includes('accounts.dowjones.com') && !host.includes('accounts.wsj.com');
      }, { timeout: 30000 });
      leftSsoDomain = true;
      console.log(`    → WSJ redirect completed (left SSO domain)`);
    } catch (e) {
      console.log(`    → WSJ still on SSO domain after 30s, checking page state...`);
    }

    // Full post-login diagnostic dump
    const postUrl = bbPage.url();
    const postLoginInfo = await bbPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
        type: i.type, name: i.name, id: i.id, visible: i.offsetParent !== null,
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim().substring(0, 40), visible: b.offsetParent !== null,
      }));
      // Get all visible text (first 500 chars) to detect OTP prompts, errors, etc.
      const bodyText = document.body?.innerText?.substring(0, 500) || '';
      const hasOtpPrompt = bodyText.includes('passcode') || bodyText.includes('verification') || bodyText.includes('one-time');
      const errorEls = document.querySelectorAll('.error-message, [class*="error-text"], [role="alert"][class*="error"], .message--error');
      const errors = Array.from(errorEls).map(e => e.textContent?.trim().substring(0, 100)).filter(t => t && t.length > 2);
      return { title: document.title, inputs, buttons, bodyText, hasOtpPrompt, errors };
    });
    console.log(`    → Post-login URL: ${postUrl.substring(0, 100)}`);
    console.log(`    → Post-login title: "${postLoginInfo.title}"`);
    if (postLoginInfo.errors.length) console.log(`    → Post-login errors: ${JSON.stringify(postLoginInfo.errors)}`);

    // Check for OTP prompt (unrecoverable - need user interaction)
    if (postLoginInfo.hasOtpPrompt) {
      console.log(`    ✗ WSJ login requires OTP/verification - cannot proceed automatically`);
      return false;
    }

    if (leftSsoDomain) {
      console.log(`    ✓ WSJ login succeeded`);
      return true;
    }

    // Still on SSO but no errors or OTP - may have succeeded (session cookie set)
    // Let the article fetch determine real success
    if (!postLoginInfo.errors.length) {
      console.log(`    ⚠ WSJ login uncertain (still on SSO domain) - continuing`);
      return true;
    }

    console.log(`    ✗ WSJ login failed (errors on SSO page)`);
    return false;
  }

  if (domain === 'newyorker.com') {
    // The New Yorker uses Condé Nast centralized auth at id.condenast.com
    console.log(`    → Browserbase: navigating to New Yorker login...`);
    await bbPage.goto('https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    const emailInput = await bbPage.$('input[type="email"], input[name="email"], [role="textbox"]');
    if (!emailInput) {
      console.log(`    ✗ New Yorker login FAILED (no email field on id.condenast.com)`);
      return false;
    }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(1000);

    const continueBtn = await bbPage.$('button:has-text("Continue with e-mail"), button:has-text("Continue"), button[type="submit"]');
    if (continueBtn) await continueBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForTimeout(5000);

    const passInput = await bbPage.$('input[type="password"]');
    if (!passInput) {
      console.log(`    ✗ New Yorker login FAILED (no password field after email step)`);
      return false;
    }
    await passInput.click();
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    const signInBtn = await bbPage.$('button:has-text("Sign in"), button[type="submit"]');
    if (signInBtn) await signInBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await bbPage.waitForTimeout(5000);

    const postUrl = bbPage.url();
    if (postUrl.includes('newyorker.com') && !postUrl.includes('id.condenast.com')) {
      console.log(`    ✓ New Yorker login succeeded (via Browserbase)`);
      return true;
    }
    console.log(`    ⚠ New Yorker login uncertain (URL: ${postUrl.substring(0, 80)}) - continuing`);
    return true;
  }

  if (domain === 'bloomberg.com') {
    console.log(`    → Browserbase: navigating to Bloomberg login...`);
    await bbPage.goto('https://www.bloomberg.com/account/signin', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    // Dismiss consent modal if present (Bloomberg shows "We've updated our terms" overlay)
    const bbConsentBtn = await bbPage.$('#cmp-consent-modal button, button:has-text("Accept All"), button:has-text("I Agree")');
    if (bbConsentBtn) {
      const isVisible = await bbConsentBtn.isVisible().catch(() => false);
      if (isVisible) {
        console.log(`    → Dismissing Bloomberg consent modal...`);
        await bbConsentBtn.click();
        await bbPage.waitForTimeout(2000);
      }
    }

    // Check for PerimeterX challenge — Browserbase should auto-solve
    const hasPxChallenge = await bbPage.evaluate(() => {
      return !!document.querySelector('#px-captcha, [id*="perimeterx"]') ||
             (document.body?.innerText || '').includes('Press & Hold');
    });
    if (hasPxChallenge) {
      console.log(`    → PerimeterX challenge detected — waiting for Browserbase to solve...`);
      try {
        await bbPage.waitForFunction(() => {
          return !document.querySelector('#px-captcha, [id*="perimeterx"]') &&
                 !(document.body?.innerText || '').includes('Press & Hold');
        }, { timeout: 45000 });
        console.log(`    → PerimeterX resolved, proceeding with login...`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ PerimeterX not resolved after 45s - continuing anyway`);
      }
    }

    // Step 1: Email
    const emailInput = await bbPage.$('input[type="text"][placeholder*="email"], input[type="email"], input[name="email"]');
    if (!emailInput) {
      console.log(`    ✗ Bloomberg login FAILED (no email field)`);
      return false;
    }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(1000);

    const continueBtn = await bbPage.$('button:has-text("Continue"), button[type="submit"]');
    if (continueBtn) await continueBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForTimeout(4000);

    // Step 2: Password
    const passInput = await bbPage.$('input[type="password"]');
    if (!passInput) {
      console.log(`    ✗ Bloomberg login FAILED (no password field after email step)`);
      return false;
    }
    await passInput.click();
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    const signInBtn = await bbPage.$('button:has-text("Sign in"), button:has-text("Continue"), button[type="submit"]');
    if (signInBtn) await signInBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    const postUrl = bbPage.url();
    if (!postUrl.includes('/account/signin')) {
      console.log(`    ✓ Bloomberg login succeeded (via Browserbase)`);
      return true;
    }
    console.log(`    ⚠ Bloomberg login uncertain (URL: ${postUrl.substring(0, 80)}) - continuing`);
    return true;
  }

  if (domain === 'northjersey.com' || domain === 'usatoday.com') {
    console.log(`    → Browserbase: navigating to ${domain} Gannett login...`);
    const returnUrl = domain === 'northjersey.com' ? 'https://www.northjersey.com/' : 'https://www.usatoday.com/';
    await bbPage.goto(`https://login.usatoday.com/?return-url=${encodeURIComponent(returnUrl)}`, { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);
    const emailInput = await bbPage.$('input[type="email"], input[name="email"], input[id*="email"]');
    if (!emailInput) { console.log(`    ✗ ${domain} login FAILED (no email field)`); return false; }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);
    const passInput = await bbPage.$('input[type="password"], input[name="password"]');
    if (passInput) {
      await passInput.click();
      await passInput.type(password, { delay: 30 });
      await bbPage.waitForTimeout(500);
      const signInBtn = await bbPage.$('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]');
      if (signInBtn) await signInBtn.click();
      else await bbPage.keyboard.press('Enter');
      await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await bbPage.waitForTimeout(3000);
    } else { console.log(`    ✗ ${domain} login FAILED (no password field)`); return false; }
    const postUrl = bbPage.url();
    if (!postUrl.includes('login.usatoday.com')) { console.log(`    ✓ ${domain} login succeeded (via Browserbase)`); return true; }
    console.log(`    ⚠ ${domain} login uncertain - continuing`);
    return true;
  }

  if (domain === 'thestage.co.uk') {
    console.log(`    → Browserbase: navigating to The Stage login...`);
    await bbPage.goto('https://www.thestage.co.uk/login', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);
    const cookieBtn = await bbPage.$('button:has-text("Accept All Cookies"), button:has-text("Accept All"), button:has-text("Accept")');
    if (cookieBtn) { const v = await cookieBtn.isVisible().catch(() => false); if (v) { console.log('    → Dismissing cookie consent...'); await cookieBtn.click(); await bbPage.waitForTimeout(1000); } }
    // /login has two forms (main + nav) — find the visible one
    const emailInputs = await bbPage.$$('input[type="email"], input[name="email"], input[id*="email"]');
    let emailInput = null;
    for (const inp of emailInputs) { if (await inp.isVisible().catch(() => false)) { emailInput = inp; break; } }
    if (!emailInput) { console.log('    ✗ The Stage login FAILED (no visible email field)'); return false; }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);
    const passInputs = await bbPage.$$('input[type="password"], input[name="password"]');
    let passInput = null;
    for (const inp of passInputs) { if (await inp.isVisible().catch(() => false)) { passInput = inp; break; } }
    if (passInput) {
      await passInput.click();
      await passInput.type(password, { delay: 30 });
      await bbPage.waitForTimeout(500);
      const signInBtns = await bbPage.$$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), button[type="submit"], input[type="submit"]');
      let signInBtn = null;
      for (const btn of signInBtns) { if (await btn.isVisible().catch(() => false)) { signInBtn = btn; break; } }
      if (signInBtn) await signInBtn.click();
      else await bbPage.keyboard.press('Enter');
      await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await bbPage.waitForTimeout(3000);
    } else { console.log('    ✗ The Stage login FAILED (no visible password field)'); return false; }
    const postUrl = bbPage.url();
    if (!postUrl.includes('/login')) { console.log('    ✓ The Stage login succeeded (via Browserbase)'); return true; }
    console.log('    ⚠ The Stage login uncertain - continuing');
    return true;
  }

  if (domain === 'ft.com') {
    console.log(`    → Browserbase: navigating to FT login...`);
    await bbPage.goto('https://accounts.ft.com/login', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);
    const hasHcaptcha = await bbPage.$('iframe[src*="hcaptcha"], .h-captcha, [data-hcaptcha-widget-id]');
    if (hasHcaptcha) {
      console.log('    → hCaptcha detected on FT — waiting for Browserbase to solve...');
      try {
        await bbPage.waitForFunction(() => {
          return !document.querySelector('iframe[src*="hcaptcha"]') && !document.querySelector('.h-captcha iframe');
        }, { timeout: 45000 });
        console.log('    → hCaptcha resolved, proceeding with login...');
        await bbPage.waitForTimeout(2000);
      } catch (e) { console.log('    ✗ hCaptcha not resolved after 45s - continuing anyway'); }
    }
    const emailInput = await bbPage.$('input[type="email"], input[name="email"], input[id*="email"]');
    if (!emailInput) { console.log('    ✗ FT login FAILED (no email field)'); return false; }
    await emailInput.click();
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);
    const nextBtn = await bbPage.$('button:has-text("Next"), button:has-text("Enter"), button[type="submit"]');
    if (nextBtn) await nextBtn.click();
    else await bbPage.keyboard.press('Enter');
    await bbPage.waitForTimeout(4000);
    const passInput = await bbPage.$('input[type="password"]');
    if (passInput) {
      await passInput.click();
      await passInput.type(password, { delay: 30 });
      await bbPage.waitForTimeout(500);
      const signInBtn = await bbPage.$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]');
      if (signInBtn) await signInBtn.click();
      else await bbPage.keyboard.press('Enter');
      await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await bbPage.waitForTimeout(3000);
    } else { console.log('    ✗ FT login FAILED (no password field)'); return false; }
    const postUrl = bbPage.url();
    if (!postUrl.includes('accounts.ft.com')) { console.log('    ✓ FT login succeeded (via Browserbase)'); return true; }
    console.log('    ⚠ FT login uncertain - continuing');
    return true;
  }

  if (domain === 'nytimes.com') {
    console.log(`    → Browserbase: navigating to NYT login...`);
    await bbPage.goto('https://myaccount.nytimes.com/auth/login', { timeout: CONFIG.loginTimeout });
    await bbPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    // Check for DataDome CAPTCHA overlay before attempting any clicks
    const hasCaptcha = await bbPage.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        if (f.src && f.src.includes('captcha-delivery.com')) return true;
      }
      const text = document.body?.innerText || '';
      if (text.includes('confirm that you are human') || text.includes('Slide right to complete')) return true;
      return false;
    });
    if (hasCaptcha) {
      console.log(`    → CAPTCHA detected on NYT login - waiting for Browserbase to solve...`);
      try {
        await bbPage.waitForFunction(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && f.src.includes('captcha-delivery.com')) return false;
          }
          return true;
        }, { timeout: 45000 });
        console.log(`    → CAPTCHA resolved, proceeding with login...`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ NYT CAPTCHA not resolved after 45s - login failed`);
        return false;
      }
    }

    // Step 1: Email entry
    let emailInput = null;
    const emailSelectors = 'input[name="email"], input[type="email"], #email';
    try {
      await bbPage.waitForSelector(emailSelectors, { timeout: 15000 });
      emailInput = await bbPage.$(emailSelectors);
    } catch (e) {
      console.log(`    → NYT email field slow to render, waiting...`);
      await bbPage.waitForTimeout(5000);
      emailInput = await bbPage.$(emailSelectors);
    }
    if (!emailInput) {
      console.log(`    ✗ NYT login FAILED (no email field found)`);
      return false;
    }
    try {
      await emailInput.click();
    } catch (e) {
      console.log(`    → Email click failed (possible overlay), using keyboard focus...`);
      await bbPage.keyboard.press('Tab');
    }
    await emailInput.type(email, { delay: 30 });
    await bbPage.waitForTimeout(500);

    // Click Continue / submit email
    const continueBtn = await bbPage.$('button[data-testid="submit-email"], button:has-text("Continue"), button[type="submit"]');
    if (continueBtn) {
      try {
        await continueBtn.click();
      } catch (e) {
        console.log(`    → Continue button click failed, pressing Enter...`);
        await bbPage.keyboard.press('Enter');
      }
    } else {
      await bbPage.keyboard.press('Enter');
    }
    await bbPage.waitForTimeout(5000);

    // Check for CAPTCHA after email submission (DataDome sometimes triggers here)
    const hasCaptchaAfterEmail = await bbPage.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        if (f.src && f.src.includes('captcha-delivery.com')) return true;
      }
      return false;
    });
    if (hasCaptchaAfterEmail) {
      console.log(`    → CAPTCHA appeared after email entry - waiting for Browserbase to solve...`);
      try {
        await bbPage.waitForFunction(() => {
          const iframes = document.querySelectorAll('iframe');
          for (const f of iframes) {
            if (f.src && f.src.includes('captcha-delivery.com')) return false;
          }
          return true;
        }, { timeout: 45000 });
        console.log(`    → CAPTCHA resolved after email step`);
        await bbPage.waitForTimeout(2000);
      } catch (e) {
        console.log(`    ✗ NYT CAPTCHA not resolved after email step - login failed`);
        return false;
      }
    }

    // Step 2: Password entry
    let passInput = null;
    try {
      await bbPage.waitForSelector('input[type="password"]', { timeout: 15000 });
      passInput = await bbPage.$('input[type="password"]');
    } catch (e) {
      console.log(`    → NYT password field slow to render, waiting...`);
      await bbPage.waitForTimeout(5000);
      passInput = await bbPage.$('input[type="password"]');
    }
    if (!passInput) {
      const postEmailUrl = bbPage.url();
      console.log(`    ✗ NYT login FAILED (no password field found)`);
      console.log(`    → Post-email URL: ${postEmailUrl.substring(0, 100)}`);
      return false;
    }
    try {
      await passInput.click();
    } catch (e) {
      console.log(`    → Password click failed (possible overlay), using keyboard focus...`);
      await bbPage.keyboard.press('Tab');
    }
    await passInput.type(password, { delay: 30 });
    await bbPage.waitForTimeout(500);

    // Click Log In / submit password
    const loginBtn = await bbPage.$('button[data-testid="login-button"], button:has-text("Log In"), button[type="submit"]');
    if (loginBtn) {
      try {
        await loginBtn.click();
      } catch (e) {
        console.log(`    → Login button click failed, pressing Enter...`);
        await bbPage.keyboard.press('Enter');
      }
    } else {
      await bbPage.keyboard.press('Enter');
    }
    await bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await bbPage.waitForTimeout(3000);

    const postUrl = bbPage.url();
    if (!postUrl.includes('auth/login')) {
      console.log(`    ✓ NYT login succeeded (left login page)`);
      return true;
    }
    console.log(`    ⚠ NYT login uncertain (URL: ${postUrl.substring(0, 100)}) - continuing`);
    return true;
  }

  return false;
}

/**
 * Load Browserbase usage from disk (tracks daily spending)
 */
function loadBrowserbaseUsage() {
  const usagePath = CONFIG.browserbaseUsageFile;
  const today = new Date().toISOString().split('T')[0];

  try {
    if (fs.existsSync(usagePath)) {
      const saved = JSON.parse(fs.readFileSync(usagePath, 'utf8'));

      // Reset if it's a new day
      if (saved.date === today) {
        browserbaseUsage = saved;
        browserbaseUsage.sessionsThisRun = 0; // Reset per-run counter
        console.log(`  Browserbase usage loaded: ${browserbaseUsage.sessionsToday}/${CONFIG.browserbaseMaxSessionsPerDay} sessions today`);
      } else {
        // New day - archive previous day and reset
        browserbaseUsage.history.push({
          date: saved.date,
          sessions: saved.sessionsToday,
          minutes: saved.minutesToday
        });
        browserbaseUsage.date = today;
        browserbaseUsage.sessionsToday = 0;
        browserbaseUsage.sessionsThisRun = 0;
        browserbaseUsage.minutesToday = 0;
        console.log(`  Browserbase: New day - reset usage counters`);
      }
    }
  } catch (e) {
    console.log(`  Could not load Browserbase usage: ${e.message}`);
  }
}

/**
 * Save Browserbase usage to disk
 */
function saveBrowserbaseUsage() {
  fs.mkdirSync(path.dirname(CONFIG.browserbaseUsageFile), { recursive: true });
  fs.writeFileSync(CONFIG.browserbaseUsageFile, JSON.stringify(browserbaseUsage, null, 2));
}

/**
 * Check if we can use Browserbase (within spending limits)
 */
function canUseBrowserbase() {
  if (!CONFIG.browserbaseEnabled) return false;
  if (!CONFIG.browserbaseApiKey) return false;

  // Check daily limit
  if (browserbaseUsage.sessionsToday >= CONFIG.browserbaseMaxSessionsPerDay) {
    console.log(`    ⚠ Browserbase daily limit reached (${browserbaseUsage.sessionsToday}/${CONFIG.browserbaseMaxSessionsPerDay})`);
    return false;
  }

  // Check per-run limit
  if (browserbaseUsage.sessionsThisRun >= CONFIG.browserbaseMaxSessionsPerRun) {
    console.log(`    ⚠ Browserbase per-run limit reached (${browserbaseUsage.sessionsThisRun}/${CONFIG.browserbaseMaxSessionsPerRun})`);
    return false;
  }

  return true;
}

/**
 * Fetch with Browserbase - managed browser cloud with CAPTCHA solving
 * Uses their API to create a browser session and control it
 */
async function fetchWithBrowserbase(url, review) {
  if (!canUseBrowserbase()) {
    throw new Error('Browserbase unavailable (limits reached or not configured)');
  }

  stats.tier1_5Attempts++;
  const startTime = Date.now();

  // Track usage BEFORE attempting (we pay even if it fails)
  browserbaseUsage.sessionsToday++;
  browserbaseUsage.sessionsThisRun++;
  stats.browserbaseSessionsUsed++;

  // Track per-domain usage to prevent one domain starving others
  try {
    const urlDomain = new URL(url).hostname.replace('www.', '');
    browserbaseUsage.sessionsPerDomain[urlDomain] = (browserbaseUsage.sessionsPerDomain[urlDomain] || 0) + 1;
  } catch {}


  console.log(`    Browserbase session ${browserbaseUsage.sessionsThisRun}/${CONFIG.browserbaseMaxSessionsPerRun} (${browserbaseUsage.sessionsToday}/${CONFIG.browserbaseMaxSessionsPerDay} today)`);

  let bbBrowser = null;
  let bbPage = null;

  try {
    // Browserbase SDK approach - use their connect endpoint
    const { chromium: bbChromium } = require('playwright');

    // Create session via Browserbase API
    const sessionResponse = await axios.post(
      'https://www.browserbase.com/v1/sessions',
      {
        projectId: CONFIG.browserbaseProjectId,
        browserSettings: {
          // Enable stealth and CAPTCHA solving
          solveCaptchas: true,
          fingerprint: {
            // Use residential-like fingerprint
            locales: ['en-US'],
            operatingSystems: ['macos', 'windows'],
          },
        },
      },
      {
        headers: {
          'x-bb-api-key': CONFIG.browserbaseApiKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const sessionId = sessionResponse.data.id;
    const connectUrl = `wss://connect.browserbase.com?apiKey=${CONFIG.browserbaseApiKey}&sessionId=${sessionId}`;

    console.log(`    → Browserbase session created: ${sessionId.substring(0, 8)}...`);
    state.log.push({ t: new Date().toISOString(), event: 'bb-session', session: sessionId.substring(0, 8), url: url.substring(0, 80) });

    // Connect via Playwright CDP
    bbBrowser = await bbChromium.connectOverCDP(connectUrl);
    const contexts = bbBrowser.contexts();
    const bbContext = contexts[0] || await bbBrowser.newContext();
    bbPage = await bbContext.newPage();

    // Try cookie injection first (faster, more reliable than login)
    let bbCookiesInjected = false;
    const cookieDomain = hasCookiesForUrl(url);
    if (cookieDomain) {
      bbCookiesInjected = await injectCookies(bbContext, cookieDomain);
      if (bbCookiesInjected) {
        console.log(`    🍪 Browserbase: cookies injected for ${cookieDomain} — skipping login`);
        state.log.push({ t: new Date().toISOString(), event: 'bb-cookie-inject', domain: cookieDomain });
      }
    }

    // Login to paywalled sites before navigating to the review URL
    // Browserbase has CAPTCHA solving, making it ideal for sites that block Playwright
    // Skip login if cookies were already injected for this domain
    // Skip login for cookie-only domains (e.g., newyorker.com triggers OTC emails on login)
    const paywallCreds = getPaywallCredentials(url);
    const isCookieOnly = paywallCreds && COOKIE_ONLY_DOMAINS.includes(paywallCreds.domain);
    if (paywallCreds && paywallCreds.email && !bbCookiesInjected && !isCookieOnly) {
      console.log(`    → Browserbase login to ${paywallCreds.domain}...`);
      try {
        const loginOk = await browserbaseLogin(bbPage, paywallCreds.domain, paywallCreds.email, paywallCreds.password);
        if (loginOk) {
          console.log(`    ✓ Browserbase login to ${paywallCreds.domain} succeeded`);
          state.log.push({ t: new Date().toISOString(), event: 'bb-login-ok', domain: paywallCreds.domain });
        } else {
          console.log(`    ⚠ Browserbase login to ${paywallCreds.domain} uncertain - continuing`);
          state.log.push({ t: new Date().toISOString(), event: 'bb-login-uncertain', domain: paywallCreds.domain });
        }
      } catch (loginErr) {
        console.log(`    ⚠ Browserbase login failed: ${loginErr.message} - continuing without login`);
        state.log.push({ t: new Date().toISOString(), event: 'bb-login-fail', domain: paywallCreds.domain, error: loginErr.message });
      }
    }

    // Navigate to the URL
    await bbPage.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.pageTimeout,
    });

    // Wait for content
    await Promise.race([
      bbPage.waitForSelector('article', { timeout: 15000 }),
      bbPage.waitForSelector('[class*="article"]', { timeout: 15000 }),
      bbPage.waitForSelector('main p', { timeout: 15000 }),
      bbPage.waitForTimeout(10000),
    ]).catch(() => {});

    // Extra wait for JS rendering and CAPTCHA solving
    await bbPage.waitForTimeout(5000);

    const html = await bbPage.content();

    // Check for blocking
    if (isBlocked(html)) {
      throw new Error('CAPTCHA or access blocked (even with Browserbase)');
    }

    // Check for paywall
    if (isPaywalled(html)) {
      throw new Error('Paywall detected');
    }

    // Extract text using same method as Playwright (full selector list)
    const text = await bbPage.evaluate(() => {
      const selectors = [
        // NYT
        '[data-testid="article-body"]', 'section[name="articleBody"]',
        // Vulture / NY Mag / Condé Nast
        '[class*="ArticlePageChunks"]', '[class*="RawHtmlBody"]',
        // TimeOut (hashed class names)
        '[class*="_articleContent_"]',
        // Variety / THR / Deadline (PMC sites)
        '.a-content',
        // WSJ
        '.article-content .wsj-snippet-body', 'div.article-content', '[class*="article_body"]',
        // WaPo
        '[data-qa="article-body"]', '.article-body',
        // Entertainment Weekly / People
        '[data-testid="article-body-content"]',
        // Generic (ordered by specificity)
        'article .entry-content', 'article .post-content', 'article .article-body',
        '.story-body', '.entry-content', '.post-content', '.review-content',
        '.article__body', '.article-content', '.rich-text',
        '[class*="ArticleBody"]', '[class*="article-body"]',
        '[class*="story-body"]', '[class*="StoryBody"]', 'main article',
        '.story-content', '[role="article"]', 'article', 'main',
      ];

      let bestText = '';
      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            const paragraphs = el.querySelectorAll('p');
            if (paragraphs.length > 0) {
              const text = Array.from(paragraphs)
                .map(p => p.textContent.trim())
                .filter(t => t.length > 30)
                .join('\n\n');
              if (text.length > bestText.length) bestText = text;
            }
          }
        } catch (e) {}
      }
      return bestText.replace(/\s+/g, ' ').trim();
    });

    // Track time used
    const minutesUsed = (Date.now() - startTime) / 60000;
    browserbaseUsage.minutesToday += minutesUsed;
    stats.browserbaseMinutesUsed += minutesUsed;

    if (text && text.length > 500) {
      stats.tier1_5Success++;
      saveBrowserbaseUsage();
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);

  } catch (error) {
    // Track time even on failure
    const minutesUsed = (Date.now() - startTime) / 60000;
    browserbaseUsage.minutesToday += minutesUsed;
    stats.browserbaseMinutesUsed += minutesUsed;
    saveBrowserbaseUsage();

    throw error;
  } finally {
    // Always close the browser
    if (bbBrowser) {
      try {
        await bbBrowser.close();
      } catch (e) {}
    }
  }
}

// ============================================================================
// TIER 2: ScrapingBee API
// ============================================================================

async function fetchWithScrapingBee(url, useStealth = false) {
  if (!CONFIG.scrapingBeeKey || !axios) {
    throw new Error('ScrapingBee not configured');
  }

  stats.tier2Attempts++;

  const proxyType = useStealth ? 'stealth_proxy' : 'premium_proxy';
  const credits = useStealth ? 75 : 10;

  // Forward subscriber cookies via ScrapingBee's header forwarding
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (cookieHeader) {
    console.log(`    ScrapingBee (${proxyType}, ${credits} credits, +cookies ${cookieHeader.length} chars)...`);
  } else {
    console.log(`    ScrapingBee (${proxyType}, ${credits} credits)...`);
  }

  try {
    const params = {
      api_key: CONFIG.scrapingBeeKey,
      url: url,
      render_js: true,
      wait: 5000,
      block_ads: true,
      block_resources: false,
    };

    if (useStealth) {
      params.stealth_proxy = true;
    } else {
      params.premium_proxy = true;
    }

    // Forward subscriber cookies to the target site
    if (cookieHeader) {
      params.forward_headers = true;
    }

    // Build request config — add Spb-Cookie header for cookie forwarding
    const requestConfig = {
      params,
      timeout: CONFIG.apiTimeout,
    };
    if (cookieHeader) {
      requestConfig.headers = {
        'Spb-Cookie': cookieHeader,
      };
    }

    const response = await axios.get('https://app.scrapingbee.com/api/v1/', requestConfig);

    stats.scrapingBeePageCredits += credits;

    const html = response.data;

    if (isBlocked(html)) {
      // If premium failed with CAPTCHA and we haven't tried stealth yet, retry with stealth
      if (!useStealth && CLI.stealthProxy) {
        console.log(`    → CAPTCHA with premium, retrying with stealth_proxy...`);
        return await fetchWithScrapingBee(url, true);
      }
      throw new Error(`CAPTCHA detected (${proxyType})`);
    }

    const text = extractTextFromHtml(html, url);

    if (text && text.length > 500) {
      stats.tier2Success++;
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);
  } catch (error) {
    // Don't retry if we're already on stealth - let it fail through
    // (This prevents double-retrying when stealth also fails)

    // Enhanced error reporting for ScrapingBee
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.message;

      if (status === 401) {
        throw new Error(`ScrapingBee auth failed: ${message}`);
      } else if (status === 403) {
        throw new Error(`ScrapingBee blocked: ${message}`);
      } else {
        throw new Error(`ScrapingBee error (${status}): ${message}`);
      }
    }
    throw error;
  }
}

// ============================================================================
// TIER 1.8: Direct HTTP fetch with subscriber cookies (no proxy, free)
// ============================================================================

/**
 * Fetch a URL directly with subscriber cookies — bypasses headless browser detection
 * because it's a plain HTTP request (no JS fingerprinting). Uses the same approach
 * as recover-wsj-subscriber.js. Free (no API credits), fast, and avoids the headless
 * Chrome fingerprinting that defeats Playwright + cookies on sites like New Yorker.
 */
async function fetchWithDirectCookies(url) {
  const cookieHeader = buildCookieHeaderForUrl(url);
  if (!cookieHeader) {
    throw new Error('No cookies available for this domain');
  }

  console.log(`    Direct HTTP fetch (+cookies, ${cookieHeader.length} chars)...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    // Determine referrer based on domain
    const hostname = new URL(url).hostname;
    const referrer = `https://${hostname}/`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Cookie': cookieHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referrer,
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="122", "Chromium";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.status === 403 || resp.status === 401) {
      throw new Error(`Auth rejected (HTTP ${resp.status}) — cookies may be expired`);
    }
    if (resp.status === 404) {
      throw new Error(`404 Not Found`);
    }
    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const html = await resp.text();

    if (isBlocked(html)) {
      throw new Error('Paywall/block detected in direct fetch response');
    }

    const text = extractTextFromHtml(html, url);

    if (text && text.length > 500) {
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Direct fetch timed out (30s)');
    }
    throw error;
  }
}

// ============================================================================
// TIER 3: Bright Data Web Unlocker
// ============================================================================

async function fetchWithBrightData(url) {
  if (!CONFIG.brightDataKey || !axios) {
    throw new Error('Bright Data not configured');
  }

  stats.tier3Attempts++;

  // Use Bright Data Web Unlocker Direct API
  // See: https://docs.brightdata.com/scraping-automation/web-unlocker/web-unlocker-api
  const zoneName = process.env.BRIGHTDATA_ZONE || 'mcp_unlocker';
  const keyPreview = CONFIG.brightDataKey.substring(0, 8) + '...';
  console.log(`    Bright Data API (zone=${zoneName}, key=${keyPreview})`);

  try {
    const response = await axios.post('https://api.brightdata.com/request', {
      zone: zoneName,
      url: url,
      format: 'raw',
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.brightDataKey}`,
      },
      timeout: 90000, // 90s for Bright Data
    });

    const html = response.data;

    if (isBlocked(html)) {
      throw new Error('Access blocked in Bright Data response');
    }

    const text = extractTextFromHtml(html, url);

    if (text && text.length > 500) {
      stats.tier3Success++;
      return { html, text };
    }

    throw new Error(`Insufficient text: ${text?.length || 0} chars`);
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || error.response.data || error.message;
      throw new Error(`Bright Data error (${status}): ${message}`);
    }
    throw error;
  }
}

// ============================================================================
// AMP VARIANT: Try /amp/ version of URL (many soft paywalls serve full text on AMP)
// ============================================================================

/**
 * Domains known to have AMP versions with full article text
 */
const AMP_SUPPORTED_DOMAINS = [
  'variety.com', 'hollywoodreporter.com', 'deadline.com',  // PMC network
  'ew.com', 'usatoday.com', 'time.com',
  'vulture.com', 'nymag.com',  // Vox Media
  'washingtonpost.com', 'nypost.com',
  'thewrap.com', 'thedailybeast.com', 'dailybeast.com',
  'huffpost.com', 'huffingtonpost.com',
  'timeout.com', 'newsday.com', 'amny.com',
  'nydailynews.com', 'chicagotribune.com',
];

function getAmpUrl(url) {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '');
    if (!AMP_SUPPORTED_DOMAINS.includes(domain)) return null;
    // Skip if already an AMP URL
    if (parsed.pathname.includes('/amp') || parsed.pathname.endsWith('/amp/')) return null;
    // Append /amp/ to the path
    const ampPath = parsed.pathname.endsWith('/') ? parsed.pathname + 'amp/' : parsed.pathname + '/amp/';
    return `${parsed.protocol}//${parsed.host}${ampPath}${parsed.search}`;
  } catch {
    return null;
  }
}

async function fetchAmpVariant(url, review) {
  stats.ampAttempts++;
  const ampUrl = getAmpUrl(url);
  if (!ampUrl) throw new Error('No AMP variant available for this domain');

  console.log(`    → Trying AMP: ${ampUrl.substring(0, 80)}...`);

  // Use Playwright with the AMP URL
  const browserOk = await ensureBrowserHealthy();
  if (!browserOk) throw new Error('Browser unavailable');

  await page.setExtraHTTPHeaders({ 'Referer': 'https://www.google.com/' });
  await page.goto(ampUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });

  await Promise.race([
    page.waitForSelector('article', { timeout: 10000 }),
    page.waitForSelector('.article-body', { timeout: 10000 }),
    page.waitForSelector('amp-story', { timeout: 10000 }),
    page.waitForTimeout(8000),
  ]).catch(() => {});

  const html = await page.content();
  if (isBlocked(html)) throw new Error('AMP page blocked');

  const text = await extractArticleText(page);
  if (text && text.length > 500) {
    stats.ampSuccess++;
    return { html, text, ampUrl };
  }
  throw new Error(`AMP insufficient text: ${text?.length || 0} chars`);
}

// ============================================================================
// TIER 3.6: Archive.today (archive.ph) — community-archived paywall bypasses
// ============================================================================

async function fetchFromArchiveToday(url) {
  stats.tier3_6Attempts++;

  const checkUrl = `https://archive.ph/newest/${url}`;
  console.log(`    → Checking archive.today...`);

  try {
    const axios = require('axios');
    // First, check if the URL has been archived (follows redirect to archived page)
    const resp = await axios.get(checkUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      validateStatus: (s) => s < 500,
    });

    if (resp.status === 404 || (resp.status === 302 && !resp.headers.location)) {
      throw new Error('No archive.today snapshot found');
    }

    // Extract text from the archived page HTML
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (html.length < 500) throw new Error('Empty archive.today response');

    // Extract text from the archived HTML (strip scripts, styles, tags)
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text && text.length > 500) {
      stats.tier3_6Success++;
      console.log(`    ✓ Archive.today: ${text.length} chars`);
      return { html, text, archiveTodayUrl: resp.request?.res?.responseUrl || checkUrl };
    }

    throw new Error(`Insufficient text from archive.today: ${text?.length || 0} chars`);
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      throw new Error('Archive.today timeout');
    }
    throw error;
  }
}

// ============================================================================
// TIER 4: Archive.org Wayback Machine
// ============================================================================

async function fetchFromArchive(url) {
  if (!axios) {
    throw new Error('axios not available');
  }

  stats.tier4Attempts++;

  // Rate-limit: wait at least ARCHIVE_ORG_MIN_DELAY_MS between requests
  const elapsed = Date.now() - archiveOrgLastRequestTime;
  if (elapsed < ARCHIVE_ORG_MIN_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, ARCHIVE_ORG_MIN_DELAY_MS - elapsed));
  }
  archiveOrgLastRequestTime = Date.now();

  // Check if snapshots exist
  const availabilityUrl = `http://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const availability = await axios.get(availabilityUrl, { timeout: 15000 });

  const snapshot = availability.data?.archived_snapshots?.closest;
  if (!snapshot || !snapshot.url) {
    throw new Error('No archive snapshot available');
  }

  console.log(`    → Found archive from ${snapshot.timestamp}`);

  // Fetch the archived version
  const response = await axios.get(snapshot.url, {
    timeout: CONFIG.apiTimeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  const html = response.data;
  const text = extractTextFromHtml(html, url);

  if (text && text.length > 500) {
    stats.tier4Success++;
    return {
      html,
      text,
      archiveTimestamp: snapshot.timestamp,
      archiveUrl: snapshot.url,
    };
  }

  throw new Error(`Insufficient text in archive: ${text?.length || 0} chars`);
}

/**
 * Archive.org CDX multi-snapshot fetcher.
 * Uses the CDX API to find multiple archived snapshots, then tries oldest-first
 * (pre-paywall snapshots are more likely to have full text).
 * Rate limited: 2s between snapshot fetches to respect CDX ~15 req/min limit.
 */
async function fetchFromArchiveCDX(url) {
  if (!axios) {
    throw new Error('axios not available');
  }

  // Rate-limit: wait at least ARCHIVE_ORG_MIN_DELAY_MS between requests
  const elapsed = Date.now() - archiveOrgLastRequestTime;
  if (elapsed < ARCHIVE_ORG_MIN_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, ARCHIVE_ORG_MIN_DELAY_MS - elapsed));
  }
  archiveOrgLastRequestTime = Date.now();

  // Query CDX API for snapshots
  // New Yorker articles go back to 2008+, so use wider date range for paywalled sites
  const isPaywalledSite = url.includes('newyorker.com') || url.includes('nytimes.com') || url.includes('wsj.com');
  const fromYear = isPaywalledSite ? '2008' : '2014';
  const snapshotLimit = isPaywalledSite ? 20 : 10;
  const cdxUrl = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=${snapshotLimit}&from=${fromYear}&to=2026`;
  const cdxResp = await axios.get(cdxUrl, { timeout: 15000 });

  const rows = cdxResp.data;
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('No CDX snapshots found');
  }

  // First row is header: [urlkey, timestamp, original, mimetype, statuscode, digest, length]
  const snapshots = rows.slice(1)
    .filter(row => row[4] === '200' && (row[3] || '').includes('text/html'))
    .sort((a, b) => a[1].localeCompare(b[1])); // oldest-first

  if (snapshots.length === 0) {
    throw new Error('No usable CDX snapshots (all non-200 or non-HTML)');
  }

  console.log(`    → CDX found ${snapshots.length} snapshots (oldest: ${snapshots[0][1]}, newest: ${snapshots[snapshots.length - 1][1]})`);

  // Try more snapshots for paywalled sites (pre-paywall snapshots are gold)
  const maxAttempts = Math.min(snapshots.length, isPaywalledSite ? 5 : 3);
  let lastError = null;

  for (let i = 0; i < maxAttempts; i++) {
    const [, timestamp, original] = snapshots[i];
    const archiveUrl = `http://web.archive.org/web/${timestamp}/${original}`;

    try {
      const response = await axios.get(archiveUrl, {
        timeout: CONFIG.apiTimeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      const html = response.data;
      const text = extractTextFromHtml(html, original);

      if (text && text.length > 500) {
        console.log(`    → CDX snapshot ${timestamp} yielded ${text.length} chars`);
        return {
          html,
          text,
          archiveTimestamp: timestamp,
          archiveUrl,
        };
      }

      console.log(`    → CDX snapshot ${timestamp}: only ${text?.length || 0} chars, trying next...`);
    } catch (err) {
      console.log(`    → CDX snapshot ${timestamp} failed: ${err.message}`);
      lastError = err;
    }

    // Rate limit: 2s between snapshot fetches
    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error(lastError?.message || `All ${maxAttempts} CDX snapshots had insufficient text`);
}

// ============================================================================
// TIMEOUT URL RESOLVER - TimeOut merged reviews into listing pages
// Their standalone review URLs (e.g., /suffs-review) now 404.
// Reviews live on listing pages (e.g., /hamilton-1, /aladdin-1).
// ============================================================================

/**
 * Try known TimeOut listing URL patterns before falling back to SERP discovery.
 * No API cost - just direct HEAD requests to candidate URLs.
 */
async function resolveTimeoutListingUrl(review) {
  if (!review.url) return null;
  let hostname;
  try { hostname = new URL(review.url).hostname; } catch (e) { return null; }
  if (!hostname.includes('timeout.com')) return null;

  const showSlug = (review.showId || '').replace(/-\d{4}$/, '');
  if (!showSlug) return null;

  // Candidate URL patterns (ordered by likelihood)
  const candidates = [
    `https://www.timeout.com/newyork/theater/${showSlug}-1`,
    `https://www.timeout.com/newyork/theater/${showSlug}`,
    `https://www.timeout.com/newyork/theater/${showSlug}-broadway`,
    `https://www.timeout.com/newyork/theater/${showSlug}-on-broadway-tickets-and-information`,
  ];

  // Skip the URL we already tried
  const tried = review.url.replace(/^http:/, 'https:');
  const toTry = candidates.filter(c => c !== tried);

  for (const url of toTry) {
    try {
      const resp = await axios.head(url, {
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: (s) => s < 400,
      });
      if (resp.status < 400) {
        console.log(`    ✓ TimeOut listing found: ${url}`);
        return url;
      }
    } catch (e) {
      // 404 or network error - try next candidate
    }
  }
  return null;
}

// ============================================================================
// URL DISCOVERY - Find correct URLs for reviews with dead/fabricated links
// Uses shared url-discovery.js module (BD-first SERP, date range filtering,
// domain alias matching, stripped-title retries, URL year checks).
// ============================================================================

const URL_DISCOVERY_MAX_PER_RUN = parseInt(process.env.URL_DISCOVERY_LIMIT, 10) || 1000; // Cap SERP API calls to control costs (env: URL_DISCOVERY_LIMIT)
let _showsJsonCache = null; // Cached shows.json data (used by URL discovery + content validation)

/**
 * Thin wrapper around shared url-discovery.js discoverCorrectUrl.
 * Adds per-run cap, stats tracking, and UNCOLLECTABLE_OUTLETS filter.
 */
async function discoverCorrectUrl(review) {
  if (!CONFIG.scrapingBeeKey && !CONFIG.brightDataKey) return null;
  if (UNCOLLECTABLE_OUTLETS.has((review.outletId || '').toLowerCase())) return null;

  // Per-run cap to prevent runaway SERP API costs
  if (stats.urlDiscoveryAttempts >= URL_DISCOVERY_MAX_PER_RUN) {
    stats.urlDiscoveryCapped++;
    console.log(`    ⚠ URL discovery capped (${URL_DISCOVERY_MAX_PER_RUN}/run limit reached)`);
    return null;
  }

  stats.urlDiscoveryAttempts++;

  // Delegate to shared url-discovery.js module (handles show lookup, market awareness,
  // date range filtering, domain aliases, stripped-title retries, URL year checks,
  // BD-first SERP ordering with preferSpeed support)
  const result = await _sharedDiscoverUrl(review, CONFIG.scrapingBeeKey || '', {
    brightDataKey: CONFIG.brightDataKey || '',
    log: (msg) => console.log(msg),
  });

  if (result === '__SERP_UNAVAILABLE__') return '__SERP_UNAVAILABLE__';

  if (result && result !== null) {
    stats.urlDiscoverySuccess++;
    stats.urlDiscoveryDetails.push({
      reviewId: review.reviewId || `${review.showId}/${review.file}`,
      oldUrl: review.url,
      newUrl: result,
    });
  }

  return result;
}

// ============================================================================
// QUALITY GATE + TIMEOUT HELPERS (for tier chain loop)
// ============================================================================

/**
 * Quality gate — returns garbage reason string or null.
 * Uses isGarbageContent() not assessTextQuality() — the full assessor has a 5.5%
 * false positive rate on known-good reviews (multi-show mentions, article boundaries).
 * isGarbageContent() has 0% false positives and catches paywall pages, newsletters,
 * ad-blockers, error pages, and nav junk.
 */
function checkContentQuality(text) {
  const check = isGarbageContent(text);
  if (check.isGarbage) {
    return check.reason;
  }
  return null;
}

/**
 * Timeout wrapper for tier execution.
 * Returns the promise result or rejects with a timeout error.
 */
function withTimeout(promise, ms, tierName) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${tierName} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// ============================================================================
// UNIFIED FETCH FUNCTION
// ============================================================================

/**
 * Build the context object describing URL properties and mutable state signals
 * used by tier shouldRun predicates and onFailure hooks.
 */
function buildTierContext(review) {
  const url = review.url;
  const urlLower = url.toLowerCase();

  const isKnownBlocked = CONFIG.knownBlockedSites.some(s => urlLower.includes(s));
  const hasCookiesLoaded = !!hasCookiesForUrl(url);
  const isArchiveFirstSite = CONFIG.archiveFirstSites.some(s => urlLower.includes(s));

  let isOldReview = false;
  if (review.publishDate) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    isOldReview = review.publishDate < sixMonthsAgo;
  }

  const archiveFirstExplicitlyDisabled = process.env.ARCHIVE_FIRST === 'false';

  // Reason-aware routing: override tier strategy based on incompleteReason
  const reason = review.incompleteReason || '';
  // NOT scraper_garbage — many got garbage FROM archive.org, so archive-first creates a loop
  const forceArchiveFirst = ['paywall', 'partial_text'].includes(reason);
  // Only skip direct scrapers for paywall if we DON'T have cookies (cookies = try Playwright first)
  const skipDirectScrapers = reason === 'paywall' && !getPaywallCredentials(url)?.email;
  const enableBrowserbase = reason === 'bot_blocked';

  const isArchiveFirst = forceArchiveFirst || (!archiveOrgDisabledForBatch &&
    ((!archiveFirstExplicitlyDisabled && isArchiveFirstSite) || (CONFIG.archiveFirst && isOldReview)));
  const hasPaywallCreds = !!getPaywallCredentials(url)?.email;

  return {
    url,
    urlLower,
    isKnownBlocked,
    hasCookiesLoaded,
    isArchiveFirst,
    hasPaywallCreds,
    // Reason-aware routing signals
    skipDirectScrapers,
    enableBrowserbase,
    // Mutable signals set by onFailure hooks, read by later shouldRun predicates
    sawCaptcha: false,
    sawPaywall: false,
    anyTierFailed: false,
    _playwright404NoCreds: false,
    _bail404: false,
    consecutive404Count: 0,
    _archiveTierRan: false,
    _archiveCdxRan: false,
  };
}

/**
 * Execute a forced tier directly (CLI --force-tier flag).
 * Bypasses the quality gate — returns raw tier output.
 */
async function executeForcedTier(tier, url, review) {
  try {
    switch (tier) {
      case 1: {
        const r = await fetchWithPlaywright(url, review);
        return { html: r.html, text: r.text, method: 'playwright', attempts: [{ tier: 1, method: 'playwright', success: true }] };
      }
      case 1.5: {
        const r = await fetchWithBrowserbase(url, review);
        return { html: r.html, text: r.text, method: 'browserbase', attempts: [{ tier: 1.5, method: 'browserbase', success: true }] };
      }
      case 2: {
        const r = await fetchWithScrapingBee(url);
        return { html: r.html, text: r.text, method: 'scrapingbee', attempts: [{ tier: 2, method: 'scrapingbee', success: true }] };
      }
      case 3: {
        const r = await fetchWithBrightData(url);
        return { html: r.html, text: r.text, method: 'brightdata', attempts: [{ tier: 3, method: 'brightdata', success: true }] };
      }
      case 1.1: {
        const r = await fetchAmpVariant(url, review);
        return { html: r.html, text: r.text, method: 'amp', attempts: [{ tier: 1.1, method: 'amp', success: true }] };
      }
      case 3.6: {
        const r = await fetchFromArchiveToday(url);
        return { html: r.html, text: r.text, method: 'archive-today', attempts: [{ tier: 3.6, method: 'archive-today', success: true }] };
      }
      case 4: {
        const r = await fetchFromArchive(url);
        return { html: r.html, text: r.text, method: 'archive', archiveData: r, attempts: [{ tier: 4, method: 'archive', success: true }] };
      }
    }
  } catch (e) {
    throw new Error(`Forced tier ${tier} failed: ${e.message}`);
  }
}

/**
 * Build the tier descriptor chain for fetchReviewText.
 * Each descriptor has: id, tierNumber, method, shouldRun(ctx), execute(url, review),
 * optional onFailure(error, ctx), onSuccess(review, result), timeoutMs.
 */
function buildTierChain(ctx, review) {
  return [
    // TIER 0: Archive.org first (for paywalled sites + old reviews when archiveFirst default is on)
    {
      id: 'archive-first',
      tierNumber: 0,
      method: 'archive-first',
      label: 'Archive.org (paywalled site - trying archive first)',
      shouldRun: () => ctx.isArchiveFirst,
      execute: (url) => fetchFromArchive(url),
      onSuccess: (review, result) => {
        ctx._archiveTierRan = true;
        archiveOrgConsecutiveFailures = 0; // Reset on success
      },
      onFailure: async (error) => {
        ctx._archiveTierRan = true;
        archiveOrgConsecutiveFailures++;
        if (archiveOrgConsecutiveFailures >= ARCHIVE_ORG_COOLDOWN_THRESHOLD && !archiveOrgDisabledForBatch) {
          archiveOrgCooldownCount++;
          if (archiveOrgCooldownCount >= ARCHIVE_ORG_MAX_COOLDOWNS) {
            archiveOrgDisabledForBatch = true;
            console.log(`    ⚠ Archive.org disabled for batch (${archiveOrgCooldownCount} cooldowns, ${archiveOrgConsecutiveFailures} total consecutive failures)`);
          } else {
            console.log(`    ⚠ Archive.org cooldown #${archiveOrgCooldownCount} (${archiveOrgConsecutiveFailures} consecutive failures) — waiting ${ARCHIVE_ORG_COOLDOWN_MS / 1000}s before retrying`);
            await new Promise(resolve => setTimeout(resolve, ARCHIVE_ORG_COOLDOWN_MS));
            archiveOrgConsecutiveFailures = 0; // Reset after cooldown
          }
        }
      },
    },

    // TIER 0.5: Archive.org CDX multi-snapshot (after Tier 0 fails for archive-first sites)
    {
      id: 'archive-cdx',
      tierNumber: 0.5,
      method: 'archive',
      label: 'Archive.org CDX multi-snapshot',
      shouldRun: () => ctx.isArchiveFirst && ctx._archiveTierRan,
      execute: (url) => fetchFromArchiveCDX(url),
      onSuccess: (review, result) => {
        ctx._archiveCdxRan = true;
        archiveOrgConsecutiveFailures = 0; // Reset on success
      },
      onFailure: (error) => { ctx._archiveCdxRan = true; },
    },

    // TIER 1: Playwright with stealth
    {
      id: 'playwright',
      tierNumber: 1,
      method: 'playwright',
      label: 'Playwright with stealth',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !ctx.isKnownBlocked || ctx.hasCookiesLoaded;
      },
      skipMessage: 'Skipped (known-blocked site, no cookies)',
      execute: (url) => fetchWithPlaywright(url, review),
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        const msg = error.message || '';
        if (msg.includes('CAPTCHA') || msg.includes('blocked')) ctx.sawCaptcha = true;
        if (msg.includes('Paywall')) ctx.sawPaywall = true;
        if (msg.includes('404') && !ctx.hasPaywallCreds) {
          ctx._playwright404NoCreds = true;
        } else if (msg.includes('404') && ctx.hasPaywallCreds) {
          console.log('    → 404 on paywalled site with credentials - will try Browserbase login...');
        }
      },
    },

    // TIER 1.1: AMP variant (many soft paywalls serve full text on /amp/ pages)
    {
      id: 'amp-variant',
      tierNumber: 1.1,
      method: 'amp',
      label: 'AMP page variant (paywall bypass)',
      shouldRun: () => {
        // Only try AMP if Playwright got blocked/paywalled/insufficient AND domain has AMP
        if (!ctx.anyTierFailed && !ctx.sawPaywall) return false;
        return !!getAmpUrl(ctx.url);
      },
      execute: (url) => fetchAmpVariant(url, review),
      onSuccess: (review, result) => {
        state.tierBreakdown.amp.push(review.filePath);
      },
      onFailure: (error) => { /* AMP failed, continue to next tier */ },
    },

    // TIER 4 (early): Archive.org 404 recovery
    {
      id: 'archive-404-recovery',
      tierNumber: 4,
      method: 'archive',
      label: 'Archive.org (404 detected - skipping other tiers)',
      shouldRun: () => ctx._playwright404NoCreds,
      execute: (url) => fetchFromArchive(url),
      onSuccess: (review, result) => { ctx._archiveTierRan = true; },
      onFailure: (error) => {
        ctx._archiveTierRan = true;
        ctx._bail404 = true; // URL is dead — don't waste API credits
      },
    },

    // TIER 1.5: Browserbase (managed browser cloud + CAPTCHA solving + login)
    {
      id: 'browserbase',
      tierNumber: 1.5,
      method: 'browserbase',
      label: 'Browserbase (managed browser + CAPTCHA solving)',
      timeoutMs: 120000,
      shouldRun: () => {
        if (!CONFIG.browserbaseEnabled || !canUseBrowserbase()) return false;
        // Per-domain session cap — prevents one domain class from consuming all sessions
        try {
          const urlDomain = new URL(url).hostname.replace('www.', '');
          const domainSessions = browserbaseUsage.sessionsPerDomain[urlDomain] || 0;
          if (domainSessions >= CONFIG.browserbaseMaxSessionsPerDomain) {
            console.log(`    ⚠ Browserbase per-domain limit reached for ${urlDomain} (${domainSessions}/${CONFIG.browserbaseMaxSessionsPerDomain})`);
            return false;
          }
        } catch {}
        return (
          ctx.isKnownBlocked || ctx.sawCaptcha || ctx.enableBrowserbase ||
          (ctx.hasPaywallCreds && (ctx.sawPaywall || ctx.anyTierFailed))
        );
      },
      execute: (url) => fetchWithBrowserbase(url, review),
      onSuccess: (review, result) => {
        state.tierBreakdown.browserbase.push(review.filePath);
      },
      onFailure: (error) => { ctx.anyTierFailed = true; },
    },

    // TIER 1.8: Direct HTTP fetch with subscriber cookies (free, no proxy)
    // Bypasses headless browser fingerprinting that defeats Playwright/Browserbase.
    // Plain HTTP request with cookies + realistic headers — sites can't detect headless Chrome.
    {
      id: 'direct-cookies',
      tierNumber: 1.8,
      method: 'direct-cookies',
      label: 'Direct HTTP fetch with cookies',
      shouldRun: () => {
        // Only run if we have cookies for this domain AND previous tiers failed
        if (!ctx.hasCookiesLoaded) return false;
        return ctx.anyTierFailed || ctx.sawPaywall || ctx.sawCaptcha;
      },
      execute: (url) => fetchWithDirectCookies(url),
      onSuccess: (review, result) => {
        // Track in scrapingbee breakdown since we don't have a separate counter
        // (adds zero cost — this is a free tier)
      },
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        const msg = error.message || '';
        if (msg.includes('expired')) ctx._cookiesExpired = true;
      },
    },

    // TIER 2: ScrapingBee API (now with cookie forwarding for paywalled sites)
    {
      id: 'scrapingbee',
      tierNumber: 2,
      method: 'scrapingbee',
      label: 'ScrapingBee API',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !!CONFIG.scrapingBeeKey;
      },
      execute: (url) => fetchWithScrapingBee(url, false),
      onFailure: (error) => {
        ctx.anyTierFailed = true;
        if (error.message?.includes('404')) {
          ctx.consecutive404Count++;
        }
      },
    },

    // TIER 3: Bright Data Web Unlocker
    {
      id: 'brightdata',
      tierNumber: 3,
      method: 'brightdata',
      label: 'Bright Data Web Unlocker',
      shouldRun: () => {
        if (ctx.skipDirectScrapers) return false;
        return !!CONFIG.brightDataKey;
      },
      execute: (url) => fetchWithBrightData(url),
      onFailure: (error) => { ctx.anyTierFailed = true; },
    },

    // TIER 3.5: Archive.org CDX multi-snapshot (final fallback for non-archive-first sites)
    {
      id: 'archive-cdx-final',
      tierNumber: 3.5,
      method: 'archive',
      label: 'Archive.org CDX multi-snapshot (fallback)',
      shouldRun: () => !ctx._archiveCdxRan,
      execute: (url) => fetchFromArchiveCDX(url),
      onSuccess: (review, result) => { ctx._archiveCdxRan = true; },
      onFailure: (error) => { ctx._archiveCdxRan = true; },
    },

    // TIER 3.6: Archive.today (community-archived paywall content)
    {
      id: 'archive-today',
      tierNumber: 3.6,
      method: 'archive-today',
      label: 'Archive.today (community archive)',
      shouldRun: () => ctx.anyTierFailed, // Only try if everything else failed
      execute: (url) => fetchFromArchiveToday(url),
      onSuccess: (review, result) => {
        state.tierBreakdown.archiveToday.push(review.filePath);
      },
      onFailure: (error) => { /* Archive.today failed, continue to Archive.org */ },
    },

    // TIER 4: Archive.org (last resort)
    {
      id: 'archive-final',
      tierNumber: 4,
      method: 'archive',
      label: 'Archive.org Wayback Machine',
      shouldRun: () => !ctx._archiveTierRan,
      execute: (url) => fetchFromArchive(url),
      onSuccess: (review, result) => { ctx._archiveTierRan = true; },
      onFailure: (error) => { ctx._archiveTierRan = true; },
    },
  ];
}

async function fetchReviewText(review) {
  const ctx = buildTierContext(review);
  const url = ctx.url;

  // Force specific tier if requested (bypasses quality gate)
  if (CLI.forceTier) {
    return executeForcedTier(parseFloat(CLI.forceTier), url, review);
  }

  // Diagnostic: log Browserbase routing state for paywalled sites
  if (ctx.hasPaywallCreds) {
    console.log(`  [Browserbase routing] enabled=${CONFIG.browserbaseEnabled} isBlocked=${ctx.isKnownBlocked} creds=${ctx.hasPaywallCreds}`);
  }

  let chain = buildTierChain(ctx, review);

  // Reorder tier chain based on domain-specific success rates.
  // Tiers listed in DOMAIN_TIER_ORDER for this domain get moved to the front (in priority order).
  // Tiers NOT listed stay at the end in their default order — nothing is skipped.
  try {
    const urlDomain = new URL(url).hostname.replace('www.', '');
    const domainOrder = DOMAIN_TIER_ORDER[urlDomain];
    if (domainOrder && domainOrder.length > 0) {
      const prioritized = [];
      const remaining = [];
      // Build index of tier IDs → tier objects
      const tierById = {};
      for (const tier of chain) tierById[tier.id] = tier;
      // Add prioritized tiers in order
      for (const tierId of domainOrder) {
        if (tierById[tierId]) {
          prioritized.push(tierById[tierId]);
          delete tierById[tierId];
        }
      }
      // Add remaining tiers in original order
      for (const tier of chain) {
        if (tierById[tier.id]) remaining.push(tier);
      }
      chain = [...prioritized, ...remaining];
    }
  } catch {}

  // Remove tiers that are proven dead ends for this domain (3+ failures, 0 successes).
  // Saves 15-30s per skipped tier per review.
  try {
    const urlDomain = new URL(url).hostname.replace('www.', '');
    const skipTiers = DOMAIN_TIER_SKIP[urlDomain];
    if (skipTiers && skipTiers.length > 0) {
      const skipSet = new Set(skipTiers);
      chain = chain.filter(tier => !skipSet.has(tier.id));
    }
  } catch {}

  const attempts = [];
  let bestResult = null; // Track longest non-empty text from garbage tiers

  for (const tier of chain) {
    // Bail conditions
    if (ctx._bail404) {
      throw new Error(`URL returned 404 (archive also failed): ${JSON.stringify(attempts)}`);
    }
    if (ctx.consecutive404Count >= 2) {
      throw new Error(`URL confirmed dead (404 from multiple tiers): ${JSON.stringify(attempts)}`);
    }

    // Check shouldRun predicate
    if (!tier.shouldRun()) {
      if (tier.skipMessage) {
        console.log(`  [Tier ${tier.tierNumber}] ${tier.skipMessage}`);
        attempts.push({ tier: tier.tierNumber, method: tier.method, success: false, error: tier.skipMessage });
      }
      continue;
    }

    // Execute tier
    console.log(`  [Tier ${tier.tierNumber}] ${tier.label}...`);
    let result;
    try {
      result = await withTimeout(tier.execute(url), tier.timeoutMs, tier.id);
    } catch (error) {
      console.log(`    ✗ Failed: ${error.message}`);
      attempts.push({ tier: tier.tierNumber, method: tier.method, success: false, error: error.message });
      if (tier.onFailure) await tier.onFailure(error, ctx);
      continue;
    }

    // Tier succeeded — log result
    console.log(`    ✓ ${tier.id} returned ${result.text?.length || 0} chars`);
    attempts.push({ tier: tier.tierNumber, method: tier.method, success: true });

    // Quality gate: check for garbage content (paywall pages, newsletters, nav junk)
    const garbageReason = checkContentQuality(result.text);
    if (garbageReason) {
      console.log(`    ⚠ ${tier.id} returned garbage: ${garbageReason} — trying next tier`);
      // Track best-of-garbage as fallback
      if (!bestResult || (result.text?.length || 0) > (bestResult.text?.length || 0)) {
        bestResult = { ...result, method: tier.method === 'archive-first' || tier.method === 'archive' ? 'archive' : tier.method };
        if (tier.method === 'archive-first' || tier.method === 'archive') bestResult.archiveData = result;
      }
      if (tier.onFailure) tier.onFailure(new Error(`garbage: ${garbageReason}`), ctx);
      continue;
    }

    // Accept result
    const accepted = {
      html: result.html,
      text: result.text,
      method: tier.method === 'archive-first' ? 'archive' : tier.method,
      attempts,
    };
    if (tier.method === 'archive-first' || tier.method === 'archive') {
      accepted.archiveData = result;
    }
    if (tier.onSuccess) tier.onSuccess(review, result);
    return accepted;
  }

  // All tiers exhausted — return best-of-garbage if available
  if (bestResult) {
    console.log(`  ⚠ All tiers returned garbage — using best result (${bestResult.text?.length} chars)`);
    bestResult.attempts = attempts;
    return bestResult;
  }

  throw new Error(`All tiers failed: ${JSON.stringify(attempts)}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getPaywallCredentials(url) {
  for (const [domain, creds] of Object.entries(CONFIG.paywalledDomains)) {
    if (url.includes(domain)) {
      const email = process.env[creds.emailVar];
      const password = process.env[creds.passVar] || (creds.altPassVar && process.env[creds.altPassVar]);
      if (email && password) {
        return { domain, email, password };
      }
      return { domain, email: null, password: null };
    }
  }
  return null;
}

function isBlocked(html) {
  if (!html || typeof html !== 'string') return true;
  // Very short HTML = definitely blocked (error page or empty response)
  if (html.length < 1000) {
    const lower = html.toLowerCase();
    return (
      lower.includes('access denied') ||
      lower.includes('403 forbidden') ||
      lower.includes('blocked') ||
      lower.includes('robot check') ||
      lower.includes('rate limit')
    );
  }
  // For longer pages: check the visible text content, not script tags
  // Extract just the body text (strip script/style tags)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  // Remove script and style tags to avoid false positives from JS code
  const visibleHtml = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const lower = visibleHtml.toLowerCase();
  // Check for blocking patterns in visible content only
  const hasBlockingTitle = /<title[^>]*>[^<]*(access denied|forbidden|blocked|captcha)[^<]*<\/title>/i.test(html);
  const hasBlockingContent = (
    (lower.includes('please verify you are human') || lower.includes('confirm that you are human')) ||
    (lower.includes('access denied') && visibleHtml.length < 3000) ||
    (lower.includes('robot check') && visibleHtml.length < 3000) ||
    (lower.includes('unusual traffic') && visibleHtml.length < 3000) ||
    // Only flag captcha if it's the main page content, not just a script reference
    (lower.includes('solve the captcha') || lower.includes('complete the captcha') || lower.includes('slide right to complete'))
  );
  return hasBlockingTitle || hasBlockingContent;
}

function isPaywalled(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  // Note: Do NOT check for bare 'paywall' - ad scripts (Piano/tinypass) include the word
  // on free sites like Variety, THR, Deadline causing false positives
  return (
    lower.includes('subscribe to continue') ||
    lower.includes('subscription required') ||
    lower.includes('create a free account') ||
    lower.includes('sign in to read') ||
    lower.includes('already a subscriber') ||
    lower.includes('this article is for subscribers') ||
    lower.includes('to read the full story')
  );
}

async function extractArticleText(page) {
  return await page.evaluate(() => {
    // Site-specific selectors first (most precise), then generic fallbacks
    const selectors = [
      // New Yorker (Condé Nast) - most precise selector
      '.body__inner-container',
      // NYT
      '[data-testid="article-body"]',
      'section[name="articleBody"]',
      // Vulture / NY Mag / Condé Nast
      '[class*="ArticlePageChunks"]',
      '[class*="RawHtmlBody"]',
      // TimeOut (uses hashed class names like _articleContent_3h2iz_20)
      '[class*="_articleContent_"]',
      // Variety / THR / Deadline (PMC sites - free content)
      '.a-content',
      // WSJ
      '.article-content .wsj-snippet-body',
      'div.article-content',
      '[class*="article_body"]',
      // WaPo
      '[data-qa="article-body"]',
      '.article-body',
      // Entertainment Weekly / People
      '[data-testid="article-body-content"]',
      // Generic (ordered by specificity)
      'article .entry-content',
      'article .post-content',
      'article .article-body',
      '.story-body',
      '.entry-content',
      '.post-content',
      '.review-content',
      '.article__body',
      '.article-content',
      '.rich-text',
      '[class*="ArticleBody"]',
      '[class*="article-body"]',
      '[class*="story-body"]',
      '[class*="StoryBody"]',
      'main article',
      '.story-content',
      '[role="article"]',
      'article',
      'main',
    ];

    let bestText = '';

    // Try JSON-LD first — many major sites embed articleBody in structured data
    try {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
          for (const item of items) {
            const body = item.articleBody || item.reviewBody || item.text;
            if (body && typeof body === 'string' && body.length > bestText.length) {
              const cleaned = body.replace(/<[^>]+>/g, '').trim();
              if (cleaned.length > bestText.length) {
                bestText = cleaned;
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    // If JSON-LD didn't give enough text, try CSS selectors
    if (bestText.length < 500) {
      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            const paragraphs = el.querySelectorAll('p');
            if (paragraphs.length > 0) {
              const text = Array.from(paragraphs)
                .map(p => p.textContent.trim())
                .filter(t => t.length > 30)
                .join('\n\n');
              if (text.length > bestText.length) {
                bestText = text;
              }
              // Early exit: if a specific selector (not 'article' or 'main')
              // returns enough text, prefer it over broader selectors that
              // might include sidebar/related-posts content
              if (text.length >= 500 && selector !== 'article' && selector !== 'main' && selector !== 'main article') {
                break;
              }
            } else {
              const text = el.textContent.trim();
              if (text.length > bestText.length) {
                bestText = text;
              }
            }
          }
        } catch (e) {}
      }
    }

    // Fallback: find all substantial paragraphs
    if (bestText.length < 500) {
      const allParagraphs = Array.from(document.querySelectorAll('p'));
      const contentParagraphs = allParagraphs.filter(p => {
        const text = p.textContent.trim();
        return text.length > 50 &&
          !text.toLowerCase().includes('cookie') &&
          !text.toLowerCase().includes('subscribe') &&
          !text.toLowerCase().includes('sign up') &&
          !text.toLowerCase().includes('newsletter');
      });

      if (contentParagraphs.length > 3) {
        const pText = contentParagraphs.map(p => p.textContent.trim()).join('\n\n');
        if (pText.length > bestText.length) {
          bestText = pText;
        }
      }
    }

    let cleaned = bestText
      .replace(/\s+/g, ' ')
      .replace(/Subscribe to our newsletter[^.]*\./gi, '')
      .replace(/Sign up for[^.]*\./gi, '')
      .replace(/Advertisement/gi, '')
      .trim();

    // New Yorker: truncate at ♦ end-of-article marker
    const diamondIdx = cleaned.indexOf('\u2666');
    if (diamondIdx > 500) {
      cleaned = cleaned.substring(0, diamondIdx).trim();
    }
    // New Yorker: truncate at print edition footer
    const printIdx = cleaned.indexOf('Published in the print edition');
    if (printIdx > 500) {
      cleaned = cleaned.substring(0, printIdx).trim();
    }

    return cleaned;
  });
}

/**
 * Extract article text from JSON-LD structured data embedded in the page.
 * Many major outlets (NYT, WaPo, HR, USA Today, The Wrap, etc.) embed
 * the full article body in script[type="application/ld+json"] tags.
 */
function extractFromJsonLd(html) {
  try {
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    let bestText = '';
    while ((match = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1].trim());
        const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
        for (const item of items) {
          const body = item.articleBody || item.reviewBody || item.text;
          if (body && typeof body === 'string' && body.length > bestText.length) {
            const cleaned = body
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&rsquo;/g, '\u2019')
              .replace(/&lsquo;/g, '\u2018')
              .replace(/&rdquo;/g, '\u201D')
              .replace(/&ldquo;/g, '\u201C')
              .replace(/&mdash;/g, '\u2014')
              .replace(/&ndash;/g, '\u2013')
              .trim();
            if (cleaned.length > bestText.length) {
              bestText = cleaned;
            }
          }
        }
      } catch (e) { /* malformed JSON-LD */ }
    }
    return bestText;
  } catch (e) {
    return '';
  }
}

function extractTextFromHtml(html, url) {
  if (!html || typeof html !== 'string') return '';

  // New Yorker-specific extraction: isolate article body before generic parsing
  if (url && url.includes('newyorker.com')) {
    const nyText = extractNewYorkerFromHtml(html);
    if (nyText && nyText.length > 500) return nyText;
  }

  // Try JSON-LD extraction — reliable when available, avoids CSS selector fragility
  const jsonLdText = extractFromJsonLd(html);
  if (jsonLdText && jsonLdText.length > 500) return jsonLdText;

  // Remove scripts, styles, nav, etc.
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Strip known sidebar/cruft sections before extracting <p> tags.
  // This is more reliable than trying to regex-match container boundaries
  // (nested divs make [\s\S]*? unreliable).
  text = text
    .replace(/<div[^>]*class="[^"]*(?:sharedaddy|jp-relatedposts|sd-sharing|sd-like|wpcnt|related-posts|widget|sidebar|comment|author-bio|author-info|post-tags|post-meta|social-share|share-buttons)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<section[^>]*class="[^"]*(?:related|comments|author)[^"]*"[^>]*>[\s\S]*?<\/section>/gi, '')
    .replace(/<ul[^>]*class="[^"]*(?:social|share|tag)[^"]*"[^>]*>[\s\S]*?<\/ul>/gi, '');

  // Try to isolate article body container using broad class matches.
  // Use greedy [\s\S]* bounded by a known end-marker to capture all nested divs.
  const containerSelectors = [
    'entry-content', 'post-content', 'article-body', 'review-content',
    'entry clearfix', 'article-content', 'post-body', 'story-body',
  ];
  for (const cls of containerSelectors) {
    const escapedCls = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match from container open tag to end of article/next major section
    const pattern = new RegExp(
      '<div[^>]*class="[^"]*' + escapedCls + '[^"]*"[^>]*>([\\s\\S]*?)(?:<\\/article>|<div[^>]*class="[^"]*(?:comment|related|sidebar|footer|author-bio|post-nav)[^"]*"|<section[^>]*class="[^"]*comment|$)',
      'i'
    );
    const containerMatch = text.match(pattern);
    if (containerMatch && containerMatch[1]) {
      const containerPs = [...containerMatch[1].matchAll(/<p[^>]*>[\s\S]*?<\/p>/gi)];
      if (containerPs.length >= 3) {
        text = containerMatch[1];
        break;
      }
    }
  }

  // Extract paragraph content
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(text)) !== null) {
    const pText = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .trim();

    if (pText.length > 30 &&
        !pText.toLowerCase().includes('cookie') &&
        !pText.toLowerCase().includes('subscribe') &&
        !pText.toLowerCase().includes('sign up for')) {
      paragraphs.push(pText);
    }
  }

  let result = paragraphs.join('\n\n');

  // Strip trailing blog cruft: author bios, pingbacks, related post lists
  // These patterns detect where the actual review ends and boilerplate begins
  const cruftPatterns = [
    /\n\nView all posts by \w+.*$/s,
    /\n\n\[&#8230;\].*$/s,
    /\n\nPingback:.*$/s,
    /\n\nAbout the Author.*$/si,
    /\n\nShare this:.*$/si,
    /\n\nLike this:.*$/si,
    /\n\nRelated\n.*$/si,
    /\n\nFiled Under:.*$/si,
    /\n\nTagged With:.*$/si,
  ];
  for (const pattern of cruftPatterns) {
    result = result.replace(pattern, '');
  }

  return result;
}

/**
 * New Yorker-specific HTML extraction.
 * Isolates the article body container and strips recirc/newsletter/ad noise.
 * The ♦ character is New Yorker's traditional end-of-article marker.
 */
function extractNewYorkerFromHtml(html) {
  // Strip noise sections before extracting paragraphs
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Try to isolate the article body container
  const bodyContainerMatch = cleaned.match(
    /class="[^"]*body__inner-container[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*ContentFooter|<div[^>]*class="[^"]*recirc-list|$)/i
  );

  // Also try BodyWrapper pattern (Condé Nast CMS variant)
  const bodyWrapperMatch = !bodyContainerMatch && cleaned.match(
    /class="[^"]*BodyWrapper[^"]*"[^>]*>([\s\S]*?)(?:<div[^>]*class="[^"]*ContentFooter|<div[^>]*class="[^"]*recirc-list|$)/i
  );

  const articleHtml = (bodyContainerMatch || bodyWrapperMatch)?.[1] || cleaned;

  // Remove inline newsletter, audio embeds, and ad containers within article
  const strippedHtml = articleHtml
    .replace(/<div[^>]*class="[^"]*Newsletter[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*AudioEmbed[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*VideoFigure[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*AdWrapper[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="[^"]*consumer-marketing[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Extract paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(strippedHtml)) !== null) {
    const pText = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&rsquo;/g, "\u2019")
      .replace(/&lsquo;/g, "\u2018")
      .replace(/&rdquo;/g, "\u201D")
      .replace(/&ldquo;/g, "\u201C")
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .trim();

    if (pText.length > 30 &&
        !pText.toLowerCase().includes('cookie') &&
        !pText.toLowerCase().includes('subscribe') &&
        !pText.toLowerCase().includes('sign up for') &&
        !pText.toLowerCase().includes('newsletter')) {
      paragraphs.push(pText);
    }
  }

  let result = paragraphs.join('\n\n');

  // Truncate at ♦ (New Yorker end-of-article marker) if present
  const diamondIdx = result.indexOf('\u2666');
  if (diamondIdx > 500) {
    result = result.substring(0, diamondIdx).trim();
  }

  // Also truncate at "Published in the print edition" footer text
  const printIdx = result.indexOf('Published in the print edition');
  if (printIdx > 500) {
    result = result.substring(0, printIdx).trim();
  }

  return result;
}

function validateReviewText(text, review) {
  const issues = [];
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

  if (wordCount < CONFIG.minWordCount) {
    issues.push(`Word count too low: ${wordCount} (min: ${CONFIG.minWordCount})`);
  }

  // Check if show title is mentioned
  const showWords = review.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase();
  const textLower = text.toLowerCase();
  const showMentioned = showWords.split(' ').some(word =>
    word.length > 3 && textLower.includes(word)
  );

  if (!showMentioned) {
    issues.push('Show title not found in text');
  }

  return {
    valid: issues.length === 0,
    wordCount,
    issues,
  };
}

function archiveHtml(html, review, method) {
  const date = new Date().toISOString().split('T')[0];
  const criticSlug = (review.critic || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const outletSlug = (review.outletId || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');

  const archiveDir = path.join(CONFIG.archivesDir, review.showId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, `${outletSlug}--${criticSlug}_${date}.html`);

  const header = `<!--
  Archive Metadata
  URL: ${review.url}
  Outlet: ${review.outlet}
  Critic: ${review.critic}
  Show: ${review.showId}
  FetchMethod: ${method}
  Archived: ${new Date().toISOString()}
-->\n`;

  // Verify HTML canonical URL matches expected domain (catches cross-domain contamination)
  // Skip check for archive.org sources — they always set canonical to web.archive.org
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (canonicalMatch) {
    try {
      const canonicalDomain = new URL(canonicalMatch[1]).hostname.replace(/^www\./, '');
      const expectedDomain = new URL(review.url).hostname.replace(/^www\./, '');
      const isArchiveSource = canonicalDomain === 'web.archive.org' || method === 'archive';
      if (!isArchiveSource && !domainMatchesExpected(expectedDomain, canonicalDomain)) {
        console.log(`  ⚠ ARCHIVE CONTAMINATION: canonical=${canonicalDomain} expected=${expectedDomain}`);
        console.log(`    Canonical URL: ${canonicalMatch[1]}`);
        // Still save archive (for debugging) but flag it
        const warningHeader = `<!-- WARNING: Cross-domain contamination detected! canonical=${canonicalDomain} expected=${expectedDomain} -->\n`;
        fs.writeFileSync(archivePath, warningHeader + header + html);
        return archivePath;
      }
    } catch (e) { /* ignore parse errors */ }
  }

  fs.writeFileSync(archivePath, header + html);
  return archivePath;
}

// TRAILING_JUNK_PATTERNS and stripTrailingJunk imported from ./lib/text-cleaning

// Patterns that indicate a legitimate review ending (not truncation)
const LEGITIMATE_ENDING_PATTERNS = [
  /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}$/,           // Phone number
  /\.(com|org|net|co\.uk)$/i,                  // URL ending
  /\d+\s+(W\.|West|E\.|East|Broadway|Street|St\.|Ave|Avenue)/i,  // Address
  /tickets?\s+(at|available|info)/i,           // Ticket info
  /Productions?$/i,                            // Production credits
  /Studios?$/i,
  /Entertainment$/i,
  /intermission$/i,                            // Runtime info
  /Open run$/i,
];

// Check if text has a legitimate ending (theater info, credits, etc.)
function hasLegitimateEnding(text) {
  const last100 = text.slice(-100).trim();
  return LEGITIMATE_ENDING_PATTERNS.some(p => p.test(last100));
}

// Detect truncation signals in text
// Returns object with detected signals and whether likely truncated
function detectTruncationSignals(text, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { signals: [], likelyTruncated: false, cleanedText: text };
  }

  // First strip trailing junk
  const cleanedText = stripTrailingJunk(text);

  const signals = [];
  const trimmedText = cleanedText.trim();
  const lastChar = trimmedText.slice(-1);
  const last50 = trimmedText.slice(-50);
  const last500 = trimmedText.slice(-500).toLowerCase();

  // Check for proper sentence ending
  const endsWithPunctuation = /[.!?"'"\)]$/.test(trimmedText);
  if (!endsWithPunctuation) {
    signals.push('no_ending_punctuation');
  }

  // Check for ellipsis ending
  if (/\.{3}$|…$/.test(trimmedText)) {
    signals.push('ends_with_ellipsis');
  }

  // Check for paywall/subscribe text near end
  if (/subscribe|sign.?in|log.?in|create.?account|members?.?only/i.test(last500)) {
    signals.push('has_paywall_text');
  }

  // Check for "read more" or "continue reading"
  if (/continue.?reading|read.?more|read.?the.?full|full.?article|full.?review/i.test(last500)) {
    signals.push('has_read_more_prompt');
  }

  // Check for common paywall endings
  if (/privacy.?policy|terms.?of.?use|all.?rights.?reserved|©/i.test(last500)) {
    signals.push('has_footer_text');
  }

  // Check if text is suspiciously short compared to excerpt
  if (excerptLength > 100 && text.length < excerptLength * 1.5) {
    signals.push('shorter_than_excerpt');
  }

  // Check for mid-word cutoff (ends with lowercase letter, no punctuation)
  if (/[a-z]$/.test(lastChar) && !endsWithPunctuation) {
    signals.push('possible_mid_word_cutoff');
  }

  // Determine if likely truncated based on signals
  const severeSignals = ['has_paywall_text', 'has_read_more_prompt', 'ends_with_ellipsis', 'shorter_than_excerpt'];
  const hasSevereSignal = signals.some(s => severeSignals.includes(s));

  // Check for legitimate endings (theater info, credits, URLs) that aren't truncation
  const legitimateEnding = hasLegitimateEnding(trimmedText);

  // Only weak signals (no_ending_punctuation, possible_mid_word_cutoff) + legitimate ending = NOT truncated
  const weakSignalsOnly = signals.every(s => ['no_ending_punctuation', 'possible_mid_word_cutoff'].includes(s));
  const likelyTruncated = hasSevereSignal || (signals.length >= 2 && !(weakSignalsOnly && legitimateEnding));

  return { signals, likelyTruncated, cleanedText, legitimateEnding };
}

// Classify text quality based on rules:
// - full: >1500 chars AND mentions show title AND >300 words AND no truncation signals
// - truncated: Has truncation signals (paywall, read more, etc.)
// - partial: 500-1500 chars OR larger but missing criteria
// - excerpt: <500 chars
// - missing: no text
function classifyTextQuality(text, showId, wordCount, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { quality: 'missing', truncationSignals: [], cleanedText: text };
  }

  // Detect truncation signals (also strips junk and checks for legitimate endings)
  const { signals, likelyTruncated, cleanedText, legitimateEnding } = detectTruncationSignals(text, excerptLength);

  // Use cleaned text for analysis
  const charCount = cleanedText.length;
  const cleanedWordCount = cleanedText.split(/\s+/).filter(w => w.length > 0).length;

  // Extract title from showId (e.g., "hamilton-2015" -> "hamilton")
  const titleLower = showId ? showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase() : '';
  const textLower = cleanedText.toLowerCase();
  const hasShowTitle = titleLower && textLower.includes(titleLower);

  // If truncation detected, mark as truncated regardless of length
  if (likelyTruncated) {
    return { quality: 'truncated', truncationSignals: signals, cleanedText };
  }

  // Full: >1500 chars AND mentions show title AND >300 words AND no severe truncation
  // Allow weak signals (no_ending_punctuation, possible_mid_word_cutoff) if legitimate ending
  const weakSignalsOnly = signals.every(s => ['no_ending_punctuation', 'possible_mid_word_cutoff'].includes(s));
  if (charCount > 1500 && hasShowTitle && cleanedWordCount > 300 && (signals.length === 0 || (weakSignalsOnly && legitimateEnding))) {
    return { quality: 'full', truncationSignals: signals.length === 0 ? [] : signals, cleanedText };
  }

  // Partial: 500-1500 chars OR larger but missing criteria
  if (charCount >= 500 && charCount <= 1500) {
    return { quality: 'partial', truncationSignals: signals, cleanedText };
  }
  if (charCount > 1500 && (!hasShowTitle || cleanedWordCount <= 300)) {
    return { quality: 'partial', truncationSignals: signals, cleanedText };
  }

  // Excerpt: <500 chars
  if (charCount < 500) {
    return { quality: 'excerpt', truncationSignals: signals, cleanedText };
  }

  return { quality: 'partial', truncationSignals: signals, cleanedText };
}

// Extract publishDate from raw HTML using JSON-LD, meta tags, and time elements
function extractPublishDateFromHtml(html) {
  if (!html || html.length < 100) return null;

  // 1. JSON-LD datePublished (most reliable)
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const jsonStr = match[1].trim();
      const data = JSON.parse(jsonStr);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const date = item.datePublished || item.dateCreated;
        if (date) {
          const normalized = normalizeExtractedDate(date);
          if (normalized) return normalized;
        }
      }
    } catch (e) { /* invalid JSON-LD, skip */ }
  }

  // 2. HTML meta tags
  const metaSelectors = [
    /meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
    /meta[^>]*property=["']og:article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i,
    /meta[^>]*name=["']DC\.date\.issued["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const regex of metaSelectors) {
    const m = html.match(regex);
    if (m && m[1]) {
      const normalized = normalizeExtractedDate(m[1]);
      if (normalized) return normalized;
    }
  }

  // 3. <time datetime="..."> in article context
  const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (timeMatch && timeMatch[1]) {
    const normalized = normalizeExtractedDate(timeMatch[1]);
    if (normalized) return normalized;
  }

  return null;
}

// Extract publishDate from URL path patterns: /YYYY/MM/DD/ or YYYY-MM-DD
// Fallback for when HTML has no date metadata. Conservative: validates calendar
// correctness and rejects show-title years (e.g. "1776").
function extractDateFromUrl(url) {
  if (!url) return null;
  const pathOnly = url.split('?')[0].split('#')[0];

  // Pattern 1: /YYYY/MM/DD/ (WordPress-style, most reliable)
  const slashMatch = pathOnly.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (slashMatch) {
    const result = validateUrlDate(slashMatch[1], slashMatch[2], slashMatch[3]);
    if (result) return result;
  }

  // Pattern 2: YYYY-MM-DD in path (Bloomberg, LA Times, etc.)
  const TITLE_YEARS = new Set(['1776', '1984', '1812', '1921', '1992', '1940', '2026']);
  const dashMatch = pathOnly.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dashMatch && !TITLE_YEARS.has(dashMatch[1])) {
    const result = validateUrlDate(dashMatch[1], dashMatch[2], dashMatch[3]);
    if (result) return result;
  }

  return null;
}

function validateUrlDate(yearStr, monthStr, dayStr) {
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  if (year < 1970 || year > 2027 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Calendar validity — catches Feb 30, etc.
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Extract publishDate from review text byline (first 500 chars).
// Only fires when exactly ONE date is found. Rejects run/closing dates.
const TEXT_DATE_PATTERNS = [
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/gi,
];
const TEXT_DATE_RUN_WORDS = /\b(through|until|closing|effective|expires|ends|extended|running|booking|playing|performances?)\b/i;
const TEXT_DATE_MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };

function extractDateFromText(fullText) {
  const header = fullText.substring(0, 500);
  const allMatches = [];
  for (const pat of TEXT_DATE_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(header)) !== null) {
      const before = header.substring(Math.max(0, m.index - 50), m.index).toLowerCase();
      if (TEXT_DATE_RUN_WORDS.test(before)) continue;
      allMatches.push(m[0]);
    }
  }
  if (allMatches.length !== 1) return null;

  const match = allMatches[0];
  const m1 = match.match(/^([A-Za-z]+)\s+(\d+)(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  const m2 = match.match(/^(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  let monthStr, day, year;
  if (m1) { monthStr = m1[1].toLowerCase(); day = parseInt(m1[2], 10); year = parseInt(m1[3], 10); }
  else if (m2) { day = parseInt(m2[1], 10); monthStr = m2[2].toLowerCase(); year = parseInt(m2[3], 10); }
  else return null;

  const month = TEXT_DATE_MONTHS[monthStr];
  if (!month || day < 1 || day > 31 || year < 1970 || year > 2027) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Normalize extracted date string to YYYY-MM-DD format
// Extracts date components directly from string to avoid timezone shift issues
// (e.g., "2024-03-15T23:30:00-05:00" → "2024-03-15", not "2024-03-16")
function normalizeExtractedDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  try {
    // Extract YYYY-MM-DD directly from the string before any timezone conversion
    const dateMatch = dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dateMatch) {
      const year = parseInt(dateMatch[1]);
      const month = parseInt(dateMatch[2]);
      const day = parseInt(dateMatch[3]);
      if (year < 1970 || year > 2030) return null;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    // Fallback: try Date parsing for non-ISO formats (e.g., "March 15, 2024")
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    if (year < 1970 || year > 2030) return null;
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch (e) {
    return null;
  }
}

// Map fetch method to standardized sourceMethod
function mapSourceMethod(method) {
  const map = {
    'playwright': 'playwright',
    'playwright-stealth': 'playwright',
    'browserbase': 'browserbase',
    'scrapingbee': 'scrapingbee',
    'brightdata': 'brightdata',
    'archive.org': 'archive',
    'archive': 'archive',
    'webfetch': 'webfetch',
    'amp': 'amp',
    'archive-today': 'archive-today',
  };
  return map[method] || method;
}

async function updateReviewJson(review, text, validation, archivePath, method, attempts, archiveData = {}, html = '', contentVerification = null) {
  const data = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));

  // Get excerpt length for truncation detection
  const excerptLength = Math.max(
    (data.dtliExcerpt || '').length,
    (data.bwwExcerpt || '').length,
    (data.showScoreExcerpt || '').length
  );

  // RESCORE TRIGGER: If adding fullText to a review that was scored on excerpt
  const hadFullTextBefore = data.fullText && data.fullText.length > 500;
  const hasLlmScore = data.llmScore && data.llmScore.score;
  const newTextIsSubstantial = text.length > 1000;

  if (!hadFullTextBefore && hasLlmScore && newTextIsSubstantial) {
    // Review was scored on excerpt, now has fullText - flag for rescoring
    data.needsRescore = true;
    data.rescoreReason = 'fullText added after excerpt-based scoring';
    console.log(`    → Flagged for rescore: was scored at ${data.llmScore.score} on excerpt, now has ${text.length} char fullText`);
  }

  // Clean text (decode entities, strip control chars, collapse whitespace, strip junk) before classification
  const preCleanedText = cleanText(text) || text;

  // Text quality classification with truncation detection (also strips trailing junk)
  const qualityResult = classifyTextQuality(preCleanedText, review.showId || data.showId, validation.wordCount, excerptLength);

  // Use cleaned text (junk stripped) if available, otherwise pre-cleaned
  const cleanedText = qualityResult.cleanedText || preCleanedText;
  // Clear stale contentVerification when fullText changes (prevents wrongArticle from blocking valid new text)
  if (data.contentVerification && data.contentVerification.wrongArticle && data.fullText !== cleanedText) {
    console.log(`    → Clearing stale contentVerification.wrongArticle (fullText updated)`);
    // Only clear wrongArticle-related fields; preserve wrongProduction, isFilmTv, etc.
    delete data.contentVerification.wrongArticle;
    delete data.contentVerification.verifiedAt;
    delete data.contentVerification.verifiedBy;
    delete data.contentVerification.reasoning;
    delete data.contentVerification.confidence;
    delete data.contentVerification.isValid;
  }
  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = cleanedText.split(/\s+/).filter(w => w.length > 0).length;
  data.archivePath = archivePath;
  data.textFetchedAt = new Date().toISOString();

  // Extract publishDate from HTML if not already set
  if (!data.publishDate && html) {
    const extractedDate = extractPublishDateFromHtml(html);
    if (extractedDate) {
      data.publishDate = extractedDate;
      console.log(`    → Extracted publishDate from HTML: ${extractedDate}`);
    }
  }

  // Fallback: extract publishDate from URL path (e.g. /2025/11/16/ or 2025-11-16)
  if (!data.publishDate && data.url) {
    const extractedDate = extractDateFromUrl(data.url);
    if (extractedDate) {
      data.publishDate = extractedDate;
      data.dateSource = 'url';
      console.log(`    → Extracted publishDate from URL: ${extractedDate}`);
    }
  }

  // Fallback 2: extract publishDate from first 500 chars of fullText (byline dates)
  // Only when exactly one date found. Rejects run/closing dates via context words.
  if (!data.publishDate && data.fullText && data.fullText.length > 100) {
    const extractedDate = extractDateFromText(data.fullText);
    if (extractedDate) {
      data.publishDate = extractedDate;
      data.dateSource = 'text-regex';
      console.log(`    → Extracted publishDate from text: ${extractedDate}`);
    }
  }

  // Clear previous LLM scoring rejection so re-scraped reviews can be scored again.
  // The scoring pipeline skips files with rejectionReason set.
  if (data.rejectionReason) {
    delete data.rejectionReason;
    delete data.rejectedAt;
    delete data.rejectedBy;
    delete data.rejectionReasoning;
    delete data.promptVersion;
  }

  // Extract original score from HTML/text if not already present,
  // or if the existing score came from Show Score (SS assigns its own stars,
  // which are wrong ~11% of the time and invented for outlets without native ratings).
  // Re-extract to replace SS-assigned scores with verified outlet scores.
  // Phase 2a: Run both old regex AND new LLM extraction, log disagreements, use LLM result
  const isSSSource = data.source === 'show-score' || data.source === 'show-score-playwright' || data.source === 'showscore-roundup';
  const hasUnverifiedSSScore = isSSSource && data.originalScore && !OUTLET_VERIFIED_SOURCES.has(data.scoreSource);
  if ((!data.originalScore || hasUnverifiedSSScore) && (html || text)) {
    const outletId = data.outletId || review.outletId || '';

    // Old regex extraction (for comparison logging)
    const regexResult = extractScore(html, text, outletId);

    // New LLM extraction (primary — async)
    let llmResult = null;
    try {
      llmResult = await extractExplicitScore({ text, html, outletId });
    } catch (e) {
      console.log(`    ⚠ LLM score extraction failed: ${e.message}`);
    }

    // Log disagreements between old and new
    if (regexResult && !llmResult) {
      console.log(`    ⚠ SCORE DIFF: regex found "${regexResult.originalScore}" but LLM returned null [${outletId}]`);
    } else if (!regexResult && llmResult) {
      console.log(`    ✦ SCORE DIFF: LLM found "${llmResult.originalScore}" (${llmResult.normalizedScore}) but regex returned null [${outletId}]`);
    } else if (regexResult && llmResult && regexResult.originalScore !== llmResult.originalScore) {
      console.log(`    ⚠ SCORE DIFF: regex="${regexResult.originalScore}" vs LLM="${llmResult.originalScore}" (${llmResult.normalizedScore}) [${outletId}]`);
    }

    // Use LLM result if available, otherwise fall back to regex
    const scoreResult = llmResult || regexResult;
    if (scoreResult) {
      if (hasUnverifiedSSScore) {
        console.log(`    → Replacing SS score (${data.originalScore}) with verified: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100) [${scoreResult.source}]`);
        data.previousShowScoreRating = data.originalScore;
      } else {
        console.log(`    → Extracted score: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100) [${scoreResult.source}]`);
      }
      data.originalScore = scoreResult.originalScore;
      data.originalScoreNormalized = scoreResult.normalizedScore;
      data.scoreSource = scoreResult.source;
      data.originalScoreSource = scoreResult.source;
      if (scoreResult.confidence) {
        data.scoreConfidence = scoreResult.confidence;
      }
    } else if (!hasUnverifiedSSScore) {
      // Both failed and no existing score — mark as pending for retry
      // Don't mark pending if we were trying to replace an SS score (keep SS as fallback)
      data.scoreExtractionPending = true;
    }
  }

  // Extract designation (Critics_Pick, Must_See, etc.) if not already present
  if (!data.designation && (html || text)) {
    const outletId = data.outletId || review.outletId || '';
    const designation = extractDesignation(html, text, outletId);
    if (designation) {
      data.designation = designation;
      console.log(`    → Extracted designation: ${designation}`);
    }
  }

  // New tracking fields
  data.fetchMethod = method;
  data.fetchAttempts = attempts;
  data.fetchTier = method === 'playwright' ? 1 : method === 'browserbase' ? 1.5 : method === 'scrapingbee' ? 2 : method === 'brightdata' ? 3 : 4;

  // Set quality fields from earlier classification
  data.textQuality = qualityResult.quality;
  data.truncationSignals = qualityResult.truncationSignals;

  // Update textStatus based on quality
  if (qualityResult.quality === 'full') {
    data.textStatus = 'complete';
  } else if (qualityResult.quality === 'truncated') {
    data.textStatus = 'truncated';
  } else {
    data.textStatus = validation.valid ? 'partial' : 'incomplete';
  }

  data.sourceMethod = mapSourceMethod(method);

  if (archiveData.archiveTimestamp) {
    data.archiveOrgTimestamp = archiveData.archiveTimestamp;
    data.archiveOrgUrl = archiveData.archiveUrl;
  }

  if (validation.issues.length > 0) {
    data.textIssues = validation.issues;
  } else {
    delete data.textIssues;
    delete data.textIssue;
  }

  // ========================================
  // POST-SCRAPE VALIDATION FLAGS (Phase 1)
  // ========================================

  // 1A. Show title mention check
  // If LLM verified the content → clear any stale showNotMentioned flag (LLM is a stronger signal)
  // If no LLM verification → fall back to heuristic title check
  if (contentVerification && contentVerification.verifiedBy?.startsWith('llm:')) {
    // LLM confirmed content is correct — clear stale flag from previous bad fetches
    if (data.showNotMentioned) {
      console.log(`    ✓ LLM verified correct show — clearing stale showNotMentioned flag`);
      delete data.showNotMentioned;
      delete data._showNotMentionedDiscoveryAttempted;
    }
  } else if (cleanedText.length > 500) {
    const showTitle = (data.showId || review.showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ');
    const showId = data.showId || review.showId || '';
    const showCheck = validateShowMentioned(cleanedText, showTitle, showId);
    if (!showCheck.valid && showCheck.confidence === 'high') {
      const alreadyScored = !!(data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100);
      if (alreadyScored) {
        // Don't destroy an already-scored review — flag for human review instead
        data.needsReview = true;
        data.needsReviewReason = `Heuristic: show not mentioned in text (${showCheck.reason}) but already scored — needs human verification`;
        console.log(`    ⚠ Heuristic: show not mentioned — but already scored, flagging for review instead of nulling`);
      } else {
        data.showNotMentioned = true;
        // Null out wrong fullText so it can't be scored — keep URL for URL discovery on next run
        data.wrongFullText = data.fullText;
        data.fullText = null;
        data.contentTier = (data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt) ? 'excerpt' : 'needs-rescrape';
        console.log(`    ⚠ Heuristic fallback — show not mentioned in text — fullText nulled: ${showCheck.reason}`);
      }
    } else {
      delete data.showNotMentioned;
    }
  }

  // 1B. Byline cross-check (exclude cast/creative names to avoid false positives)
  const showIdForByline = data.showId || review.showId || '';
  let bylineExcludeNames = [];
  try {
    if (!_showsJsonCache) {
      _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    }
    const showEntry = _showsJsonCache.shows.find(s => s.id === showIdForByline);
    if (showEntry) {
      bylineExcludeNames = [
        ...(showEntry.cast || []).map(c => c.name),
        ...(showEntry.creativeTeam || []).map(c => c.name)
      ];
    }
  } catch (e) { /* shows.json unavailable */ }
  const bylineResult = extractByline(cleanedText, { excludeNames: bylineExcludeNames });
  if (bylineResult.found) {
    const expectedCritic = data.criticName || review.critic || '';
    if (expectedCritic && expectedCritic !== 'Unknown' && !matchesCritic(bylineResult.name, expectedCritic)) {
      data.misattributedFullText = true;
      data.extractedByline = bylineResult.name;
      data.expectedCritic = expectedCritic;
      console.log(`    ⚠ Byline mismatch: found "${bylineResult.name}", expected "${expectedCritic}"`);
      // Strong mismatch at start of text = high confidence the fullText is from someone else.
      // Flag as fullTextWrongAuthor so rebuild keeps excerpts but distrusts fullText.
      // Only flag on position='start' (byline at top of article = strongest signal).
      if (bylineResult.position === 'start' && !data.fullTextWrongAuthor) {
        data.fullTextWrongAuthor = true;
        data._authorMismatch = `Byline at ${bylineResult.position}: "${bylineResult.name}", expected "${expectedCritic}"`;
        console.log(`    → Flagged fullTextWrongAuthor (byline at start of text)`);
      }
    } else {
      delete data.misattributedFullText;
      delete data.extractedByline;
      delete data.expectedCritic;
      // Clear stale fullTextWrongAuthor if byline now matches (re-fetched correct text)
      if (data.fullTextWrongAuthor && data._authorMismatch && data._authorMismatch.startsWith('Byline at')) {
        delete data.fullTextWrongAuthor;
        delete data._authorMismatch;
      }
    }
  }

  // 1B-iii. AUTHOR ENRICHMENT — resolve "Unknown" critics from HTML metadata
  // Skip if criticNameManual is set — this means the name was manually verified and should not be overwritten
  if ((!data.criticName || data.criticName === 'Unknown') && html && !data.criticNameManual) {
    const extractedAuthor = extractAuthorFromHtml(html, cleanedText, { excludeNames: bylineExcludeNames });
    if (extractedAuthor) {
      console.log(`    → Author enriched: "Unknown" → "${extractedAuthor}"`);
      data.criticName = extractedAuthor;
      data.criticEnrichedFrom = 'html-extraction';
      // Clear stale byline mismatch flag (it was "mismatched" against "Unknown")
      delete data.misattributedFullText;
      delete data.extractedByline;
      delete data.expectedCritic;

      // Rename file to match enriched critic name (prevents stale --unknown filenames)
      const currentFile = path.basename(review.filePath);
      if (currentFile.includes('--unknown')) {
        const showDir = path.dirname(review.filePath);
        const outletId = normalizeOutlet(data.outletId || data.outlet);
        const newFilename = generateReviewFilename(outletId, extractedAuthor);
        if (newFilename !== currentFile) {
          const newPath = path.join(showDir, newFilename);
          if (fs.existsSync(newPath)) {
            // Named file already exists — merge unique fields from --unknown into it, then delete --unknown
            try {
              const existingData = JSON.parse(fs.readFileSync(newPath, 'utf8'));
              let merged = false;
              for (const [key, val] of Object.entries(data)) {
                if (val != null && !existingData[key]) {
                  existingData[key] = val;
                  merged = true;
                }
              }
              if (merged) {
                fs.writeFileSync(newPath, JSON.stringify(existingData, null, 2) + '\n');
              }
              fs.unlinkSync(review.filePath);
              console.log(`    → Merged enriched --unknown into existing ${newFilename} and deleted stale file`);
              review.filePath = newPath;
            } catch (mergeErr) {
              console.warn(`    → Warning: could not merge into ${newFilename}: ${mergeErr.message}`);
            }
          } else {
            // No named file exists — just rename
            fs.renameSync(review.filePath, newPath);
            review.filePath = newPath;
            console.log(`    → Renamed ${currentFile} → ${newFilename}`);
          }
        }
      }
    }
  }

  // 1B-iv. OUTLET ENRICHMENT — resolve "unknown" outlets from URL domain
  if ((!data.outletId || data.outletId === 'unknown') && data.url) {
    const resolved = resolveOutletFromUrl(data.url);
    if (resolved && resolved.outletId) {
      console.log(`    → Outlet enriched: "unknown" → "${resolved.outletId}" (${resolved.displayName || resolved.outletId})`);
      data.outletId = resolved.outletId;
      data.outlet = resolved.displayName || getOutletDisplayName(resolved.outletId) || resolved.outletId;
      data.outletEnrichedFrom = 'url-resolution';
    }
  }

  // 1C. Content hash dedup (per-show)
  // Skip if duplicateTextOf was intentionally cleared (manual override)
  const fingerprint = computeContentFingerprint(cleanedText);
  if (fingerprint && !data.duplicateTextOfCleared) {
    const showDir = path.dirname(review.filePath);
    const currentFile = path.basename(review.filePath);
    try {
      const siblingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== currentFile);
      for (const sibling of siblingFiles) {
        const siblingPath = path.join(showDir, sibling);
        try {
          const siblingData = JSON.parse(fs.readFileSync(siblingPath, 'utf8'));
          if (siblingData.fullText) {
            const siblingFingerprint = computeContentFingerprint(siblingData.fullText);
            if (siblingFingerprint && siblingFingerprint === fingerprint) {
              data.duplicateTextOf = sibling;
              console.log(`    ⚠ Duplicate text of ${sibling}`);
              break;
            }
          }
        } catch (e) {
          // Skip unreadable sibling files
        }
      }
      if (!data.duplicateTextOf) {
        delete data.duplicateTextOf;
      }
    } catch (e) {
      // Skip if can't read directory
    }
  }

  // 1D. Content-show match verification (heuristic fallback — skipped when LLM verified)
  // Uses weighted signals (title, director, venue, cast) to detect wrong-show content.
  // Only auto-nulls on confident_mismatch (score <= -3) with 2+ independent negative signals.
  if ((!contentVerification || !contentVerification.verifiedBy?.startsWith('llm:')) && cleanedText && cleanedText.length > 500 && data.fullText) {
    const showIdForContent = data.showId || review.showId || '';
    let showMeta = null;
    try {
      if (!_showsJsonCache) {
        _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      }
      showMeta = _showsJsonCache.shows.find(s => s.id === showIdForContent);
    } catch (e) { /* shows.json unavailable */ }

    if (showMeta) {
      const contentMatch = verifyFullTextContent(cleanedText, showMeta);
      if (contentMatch.verdict === 'confident_mismatch' && contentMatch.negativeSignalCount >= 2) {
        const alreadyScored = !!(data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100);
        if (alreadyScored) {
          // Don't destroy an already-scored review — flag for human review instead
          data.needsReview = true;
          data.needsReviewReason = `Heuristic: content mismatch (score ${contentMatch.score}: ${contentMatch.negativeSignals.join(', ')}) but already scored — needs human verification`;
          console.log(`    ⚠ Heuristic: content mismatch — but already scored, flagging for review instead of nulling`);
        } else {
          const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
          data.wrongFullText = data.fullText;
          data.fullText = null;
          data.contentMismatchNote = contentMatch.negativeSignals.join('; ');
          data.contentMismatchScore = contentMatch.score;
          data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
          console.log(`    ⚠ Heuristic fallback — content mismatch (score ${contentMatch.score}): ${contentMatch.negativeSignals.join(', ')}`);
        }
      } else if (contentMatch.verdict === 'confident_mismatch' || contentMatch.verdict === 'probable_mismatch') {
        console.log(`    ⚠ Heuristic fallback — content match warning (${contentMatch.verdict}, score ${contentMatch.score}): ${contentMatch.negativeSignals.join(', ')}`);
      }
    }
  }

  // Store LLM content verification results and ACT on high-confidence rejections
  if (contentVerification) {
    data.contentVerification = {
      isValid: contentVerification.isValid,
      confidence: contentVerification.confidence,
      truncated: contentVerification.truncated,
      wrongArticle: contentVerification.wrongArticle,
      wrongProduction: contentVerification.wrongProduction,
      articleType: contentVerification.articleType,
      articleTypeConfidence: contentVerification.articleTypeConfidence,
      isFilmTv: contentVerification.isFilmTv,
      issues: contentVerification.issues,
      reasoning: contentVerification.reasoning,
      verifiedBy: contentVerification.verifiedBy,
      verifiedAt: new Date().toISOString(),
      contentHash: contentVerification.contentHash || null
    };

    const isHighConfidence = contentVerification.confidence === 'high' || contentVerification.confidence === 'medium';

    // Bug #12 guard: never null fullText on a review that already has an assignedScore.
    // Text re-collection can fetch wrong content (paywalled, wrong page, wrong production) but
    // the LLM seeing garbage text is NOT a reason to destroy a review that was already scored.
    // Instead: flag for human review so the bad text can be investigated without losing the score.
    const alreadyScored = !!(data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100);

    // Auto-invalidate on HIGH confidence wrong article type (preview, interview, news, etc.)
    // Medium confidence → log warning only (21% LLM error rate on article classification)
    if (contentVerification.wrongArticle) {
      const artConf = contentVerification.articleTypeConfidence || 'medium';
      const artType = contentVerification.articleType || 'unknown';
      if (artConf === 'high' && data.fullText) {
        if (alreadyScored) {
          // Don't destroy an already-scored review — flag for human review instead
          data.needsReview = true;
          data.needsReviewReason = `Collector LLM: not a review (${artType}, ${artConf} conf) but already scored — needs human verification`;
          console.log(`    ⚠ LLM: Not a review (${artType}, ${artConf} conf) — but already scored, flagging for review instead of nulling`);
        } else {
          data.wrongFullText = data.fullText;
          data.fullText = null;
          data.contentTier = 'invalid';
          data.incompleteReason = 'non_review';
          data.wrongShowReason = `Collector LLM: not a review (${artType}, confidence: ${artConf}) — ${(contentVerification.reasoning || '').substring(0, 200)}`;
          console.log(`    ✗ LLM: Not a review — ${artType} (${artConf} confidence) — fullText nulled, contentTier=invalid`);
        }
      } else if (artConf === 'medium') {
        console.log(`    ⚠ LLM: Possibly not a review — ${artType} (medium confidence) — no action taken`);
      }
    }

    // Auto-null fullText on high/medium confidence wrong production (tour, regional, off-Broadway, etc.)
    // Off-Broadway shows are exempt: they commonly transfer from regional theaters,
    // so LLM often misidentifies the production as "wrong" when it's actually correct.
    const showCat = _showsJsonCache?.shows?.find(s => s.id === data.showId)?.category;
    if (data.wrongProductionOverride || data.wrongProductionManualClear) {
      console.log(`    ⚠ wrongProductionOverride/ManualClear set — skipping wrongProduction check`);
    } else if (contentVerification.wrongProduction && isHighConfidence && data.fullText && showCat !== 'off-broadway') {
      if (alreadyScored) {
        // Don't destroy an already-scored review — flag for human review instead
        data.needsReview = true;
        data.needsReviewReason = `Collector LLM: wrong production (${contentVerification.confidence} conf) but already scored — needs human verification`;
        console.log(`    ⚠ LLM: Wrong production (${contentVerification.confidence}) — but already scored, flagging for review instead of nulling`);
      } else {
        const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
        data.wrongFullText = data.fullText;
        data.fullText = null;
        data.wrongProduction = true;
        data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
        console.log(`    ✗ LLM: Wrong production (${contentVerification.confidence}) — fullText nulled`);
      }
    } else if (contentVerification.wrongProduction && isHighConfidence && showCat === 'off-broadway') {
      console.log(`    ⚠ LLM: Wrong production detected but OB exempt — keeping fullText`);
    }

    // Auto-null fullText on high/medium confidence film/TV content
    if (contentVerification.isFilmTv && isHighConfidence && data.fullText) {
      if (alreadyScored) {
        // Don't destroy an already-scored review — flag for human review instead
        data.needsReview = true;
        data.needsReviewReason = `Collector LLM: film/TV content (${contentVerification.confidence} conf) but already scored — needs human verification`;
        console.log(`    ⚠ LLM: Film/TV content (${contentVerification.confidence}) — but already scored, flagging for review instead of nulling`);
      } else {
        const hasExcerpts = !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
        data.wrongFullText = data.fullText;
        data.fullText = null;
        data.wrongShow = true;
        data.wrongShowReason = `Collector LLM: film/TV content (${contentVerification.confidence}) — ${(contentVerification.reasoning || '').substring(0, 200)}`;
        data.contentTier = hasExcerpts ? 'excerpt' : 'needs-rescrape';
        console.log(`    ✗ LLM: Film/TV content (${contentVerification.confidence}) — fullText nulled`);
      }
    }

    // Flag low-confidence rejections for manual review instead of auto-acting
    if (!contentVerification.isValid && !isHighConfidence) {
      data.flaggedForReview = true;
      data.flagReason = `LLM verification: ${contentVerification.issues.join(', ')} (${contentVerification.confidence} confidence)`;
      console.log(`    ⚠ LLM: Low confidence rejection — flagged for manual review`);
    }

    if (contentVerification.truncated && data.fullText) {
      data.textQuality = 'truncated';
    }
  }

  // 1E. Heuristic fallback: Tour/film/TV contamination check
  // Only runs when LLM verification was not available (no API key, error, etc.)
  if ((!contentVerification || !contentVerification.verifiedBy?.startsWith('llm:')) && data.fullText && data.fullText.length >= 200) {
    const introText = data.fullText.slice(0, 600);
    const showIdForTour = data.showId || review.showId || '';

    // Tour detection (skip tour-stop shows)
    let isTourStop = false;
    try {
      if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
      const sm = _showsJsonCache.shows.find(s => s.id === showIdForTour);
      if (sm && sm.status === 'tour-stop') isTourStop = true;
    } catch (e) { /* shows.json unavailable */ }

    if (!isTourStop) {
      const tourCheck = isTourReviewExcerpt(introText);
      if (tourCheck.isTourReview) {
        data.possibleTourReview = true;
        data.tourSignal = tourCheck.signal;
        console.log(`    ⚠ Heuristic fallback — possible tour review: ${tourCheck.signal}`);
      }
    }

    // Film/TV detection
    const filmCheck = isFilmTvReview(introText);
    if (filmCheck.isFilmTv) {
      data.possibleFilmTvReview = true;
      data.filmTvSignals = filmCheck.signals;
      console.log(`    ⚠ Heuristic fallback — possible film/TV review: ${filmCheck.signals.join(', ')}`);
    }
  }

  // Reclassify contentTier using canonical 5-tier system
  // This ensures contentTier stays in sync whenever fullText changes
  // Also runs when fullText is missing — catches stale contentTier=complete on empty files
  {
    const tierResult = classifyContentTier(data);
    data.contentTier = tierResult.contentTier;
    data.wordCount = tierResult.wordCount;
    data.truncationSignals = tierResult.truncationSignals;
    data.tierReason = tierResult.tierReason;

    // Sync legacy fields with contentTier — rebuild-all-reviews reads textStatus at lines 492/2359
    const tierToTextStatus = { complete: 'complete', truncated: 'truncated', excerpt: 'incomplete', stub: 'incomplete' };
    const tierToTextQuality = { complete: 'full', truncated: 'truncated', excerpt: 'excerpt', stub: 'stub' };
    if (tierToTextStatus[data.contentTier]) {
      data.textStatus = tierToTextStatus[data.contentTier];
    }
    if (tierToTextQuality[data.contentTier]) {
      data.textQuality = tierToTextQuality[data.contentTier];
    }
    data.isFullReview = data.contentTier === 'complete';
  }

  // Set incompleteReason if content is not complete
  if (data.contentTier && data.contentTier !== 'complete') {
    const reasonResult = classifyIncompleteReason(data, null);
    if (reasonResult) {
      data.incompleteReason = reasonResult.incompleteReason;
      data.incompleteDetail = reasonResult.incompleteDetail;
    }
  } else {
    delete data.incompleteReason;
    delete data.incompleteDetail;
  }

  // NOTE: Do NOT extract years from URLs to flag wrong production.
  // URL patterns are inconsistent across outlets (republished content, migrated URLs,
  // article IDs that resemble years, etc.). Use publish date or review text content instead.

  fs.writeFileSync(review.filePath, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState() {
  const statePath = path.join(CONFIG.stateDir, 'progress.json');
  if (fs.existsSync(statePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const startTime = new Date(saved.startTime);
      const hoursSinceStart = (Date.now() - startTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceStart < 24) {
        console.log(`Resuming from previous run (${saved.processed.length} already processed)`);
        state = saved;
        // Ensure tierBreakdown and all sub-arrays exist (older state files may be missing keys)
        if (!state.tierBreakdown) {
          state.tierBreakdown = { playwright: [], amp: [], browserbase: [], directCookies: [], scrapingbee: [], brightdata: [], archiveToday: [], archive: [] };
        } else {
          for (const key of ['playwright', 'amp', 'browserbase', 'scrapingbee', 'brightdata', 'archiveToday', 'archive']) {
            if (!state.tierBreakdown[key]) state.tierBreakdown[key] = [];
          }
        }
        if (!state.log) state.log = [];
        return true;
      }
    } catch (e) {
      console.log('Could not load previous state, starting fresh');
    }
  }
  return false;
}

function saveState() {
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG.stateDir, 'progress.json'),
    JSON.stringify(state, null, 2)
  );

  // Write a human-readable progress log for real-time monitoring
  // (committed with each checkpoint so progress is visible via git log)
  const log = {
    updatedAt: new Date().toISOString(),
    processed: state.processed?.length || 0,
    failed: state.failed?.length || 0,
    successRate: state.processed?.length
      ? `${((state.processed.length / (state.processed.length + (state.failed?.length || 0))) * 100).toFixed(1)}%`
      : '0%',
    tierBreakdown: {
      playwright: state.tierBreakdown?.playwright?.length || 0,
      amp: state.tierBreakdown?.amp?.length || 0,
      browserbase: state.tierBreakdown?.browserbase?.length || 0,
      directCookies: state.tierBreakdown?.directCookies?.length || 0,
      scrapingbee: state.tierBreakdown?.scrapingbee?.length || 0,
      brightdata: state.tierBreakdown?.brightdata?.length || 0,
      archiveToday: state.tierBreakdown?.archiveToday?.length || 0,
      archive: state.tierBreakdown?.archive?.length || 0,
    },
    browserbaseSessions: stats.browserbaseSessionsUsed || 0,
    recentActivity: (state.log || []).slice(-20),
  };
  fs.writeFileSync(
    path.join(CONFIG.stateDir, 'live-progress.json'),
    JSON.stringify(log, null, 2)
  );
}

/**
 * Push local commits to the public repo remote.
 * Separated from commitChanges so pushes can be less frequent than commits.
 *
 * Conflict resolution: collection-state/ files are per-run state that should
 * always keep the current run's version. During rebase, "theirs" = our commits
 * being replayed, so --theirs keeps our data. During merge, "ours" = our branch.
 */
function _pushToRemote(processed) {
  const { execSync } = require('child_process');
  let pushSucceeded = false;

  try {
    execSync('git fetch origin main', { stdio: 'pipe' });

    // Try rebase with -X theirs (keeps our commits' content on conflict)
    try {
      execSync('git rebase -X theirs origin/main', { stdio: 'pipe' });
      pushSucceeded = true;
    } catch (rebaseErr) {
      console.log('    Rebase conflict detected, auto-resolving state files...');
      // In rebase context: --theirs = our commits being replayed (what we want to keep)
      // Resolve up to 4 rounds of conflicts (multiple commits may each conflict)
      for (let round = 0; round < 4 && !pushSucceeded; round++) {
        try {
          // Auto-resolve: keep ours for state files, theirs for everything else
          const conflicted = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8', stdio: 'pipe' }).trim();
          if (!conflicted) break;
          for (const file of conflicted.split('\n').filter(Boolean)) {
            if (file.startsWith('data/collection-state/') || file.startsWith('data/audit/')) {
              execSync(`git checkout --theirs "${file}"`, { stdio: 'pipe' });
            } else {
              execSync(`git checkout --ours "${file}"`, { stdio: 'pipe' });
            }
            execSync(`git add "${file}"`, { stdio: 'pipe' });
          }
          execSync('git rebase --continue', { stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
          pushSucceeded = true;
        } catch (continueErr) {
          // More conflicts in next commit — loop will retry
        }
      }
      if (!pushSucceeded) {
        try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch (e) {}
      }
    }

    // Fallback: merge with ours strategy (in merge context, ours = our branch)
    if (!pushSucceeded) {
      console.log('    Trying merge approach...');
      try {
        execSync('git merge origin/main -X ours --no-edit', { stdio: 'pipe' });
        pushSucceeded = true;
      } catch (mergeErr) {
        console.log('    Merge also failed');
        try { execSync('git merge --abort', { stdio: 'pipe' }); } catch (e) {}
      }
    }

    if (pushSucceeded) {
      execSync('git push origin HEAD:main', { stdio: 'pipe' });
      console.log(`  ✓ Pushed checkpoint to remote (${processed} reviews)`);
    } else {
      throw new Error('Could not sync with remote');
    }
  } catch (syncErr) {
    console.log(`    ⚠ Checkpoint push failed (will be caught by final workflow commit): ${syncErr.message}`);
  }
}

/**
 * Commit changes to git (for incremental saving during long runs).
 * Local commits happen every batch (cheap). Remote pushes happen every
 * pushEveryNBatches to reduce git contention with other workflows.
 */
let _batchesSinceLastPush = 0;

function commitChanges(processed, forcePush = false) {
  const { execSync } = require('child_process');

  try {
    // Check if we're in a git repo and in CI
    if (!process.env.GITHUB_ACTIONS) {
      console.log('  (Skipping git commit - not in GitHub Actions)');
      return;
    }

    // Stage changes
    // Note: data/review-texts/ and data/archives/ are in .gitignore (review-texts pushed to private repo)
    execSync('git add data/collection-state/', {
      stdio: 'pipe'
    });

    // Check if there are staged changes
    const status = execSync('git diff --staged --quiet || echo "changes"', {
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();

    if (status === 'changes') {
      // Configure git (in case not already done)
      try {
        execSync('git config user.email "action@github.com"', { stdio: 'pipe' });
        execSync('git config user.name "GitHub Action"', { stdio: 'pipe' });
      } catch (e) {
        // Already configured
      }

      // Build descriptive commit message with tier stats
      const bbUsed = stats.browserbaseSessionsUsed || 0;
      const failCount = state.failed?.length || 0;
      const tierInfo = [];
      if ((state.tierBreakdown?.playwright?.length || 0) > 0) tierInfo.push(`PW:${state.tierBreakdown.playwright.length}`);
      if (bbUsed > 0) tierInfo.push(`BB:${bbUsed}`);
      if ((state.tierBreakdown?.brightdata?.length || 0) > 0) tierInfo.push(`BD:${state.tierBreakdown.brightdata.length}`);
      if ((state.tierBreakdown?.archive?.length || 0) > 0) tierInfo.push(`Ar:${state.tierBreakdown.archive.length}`);
      const tierStr = tierInfo.length ? ` [${tierInfo.join(',')}]` : '';
      const failStr = failCount > 0 ? ` (${failCount} failed)` : '';
      const ctFilter = CONFIG.contentTierFilter ? ` (${CONFIG.contentTierFilter})` : '';

      execSync(`git commit -m "chore: Checkpoint - collected ${processed} review texts${ctFilter}${tierStr}${failStr}"`, {
        stdio: 'pipe'
      });

      console.log(`  ✓ Committed checkpoint locally (${processed} reviews)`);
    } else {
      console.log('  (No changes to commit)');
    }

    // Only push to remotes every N batches (or when forced, e.g. final commit)
    // This reduces git contention — local commits are cheap, pushes cause conflicts
    _batchesSinceLastPush++;
    const shouldPush = forcePush || _batchesSinceLastPush >= CONFIG.pushEveryNBatches;

    if (shouldPush) {
      _batchesSinceLastPush = 0;
      _pushToRemote(processed);
      pushReviewTextsCheckpoint(processed);
    }

  } catch (e) {
    console.error(`  ✗ Git commit/push FAILED: ${e.message}`);
    console.error(`    This means work may be lost if the job times out!`);
    console.error(`    Check workflow permissions: needs 'contents: write'`);
    // Don't throw - we don't want to stop the collection
  }
}

/**
 * Push review-texts to private repo as a checkpoint.
 * Runs at every checkpoint so data is saved incrementally, not just at the end.
 */
function pushReviewTextsCheckpoint(processed) {
  if (!process.env.REVIEW_TEXTS_TOKEN || !process.env.GITHUB_ACTIONS) return;

  const rtDir = path.join(process.cwd(), 'data', 'review-texts');
  if (!fs.existsSync(path.join(rtDir, '.git'))) {
    console.log('  (No private repo checkout — skipping review-texts push)');
    return;
  }

  const { execSync } = require('child_process');

  try {
    // Configure git for private repo
    execSync('git config user.name "GitHub Action"', { cwd: rtDir, stdio: 'pipe' });
    execSync('git config user.email "action@github.com"', { cwd: rtDir, stdio: 'pipe' });

    // Ensure remote uses the token
    const remoteUrl = `https://x-access-token:${process.env.REVIEW_TEXTS_TOKEN}@github.com/thomaspryor/broadway-review-texts.git`;
    try {
      execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: rtDir, stdio: 'pipe' });
    } catch (e) {
      execSync(`git remote add origin "${remoteUrl}"`, { cwd: rtDir, stdio: 'pipe' });
    }

    // Stage all changes
    execSync('git add -A', { cwd: rtDir, stdio: 'pipe' });

    // Check if there are changes
    try {
      execSync('git diff --staged --quiet', { cwd: rtDir, stdio: 'pipe' });
      // No changes
      return;
    } catch (e) {
      // Has changes — continue
    }

    // Commit
    const msg = `chore: Checkpoint review texts (${processed} collected)`;
    execSync(`git commit -m "${msg}"`, { cwd: rtDir, stdio: 'pipe' });

    // Push with retry (same pattern as push-review-texts action)
    for (let i = 1; i <= 3; i++) {
      try {
        execSync('git pull --rebase -X theirs origin main', { cwd: rtDir, stdio: 'pipe' });
        execSync('git push origin main', { cwd: rtDir, stdio: 'pipe' });
        console.log(`  ✓ Pushed review-texts checkpoint to private repo (attempt ${i})`);
        return;
      } catch (pushErr) {
        // Handle modify/delete conflicts
        try {
          const unmerged = execSync('git diff --name-only --diff-filter=U', { cwd: rtDir, encoding: 'utf8', stdio: 'pipe' }).trim();
          if (unmerged) {
            for (const f of unmerged.split('\n').filter(Boolean)) {
              if (fs.existsSync(path.join(rtDir, f))) {
                execSync(`git add "${f}"`, { cwd: rtDir, stdio: 'pipe' });
              } else {
                execSync(`git rm "${f}"`, { cwd: rtDir, stdio: 'pipe' });
              }
            }
            execSync('git rebase --continue', { cwd: rtDir, stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
            execSync('git push origin main', { cwd: rtDir, stdio: 'pipe' });
            console.log(`  ✓ Pushed review-texts checkpoint after conflict resolution (attempt ${i})`);
            return;
          }
        } catch (e2) {
          // Conflict resolution failed
        }
        try { execSync('git rebase --abort', { cwd: rtDir, stdio: 'pipe' }); } catch (e3) {}
        if (i < 3) {
          const wait = Math.floor(Math.random() * 10) + 5;
          execSync(`sleep ${wait}`, { stdio: 'pipe' });
        }
      }
    }
    console.log('  ⚠ Failed to push review-texts checkpoint (will retry at next checkpoint)');
  } catch (e) {
    console.log(`  ⚠ Review-texts checkpoint push error: ${e.message}`);
  }
}

// ============================================================================
// FIND REVIEWS TO PROCESS
// ============================================================================

function findReviewsToProcess() {
  const reviews = [];

  if (!fs.existsSync(CONFIG.reviewTextsDir)) {
    console.log(`Creating ${CONFIG.reviewTextsDir} directory...`);
    fs.mkdirSync(CONFIG.reviewTextsDir, { recursive: true });
    return reviews;
  }

  // Load show statuses + opening dates so we can prioritize recent shows
  const openShowIds = new Set();
  const showOpeningDates = new Map(); // showId → openingDate string
  try {
    const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    (showsData.shows || showsData).forEach(s => {
      if (s.status === 'open' || s.status === 'previews') openShowIds.add(s.id);
      if (s.openingDate) showOpeningDates.set(s.id, s.openingDate);
    });
    console.log(`  Prioritizing ${openShowIds.size} open/preview shows`);
  } catch (e) {
    console.log('  ⚠ Could not load shows.json for prioritization');
  }

  if (CONFIG.reviewFilter.size > 0) {
    console.log(`  🎯 FAST PATH: Only processing ${CONFIG.reviewFilter.size} specific file(s): ${[...CONFIG.reviewFilter].join(', ')}`);
  }

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => fs.statSync(path.join(CONFIG.reviewTextsDir, f)).isDirectory());

  // Load failed fetches — skip permanently failed URLs (5+ failures, or 3+ confirmed dead)
  const failedFetches = new Set();  // For retry mode: IDs to include
  const permanentlyFailed = new Set();  // IDs to always skip (too many failures)
  let permanentSkipCount = 0;
  const failedPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
  if (fs.existsSync(failedPath)) {
    try {
      const failed = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
      for (const f of failed) {
        const id = f.reviewId || `${f.showId}/${f.file}`;
        const count = f.failureCount || 1;
        const reason = f.failureReason || '';
        // Permanently skip if: confirmed dead URL with 3+ failures, other reasons with 5+ failures,
        // or garbage_content with 3+ failures (site returns content but not the review — won't improve)
        const isConfirmedDead = reason === 'url_dead_404' || reason === 'url_dead_410';
        const isExhaustedGarbage = reason === 'garbage_content' && count >= 3;
        const threshold = isConfirmedDead ? 3 : 5;
        if ((reason !== 'garbage_content' && count >= threshold) || isExhaustedGarbage) {
          permanentlyFailed.add(id);
          permanentSkipCount++;
        } else if (CONFIG.retryFailed) {
          failedFetches.add(id);
        }
      }
    } catch (e) {}
  }
  if (permanentSkipCount > 0) {
    console.log(`  Skipping ${permanentSkipCount} permanently failed reviews (dead 3+, other 5+, garbage 3+)`);
  }

  for (const showId of shows) {
    if (CONFIG.showFilter && !CONFIG.showFilterSet.has(showId)) continue;
    if (CONFIG.marketFilter && !showId.includes(CONFIG.marketFilter)) continue;

    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      // Skip if review_filter is active and this file isn't in it
      if (CONFIG.reviewFilter.size > 0 && !CONFIG.reviewFilter.has(file)) continue;

      const filePath = path.join(showDir, file);
      const reviewId = `${showId}/${file}`;

      // Skip permanently failed (3+ failures across runs)
      // Bypass when explicitly targeting files (review_filter or show_filter) — always retry
      if (permanentlyFailed.has(reviewId) && CONFIG.reviewFilter.size === 0 && !CONFIG.showFilter) continue;
      // Skip already processed in this run
      if (state.processed.includes(reviewId)) continue;
      // Skip failed unless retry mode
      if (!CONFIG.retryFailed && state.failed.includes(reviewId)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip fabricated entries unless a reason_filter is active (enables targeted recovery)
        if (data.fabricatedEntry === true && CONFIG.incompleteReasonFilter.length === 0) continue;

        // Skip permanently retired URLs (broken redirects, etc.) — these are in failed-fetches.json
        // too, but checking the file field avoids re-reading failed-fetches for files added after load
        if (data.incompleteReason === 'permanently_unavailable' && CONFIG.incompleteReasonFilter.length === 0) continue;

        // Skip misattributed/wrong reviews (unless explicitly targeting wrong_content)
        const isWrongContent = data.wrongAttribution || data.wrongProduction || data.wrongShow;
        if (isWrongContent && !CONFIG.incompleteReasonFilter.includes('wrong_content')) {
          // Allow retry for collector-flagged wrongShow files (bad scrape of correct URL)
          // These have wrongShowReason starting with "Collector LLM" — distinguishes from
          // cross-show collisions ("Cross-show") and scorer flags (no wrongShowReason)
          const isCollectorFlagged = data.wrongShow && typeof data.wrongShowReason === 'string'
            && data.wrongShowReason.startsWith('Collector LLM');
          const retryAge = data.wrongShowRetryAt ? Date.now() - new Date(data.wrongShowRetryAt).getTime() : Infinity;
          const retryAllowed = isCollectorFlagged && retryAge > 14 * 24 * 60 * 60 * 1000; // 14-day cooldown
          if (!retryAllowed) {
            continue;
          }
          // Mark retry attempt timestamp
          data._wrongShowRetrying = true;
        }

        // Skip if already has good text (unless retrying failed or filtering by reason)
        // When filtering by incompleteReason, trust the reason field instead of re-checking text length
        // (important: wrong_content reviews may have long text from the *wrong* page)
        if (CONFIG.incompleteReasonFilter.length === 0) {
          const textLen = data.fullText ? data.fullText.length : 0;
          const isTruncated = data.textQuality === 'truncated' || data.textStatus === 'truncated'
            || data.contentTier === 'truncated' || data.contentTier === 'needs-rescrape';
          // Re-process showNotMentioned reviews for URL discovery (even if they have long text)
          const needsUrlDiscovery = data.showNotMentioned === true && !data._showNotMentionedDiscoveryAttempted;
          // Re-collect if existing fullText is garbage (cookie consent, GDPR banners, etc.)
          const hasGarbageText = textLen > 0 && isGarbageContent(data.fullText).isGarbage;
          // Always re-try truncated/needs-rescrape reviews - they have text but it's incomplete or garbage
          if (!isTruncated && !needsUrlDiscovery && !hasGarbageText && (data.isFullReview === true || data.textQuality === 'full' || textLen > 1500) && !failedFetches.has(reviewId)) {
            continue;
          }
          // Guard: never re-fetch a review that has an assigned score + reasonable text, even if it
          // appears in failedFetches. Re-collection can destroy live scored reviews by fetching garbage
          // and triggering LLM rejection flags that null fullText and delete assignedScore.
          // Override: explicit reviewFilter (specific file targeting) bypasses this guard.
          if (shouldSkipScoredReview(data, CONFIG.reviewFilter.size)) {
            continue;
          }
        }

        // Skip if no URL (unless explicitly targeting no_url reviews for SERP discovery)
        if (!data.url && !CONFIG.incompleteReasonFilter.includes('no_url')) continue;

        // Skip print-only outlets — no online content exists, SERP discovery wastes API credits
        if (UNCOLLECTABLE_OUTLETS.has((data.outletId || '').toLowerCase())) continue;

        // Determine outlet tier
        const outletId = (data.outletId || '').toLowerCase();
        const isTier1 = CONFIG.tier1Outlets.some(t => outletId.includes(t));
        const isTier2 = CONFIG.tier2Outlets.some(t => outletId.includes(t));
        const isTier3 = CONFIG.tier3Outlets.some(t => outletId.includes(t));

        // Determine tier number (1, 2, 3, or 4 for unknown)
        let tierNum = 4; // Default to unknown tier
        if (isTier1) tierNum = 1;
        else if (isTier2) tierNum = 2;
        else if (isTier3) tierNum = 3;

        // Apply priority filter
        if (CONFIG.priority === 'tier1' && !isTier1) continue;

        // Apply outlet tier filter (for parallel matrix strategy)
        if (CONFIG.outletTier) {
          if (CONFIG.outletTier === 'tier1' && tierNum !== 1) continue;
          if (CONFIG.outletTier === 'tier2' && tierNum !== 2) continue;
          if (CONFIG.outletTier === 'tier3' && (tierNum !== 3 && tierNum !== 4)) continue;
        }

        // Apply content tier filter (for targeted runs: excerpt, truncated, needs-rescrape)
        if (CONFIG.contentTierFilter) {
          const ct = data.contentTier || '';
          if (CONFIG.contentTierFilter === 'excerpt' && ct !== 'excerpt') continue;
          if (CONFIG.contentTierFilter === 'truncated' && ct !== 'truncated') continue;
          if (CONFIG.contentTierFilter === 'needs-rescrape' && ct !== 'needs-rescrape') continue;
        }

        // Apply domain filter (for targeted soft-paywall collection runs)
        if (CONFIG.domainFilter.length > 0 && data.url) {
          try {
            const urlDomain = new URL(data.url).hostname.replace(/^www\./, '');
            if (!CONFIG.domainFilter.some(d => urlDomain === d || urlDomain.endsWith('.' + d))) continue;
          } catch (e) {
            continue; // Skip reviews with unparseable URLs when domain filter is active
          }
        }

        // Apply domain exclusion filter (for free-outlet collection — exclude paywall domains)
        if (CONFIG.excludeDomains.length > 0 && data.url) {
          try {
            const urlDomain = new URL(data.url).hostname.replace(/^www\./, '');
            if (CONFIG.excludeDomains.some(d => urlDomain === d || urlDomain.endsWith('.' + d))) continue;
          } catch (e) {
            // Keep reviews with unparseable URLs when using exclusion mode
          }
        }

        // Apply incompleteReason filter
        if (CONFIG.incompleteReasonFilter.length > 0) {
          const reason = data.incompleteReason || '';
          if (!CONFIG.incompleteReasonFilter.includes(reason)) continue;
        }

        // Parse publish date for archive-first logic
        let publishDate = null;
        if (data.publishDate) {
          try {
            publishDate = new Date(data.publishDate);
          } catch (e) {}
        }

        // Count previous fetch attempts (from file + failed-fetches.json)
        const fileAttempts = Array.isArray(data.fetchAttempts) ? data.fetchAttempts.length : 0;

        reviews.push({
          reviewId,
          filePath,
          showId,
          file,
          outlet: data.outlet,
          outletId: data.outletId,
          critic: data.criticName,
          url: data.url,
          isTier1,
          tierNum,
          priority: tierNum,
          publishDate,
          showNotMentioned: data.showNotMentioned || false,
          isOpenShow: openShowIds.has(showId),
          openingDate: showOpeningDates.get(showId) || '1900-01-01',
          incompleteReason: data.incompleteReason || null,
          fabricatedEntry: data.fabricatedEntry || false,
          fetchAttempts: fileAttempts,
          wrongShow: data.wrongShow || false,
          wrongShowReason: data.wrongShowReason || null,
        });
      } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
      }
    }
  }

  // Sort: open/preview shows first (unless CLOSED_SHOW_MODE),
  // then newest shows first (by openingDate desc),
  // then never-attempted before previously-attempted,
  // then by outlet tier priority
  const closedShowMode = process.env.CLOSED_SHOW_MODE === 'true';
  reviews.sort((a, b) => {
    if (!closedShowMode) {
      if (a.isOpenShow !== b.isOpenShow) return a.isOpenShow ? -1 : 1;
    }
    // Newest shows first (descending openingDate) — so a show that opened
    // last night gets collected before a show that opened 3 years ago
    if (a.openingDate !== b.openingDate) return b.openingDate.localeCompare(a.openingDate);
    // Never-attempted reviews before previously-attempted ones
    const aAttempted = a.fetchAttempts > 0 ? 1 : 0;
    const bAttempted = b.fetchAttempts > 0 ? 1 : 0;
    if (aAttempted !== bAttempted) return aAttempted - bAttempted;
    return a.priority - b.priority;
  });

  // Log sort stats
  const neverAttempted = reviews.filter(r => r.fetchAttempts === 0).length;
  const previouslyAttempted = reviews.length - neverAttempted;
  console.log(`  Queue: ${reviews.length} reviews (${neverAttempted} never attempted, ${previouslyAttempted} previously attempted)`);

  // Apply max limit
  if (CONFIG.maxReviews > 0) {
    return reviews.slice(0, CONFIG.maxReviews);
  }

  return reviews;
}

// ============================================================================
// BROWSER SETUP
// ============================================================================

async function setupBrowser() {
  console.log('\nLaunching browser with stealth...');

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  });

  // Enhanced stealth scripts (even with playwright-extra)
  await context.addInitScript(() => {
    // Override webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ],
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // Override platform
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });

    // Override hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

    // Override device memory
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // Override maxTouchPoints
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Chrome runtime
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // Permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // WebGL vendor/renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.apply(this, arguments);
    };
  });

  // Inject cookies for paywalled domains (bypasses login entirely)
  for (const domain of Object.keys(COOKIE_DOMAIN_MAP)) {
    const injected = await injectCookies(context, domain);
    if (injected) {
      cookieInjectedDomains.add(domain);
      loggedInDomains.add(domain); // Mark as "logged in" so loginToSite() is skipped
    }
  }

  page = await context.newPage();
  console.log('✓ Browser ready');
}

async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch (e) {
      // Browser may already be closed
    }
    browser = null;
    context = null;
    page = null;
  }
}

/**
 * Check if browser is healthy, restart if crashed
 */
async function ensureBrowserHealthy() {
  try {
    // Quick health check - try to get browser contexts
    if (!browser || !context || !page) {
      throw new Error('Browser not initialized');
    }
    // Try a simple operation to verify browser is responsive
    await page.evaluate(() => true).catch(() => {
      throw new Error('Page not responsive');
    });
    return true;
  } catch (e) {
    console.log(`  ⚠ Browser unhealthy: ${e.message}`);
    browserCrashCount++;

    if (browserCrashCount > MAX_BROWSER_CRASHES) {
      console.log(`  ✗ Too many browser crashes (${browserCrashCount}), skipping Playwright tier`);
      return false;
    }

    console.log(`  → Restarting browser (crash #${browserCrashCount})...`);
    await closeBrowser();
    await sleep(2000); // Brief pause before restart

    try {
      await setupBrowser();
      console.log(`  ✓ Browser restarted successfully`);
      return true;
    } catch (restartError) {
      console.log(`  ✗ Browser restart failed: ${restartError.message}`);
      return false;
    }
  }
}

// ============================================================================
// PERMANENT FAILURE TRACKING
// ============================================================================

/**
 * Record a fetch failure to failed-fetches.json with failure count tracking.
 * Increments failureCount on each call. After 3+ failures, the review will
 * be skipped on future runs (permanent failure).
 */
function recordFailedFetch(review, reason, details = {}) {
  const failedFetchesPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
  let failedFetches = [];
  if (fs.existsSync(failedFetchesPath)) {
    try {
      failedFetches = JSON.parse(fs.readFileSync(failedFetchesPath, 'utf8'));
    } catch (e) {
      failedFetches = [];
    }
  }

  // Find existing entry for this review
  const existingIdx = failedFetches.findIndex(f => f.reviewId === review.reviewId);
  const existing = existingIdx >= 0 ? failedFetches[existingIdx] : null;
  const prevCount = existing?.failureCount || 0;

  const entry = {
    reviewId: review.reviewId,
    showId: review.showId,
    outlet: review.outlet,
    critic: review.critic,
    url: review.url,
    failureReason: reason,
    failureCount: prevCount + 1,
    lastFailedAt: new Date().toISOString(),
    firstFailedAt: existing?.firstFailedAt || new Date().toISOString(),
    ...details,
  };

  if (existingIdx >= 0) {
    failedFetches[existingIdx] = entry;
  } else {
    failedFetches.push(entry);
  }

  // Remove any duplicate entries for this reviewId (cleanup for historical bug)
  const finalIdx = failedFetches.findIndex(f => f.reviewId === review.reviewId);
  failedFetches = failedFetches.filter((f, i) => f.reviewId !== review.reviewId || i === finalIdx);

  try {
    fs.writeFileSync(failedFetchesPath, JSON.stringify(failedFetches, null, 2));
  } catch (e) {
    // Non-fatal — don't crash the run over tracking
  }

  // Set incompleteReason on the review source file
  try {
    const reviewFilePath = path.join(CONFIG.reviewTextsDir, review.reviewId);
    if (fs.existsSync(reviewFilePath)) {
      const reviewData = JSON.parse(fs.readFileSync(reviewFilePath, 'utf8'));
      const reasonResult = classifyIncompleteReason(reviewData, entry);
      if (reasonResult) {
        reviewData.incompleteReason = reasonResult.incompleteReason;
        reviewData.incompleteDetail = reasonResult.incompleteDetail;
        fs.writeFileSync(reviewFilePath, JSON.stringify(reviewData, null, 2) + '\n');
      }
    }
  } catch (e) {
    // Non-fatal
  }

  const isConfirmedDead = reason === 'url_dead_404' || reason === 'url_dead_410';
  const threshold = isConfirmedDead ? 3 : 5;
  if (reason !== 'garbage_content' && entry.failureCount >= threshold) {
    console.log(`    ⚠ Permanently failed (${entry.failureCount} attempts, reason: ${reason}) — will skip on future runs`);
  }
}

/**
 * Remove a review from failed-fetches.json when it succeeds.
 */
function clearFailedFetch(reviewId) {
  const failedFetchesPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
  if (!fs.existsSync(failedFetchesPath)) return;
  try {
    const failedFetches = JSON.parse(fs.readFileSync(failedFetchesPath, 'utf8'));
    const filtered = failedFetches.filter(f => f.reviewId !== reviewId);
    if (filtered.length < failedFetches.length) {
      fs.writeFileSync(failedFetchesPath, JSON.stringify(filtered, null, 2));
    }
  } catch (e) {
    // Non-fatal
  }
}

// ============================================================================
// PROCESS REVIEW
// ============================================================================

async function processReview(review) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`Processing: ${review.outlet} - ${review.critic}`);
  console.log(`URL: ${review.url}`);

  // Create a fresh page for each review to prevent state contamination
  try {
    if (context && page) {
      await page.close().catch(() => {});
      page = await context.newPage();
    }
  } catch (e) {
    // Browser likely crashed — try full restart before giving up
    console.log(`  ⚠ Could not create fresh page: ${e.message}`);
    try {
      await closeBrowser();
      await setupBrowser();
    } catch (restartErr) {
      console.log(`  ⚠ Browser restart failed: ${restartErr.message}`);
    }
  }

  // Reason-aware URL discovery: no_url, wrong_content, and fabricated entries need SERP search before fetch
  const needsSerpDiscovery = review.incompleteReason === 'no_url' || review.incompleteReason === 'wrong_content' || review.fabricatedEntry;
  if (needsSerpDiscovery && review.filePath) {
    const reason = review.fabricatedEntry ? 'fabricated' : review.incompleteReason;
    console.log(`  [${reason}] Attempting URL discovery before fetch...`);
    const discoveredUrl = await discoverCorrectUrl(review);

    if (discoveredUrl === '__SERP_UNAVAILABLE__') {
      stats.totalFailed++;
      return { success: false, error: 'serp_unavailable' };
    }

    if (discoveredUrl) {
      console.log(`  [${reason}] Discovered: ${review.url || '(none)'} → ${discoveredUrl}`);
      // Update URL on file, but keep wrong-content flags until fetch succeeds
      // (race condition: if we clear flags now but fetch fails, rebuild would include wrong text)
      try {
        const fileData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        fileData.previousUrl = fileData.url;
        fileData.url = discoveredUrl;
        fileData.urlDiscoveredAt = new Date().toISOString();
        fileData.urlDiscoveryMethod = 'google-serp-reason-recovery';
        // Clear fabricated flags on successful URL discovery
        if (fileData.fabricatedEntry) {
          delete fileData.fabricatedEntry;
          delete fileData.fabricatedReason;
        }
        fs.writeFileSync(review.filePath, JSON.stringify(fileData, null, 2) + '\n');
      } catch (e) {}
      review.url = discoveredUrl;
      review._urlDiscovered = true;
      review.fabricatedEntry = false; // prevent re-triggering SERP on retry
    } else {
      // For collector-flagged wrongShow files with existing URLs, fall through to re-fetch
      // (the URL is correct, the scraper just got wrong content last time)
      const isCollectorFlagged = review.wrongShow && typeof review.wrongShowReason === 'string'
        && review.wrongShowReason.startsWith('Collector LLM');
      if (isCollectorFlagged && review.url) {
        console.log(`  [${reason}] No new URL via SERP — re-fetching existing URL (collector-flagged)`);
        review._wrongShowRetrying = true;
      } else {
        console.log(`  [${reason}] No URL found via SERP, skipping`);
        stats.totalFailed++;
        return { success: false, error: `${reason}_no_url_discovered` };
      }
    }
  }

  // showNotMentioned URL recovery: discover correct URL before wasting bandwidth re-fetching the wrong one
  if (review.showNotMentioned && review.filePath) {
    console.log('  [showNotMentioned] Attempting URL discovery before fetch...');

    // Mark as attempted to prevent infinite retries
    try {
      const fileData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
      fileData._showNotMentionedDiscoveryAttempted = true;
      fs.writeFileSync(review.filePath, JSON.stringify(fileData, null, 2) + '\n');
    } catch (e) {}

    const discoveredUrl = await discoverCorrectUrl(review);
    // SERP providers down — don't mark as attempted, let it retry next run
    if (discoveredUrl === '__SERP_UNAVAILABLE__') {
      try {
        const fileData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        delete fileData._showNotMentionedDiscoveryAttempted;
        fs.writeFileSync(review.filePath, JSON.stringify(fileData, null, 2) + '\n');
      } catch (e) {}
      stats.totalFailed++;
      return { success: false, error: 'serp_unavailable' };
    }
    if (discoveredUrl && discoveredUrl !== review.url) {
      console.log(`  [showNotMentioned] Discovered: ${review.url} → ${discoveredUrl}`);
      review._previousUrl = review.url;
      review.url = discoveredUrl;
      review._urlDiscovered = true;
    } else {
      console.log('  [showNotMentioned] No alternative URL found, skipping fetch');
      stats.totalFailed++;
      return { success: false, error: 'show_not_mentioned_no_url' };
    }
  }

  // Safety: no URL means we can't fetch (prevents crash on no_url reviews that missed SERP)
  if (!review.url) {
    console.log('  ✗ No URL available — skipping');
    stats.totalFailed++;
    return { success: false, error: 'no_url' };
  }

  try {
    const result = await fetchReviewText(review);

    console.log(`  ✓ SUCCESS via ${result.method} (${result.text.length} chars)`);

    // Content quality check - detect garbage/invalid content before saving
    const showTitle = review.showId ? review.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ') : '';
    const qualityCheck = assessTextQuality(result.text, showTitle);

    if (qualityCheck.quality === 'garbage' && qualityCheck.confidence === 'high') {
      // Don't save garbage content as fullText - log as failed fetch
      console.log(`  ✗ GARBAGE CONTENT DETECTED: ${qualityCheck.issues[0] || 'invalid content'}`);
      console.log(`    Reason: ${qualityCheck.issues.join(', ')}`);

      // Record as failed fetch with reason (increments failure count)
      recordFailedFetch(review, 'garbage_content', {
        method: result.method,
        garbageReason: qualityCheck.issues.join('; '),
        textLength: result.text.length,
      });

      stats.totalFailed++;
      return { success: false, error: 'garbage_content', reason: qualityCheck.issues.join('; ') };
    }

    if (qualityCheck.quality === 'suspicious') {
      // Log warning but continue processing
      console.log(`  ⚠ SUSPICIOUS CONTENT: ${qualityCheck.issues.join(', ')}`);
    }

    // Archive HTML
    const archivePath = result.html ? archiveHtml(result.html, review, result.method) : null;

    // Validate
    const validation = validateReviewText(result.text, review);
    console.log(`  Validation: ${validation.valid ? 'PASS' : 'ISSUES'} (${validation.wordCount} words)`);
    if (!validation.valid) {
      console.log(`  Issues: ${validation.issues.join(', ')}`);
    }

    // LLM-based content verification (runs by default, falls back to heuristic without API key)
    let contentVerification = null;
    if (validation.wordCount >= 200) {
      console.log(`  LLM Verification...`);
      try {
        // Get excerpt and show metadata from existing review data
        const reviewData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        const excerpt = reviewData.dtliExcerpt || reviewData.bwwExcerpt || reviewData.showScoreExcerpt || reviewData.nycTheatreExcerpt || reviewData.lboRoundupExcerpt || '';
        const showId = reviewData.showId || review.showId || '';

        // Look up show metadata for richer context
        let showMeta = null;
        try {
          if (!_showsJsonCache) _showsJsonCache = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
          showMeta = _showsJsonCache.shows.find(s => s.id === showId);
        } catch (e) { /* shows.json unavailable */ }

        contentVerification = await verifyContent({
          scrapedText: result.text,
          excerpt: excerpt,
          showTitle: showMeta?.title || showId.replace(/-\d{4}$/, '').replace(/-/g, ' '),
          outletName: review.outlet,
          criticName: review.critic,
          openingDate: showMeta?.openingDate || null,
          venue: showMeta?.venue || null,
          market: showMeta?.category || 'broadway'
        });

        const verifier = contentVerification.verifiedBy?.startsWith('llm:') ? `LLM (${contentVerification.verifiedBy.split(':')[1]})` : 'Heuristic';
        console.log(`  ${verifier} Verify: ${contentVerification.isValid ? 'VALID' : 'REJECTED'} (${contentVerification.confidence} confidence)`);
        if (contentVerification.issues.length > 0) {
          console.log(`  Issues: ${contentVerification.issues.join(', ')}`);
        }
        if (contentVerification.reasoning) {
          console.log(`  Reasoning: ${contentVerification.reasoning}`);
        }
      } catch (e) {
        console.log(`  LLM Verify error: ${e.message}`);
      }
    }

    // Update JSON (pass HTML for score extraction)
    await updateReviewJson(review, result.text, validation, archivePath, result.method, result.attempts, result.archiveData || {}, result.html || '', contentVerification);

    // Persist URL discovery metadata if URL was changed via showNotMentioned recovery
    if (review._urlDiscovered && review.filePath) {
      try {
        const fileData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        fileData.url = review.url;
        fileData.previousUrl = review._previousUrl;
        fileData.urlDiscoveredAt = new Date().toISOString();
        fileData.urlDiscoveryMethod = 'show-not-mentioned-recovery';
        fs.writeFileSync(review.filePath, JSON.stringify(fileData, null, 2) + '\n');
        console.log(`    → URL updated: ${review._previousUrl} → ${review.url}`);
      } catch (e) {
        console.log(`    ⚠ Could not persist URL discovery: ${e.message}`);
      }
    }

    // Track tier breakdown (normalize hyphenated method names to camelCase keys)
    const methodKey = result.method === 'direct-cookies' ? 'directCookies' : result.method;
    if (methodKey && state.tierBreakdown[methodKey]) {
      state.tierBreakdown[methodKey].push(review.reviewId);
    }

    // Clear any previous failure tracking on success
    clearFailedFetch(review.reviewId);

    // For wrong_content: now safe to clear flags (content fetched and validated from new URL)
    if (review.incompleteReason === 'wrong_content' && review._urlDiscovered && review.filePath) {
      try {
        const postData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        delete postData.wrongProduction;
        delete postData.wrongShow;
        delete postData.wrongProductionReason;
        delete postData.wrongShowReason;
        delete postData.showNotMentioned;
        delete postData.contentMismatchNote;
        fs.writeFileSync(review.filePath, JSON.stringify(postData, null, 2) + '\n');
      } catch (e) {}
    }

    // For collector-flagged wrongShow retries: clear flags if re-fetch succeeded with valid content
    if (review._wrongShowRetrying && review.filePath) {
      try {
        const postData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        const cv = postData.contentVerification;
        if (cv && cv.isValid && !cv.wrongArticle) {
          // Re-fetch got correct content — clear wrongShow flags
          delete postData.wrongShow;
          delete postData.wrongShowReason;
          delete postData.wrongShowRetryAt;
          delete postData.wrongFullText;
          console.log(`    ✓ wrongShow cleared — re-fetch got correct content`);
        } else {
          // Still wrong — update retry timestamp to enforce cooldown
          postData.wrongShowRetryAt = new Date().toISOString();
          console.log(`    ✗ wrongShow retry failed — still wrong content, next retry in 14 days`);
        }
        delete postData._wrongShowRetrying;
        fs.writeFileSync(review.filePath, JSON.stringify(postData, null, 2) + '\n');
      } catch (e) {}
    }

    return { success: true, method: result.method, validation };

  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}`);

    // URL Discovery: If the failure was a 404 and we haven't retried yet, try to find the correct URL
    if (error.message.includes('404') && !review._discoveryAttempted && review.filePath) {
      review._discoveryAttempted = true;

      // Try outlet-specific URL resolution first (no API cost)
      console.log('\n  [URL Resolution] Trying known URL patterns...');
      let discoveredUrl = await resolveTimeoutListingUrl(review);

      // Fall back to SERP-based discovery
      if (!discoveredUrl) {
        console.log('  [URL Discovery] Attempting to find correct URL via Google...');
        discoveredUrl = await discoverCorrectUrl(review);
      }

      // SERP providers all down — don't penalize this review, just skip it for this run
      if (discoveredUrl === '__SERP_UNAVAILABLE__') {
        console.log('  [URL Discovery] SERP unavailable — will retry next run without penalty');
        stats.totalFailed++;
        return { success: false, error: 'serp_unavailable' };
      }

      if (discoveredUrl) {
        const originalUrl = review.url;
        review.url = discoveredUrl;
        console.log(`  [Retry] Re-attempting fetch with discovered URL...`);

        try {
          const retryResult = await fetchReviewText(review);
          console.log(`  ✓ SUCCESS via ${retryResult.method} with discovered URL (${retryResult.text?.length || 0} chars)`);

          // Check for garbage content BEFORE writing URL to file
          // (prevents cost leak: if we write the URL first and content is garbage,
          // future runs would re-discover the same URL and waste SERP credits)
          const showTitle = review.showId ? review.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ') : '';
          const qualityCheck = assessTextQuality(retryResult.text, showTitle);
          if (qualityCheck.quality === 'garbage' && qualityCheck.confidence === 'high') {
            console.log(`  ✗ GARBAGE CONTENT from discovered URL: ${qualityCheck.issues[0]}`);
            review.url = originalUrl; // restore before failing
            stats.totalFailed++;
            return { success: false, error: 'garbage_content_from_discovered_url' };
          }

          // Content is good — update the review file's URL atomically (write to .tmp, then rename)
          try {
            const reviewData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
            reviewData.url = discoveredUrl;
            reviewData.previousUrl = originalUrl;
            reviewData.urlDiscoveredAt = new Date().toISOString();
            reviewData.urlDiscoveryMethod = 'google-serp';
            const tmpPath = review.filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(reviewData, null, 2));
            fs.renameSync(tmpPath, review.filePath);
            console.log(`    → Updated review URL: ${originalUrl} → ${discoveredUrl}`);
          } catch (writeErr) {
            console.log(`    ⚠ Could not update URL in file: ${writeErr.message}`);
          }

          const archivePath = retryResult.html ? archiveHtml(retryResult.html, review, retryResult.method) : null;
          const validation = validateReviewText(retryResult.text, review);
          await updateReviewJson(review, retryResult.text, validation, archivePath, retryResult.method, retryResult.attempts, retryResult.archiveData || {}, retryResult.html || '', null);

          const retryMethodKey = retryResult.method === 'direct-cookies' ? 'directCookies' : retryResult.method;
          if (retryMethodKey && state.tierBreakdown[retryMethodKey]) {
            state.tierBreakdown[retryMethodKey].push(review.reviewId);
          }

          return { success: true, method: retryResult.method + '+url-discovery', validation };
        } catch (retryErr) {
          // Discovered URL also failed — restore original and fall through to normal failure
          review.url = originalUrl;
          console.log(`    ✗ Discovered URL also failed: ${retryErr.message}`);
        }
      }
    }

    stats.totalFailed++;

    // Record permanent failure (increments count — after 3, review is skipped)
    const is404 = error.message.includes('404');
    const isTimeout = error.message.includes('timeout') || error.message.includes('TIMEOUT');
    const allTiersFailed = error.message.includes('All tiers failed');
    const failReason = is404 ? 'url_dead_404' : isTimeout ? 'all_tiers_timeout' : allTiersFailed ? 'all_tiers_failed' : 'fetch_error';
    recordFailedFetch(review, failReason, {
      errorMessage: error.message.slice(0, 200),
    });

    // Track failures by outlet for end-of-run reporting
    const outletName = review.outlet || review.outletId || 'unknown';
    const urlDomain = (() => { try { return new URL(review.url).hostname.replace('www.', ''); } catch(e) { return 'unknown'; } })();
    if (!stats.failuresByOutlet[outletName]) {
      const paywallCreds = getPaywallCredentials(review.url);
      stats.failuresByOutlet[outletName] = {
        count: 0,
        domain: urlDomain,
        hasCredentials: paywallCreds ? !!(paywallCreds.email && paywallCreds.password) : false,
        isPaywalled: !!paywallCreds,
        isKnownBlocked: CONFIG.knownBlockedSites.some(s => urlDomain.includes(s)),
      };
    }
    stats.failuresByOutlet[outletName].count++;

    // For wrongShow retries that failed: update retry timestamp to enforce cooldown
    if (review._wrongShowRetrying && review.filePath) {
      try {
        const postData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        postData.wrongShowRetryAt = new Date().toISOString();
        delete postData._wrongShowRetrying;
        fs.writeFileSync(review.filePath, JSON.stringify(postData, null, 2) + '\n');
      } catch (e) {}
    }

    return { success: false, error: error.message };
  }
}

// ============================================================================
// TEST URL MODE
// ============================================================================

async function testUrl(url) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  TEST URL MODE                                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`URL: ${url}\n`);

  await setupBrowser();

  const fakeReview = {
    reviewId: 'test/test.json',
    filePath: null,
    showId: 'test',
    outlet: 'Test',
    outletId: 'test',
    critic: 'Test',
    url: url,
  };

  const results = [];

  // Test each tier
  const tiers = [
    { name: 'Playwright', fn: () => fetchWithPlaywright(url, fakeReview) },
    { name: 'ScrapingBee', fn: () => fetchWithScrapingBee(url), requires: CONFIG.scrapingBeeKey },
    { name: 'Bright Data', fn: () => fetchWithBrightData(url), requires: CONFIG.brightDataKey },
    { name: 'Archive.org', fn: () => fetchFromArchive(url) },
  ];

  for (const tier of tiers) {
    if (tier.requires === undefined || tier.requires) {
      console.log(`\n[Testing ${tier.name}]`);
      try {
        const start = Date.now();
        const result = await tier.fn();
        const duration = Date.now() - start;
        const wordCount = result.text.split(/\s+/).length;
        console.log(`  ✓ SUCCESS in ${duration}ms`);
        console.log(`  Text length: ${result.text.length} chars, ${wordCount} words`);
        console.log(`  Preview: ${result.text.substring(0, 200)}...`);
        results.push({ tier: tier.name, success: true, duration, chars: result.text.length, words: wordCount });
      } catch (e) {
        console.log(`  ✗ FAILED: ${e.message}`);
        results.push({ tier: tier.name, success: false, error: e.message });
      }
    } else {
      console.log(`\n[${tier.name}] Skipped - not configured`);
      results.push({ tier: tier.name, success: false, error: 'Not configured' });
    }
  }

  await closeBrowser();

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('RESULTS SUMMARY:');
  console.log('═'.repeat(60));
  for (const r of results) {
    const status = r.success ? '✓' : '✗';
    const details = r.success ? `${r.words} words in ${r.duration}ms` : r.error;
    console.log(`${status} ${r.tier}: ${details}`);
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\n${successCount}/${results.length} tiers succeeded`);
}

// ============================================================================
// GENERATE REPORT
// ============================================================================

function generateReport() {
  const report = {
    runDate: new Date().toISOString(),
    config: {
      batchSize: CONFIG.batchSize,
      maxReviews: CONFIG.maxReviews,
      priority: CONFIG.priority,
      showFilter: CONFIG.showFilter,
      aggressive: CLI.aggressive,
      scrapingBeeEnabled: !!CONFIG.scrapingBeeKey,
      brightDataEnabled: !!CONFIG.brightDataKey,
      stealthPluginLoaded: stealthLoaded,
    },
    summary: {
      processed: state.processed.length,
      failed: state.failed.length,
      skipped: state.skipped.length,
      successRate: state.processed.length > 0
        ? ((state.processed.length / (state.processed.length + state.failed.length)) * 100).toFixed(1) + '%'
        : '0%',
    },
    tierBreakdown: {
      playwright: state.tierBreakdown.playwright?.length || 0,
      amp: state.tierBreakdown.amp?.length || 0,
      browserbase: state.tierBreakdown.browserbase?.length || 0,
      directCookies: state.tierBreakdown.directCookies?.length || 0,
      scrapingbee: state.tierBreakdown.scrapingbee?.length || 0,
      brightdata: state.tierBreakdown.brightdata?.length || 0,
      archiveToday: state.tierBreakdown.archiveToday?.length || 0,
      archive: state.tierBreakdown.archive?.length || 0,
    },
    statistics: {
      tier1Attempts: stats.tier1Attempts,
      tier1Success: stats.tier1Success,
      ampAttempts: stats.ampAttempts,
      ampSuccess: stats.ampSuccess,
      tier1_5Attempts: stats.tier1_5Attempts,
      tier1_5Success: stats.tier1_5Success,
      tier2Attempts: stats.tier2Attempts,
      tier2Success: stats.tier2Success,
      tier3Attempts: stats.tier3Attempts,
      tier3Success: stats.tier3Success,
      tier3_6Attempts: stats.tier3_6Attempts,
      tier3_6Success: stats.tier3_6Success,
      tier4Attempts: stats.tier4Attempts,
      tier4Success: stats.tier4Success,
      totalFailed: stats.totalFailed,
      scrapingBeePageCredits: stats.scrapingBeePageCredits,
      scrapingBeeSerpCredits: stats.scrapingBeeSerpCredits,
      browserbaseSessionsUsed: stats.browserbaseSessionsUsed,
      browserbaseMinutesUsed: Math.round(stats.browserbaseMinutesUsed * 10) / 10,
      urlDiscoveryAttempts: stats.urlDiscoveryAttempts,
      urlDiscoverySuccess: stats.urlDiscoverySuccess,
      urlDiscoveryCapped: stats.urlDiscoveryCapped,
    },
    processed: state.processed,
    failed: state.failed,
    tierDetails: state.tierBreakdown,
    failuresByOutlet: stats.failuresByOutlet,
    urlDiscoveries: stats.urlDiscoveryDetails,
  };

  const date = new Date().toISOString().split('T')[0];
  const reportPath = path.join(CONFIG.auditDir, `collection-report-${date}.json`);
  fs.mkdirSync(CONFIG.auditDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${'╔' + '═'.repeat(58) + '╗'}`);
  console.log(`║${'COLLECTION REPORT'.padStart(38).padEnd(58)}║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ Processed: ${String(report.summary.processed).padStart(44)} ║`);
  console.log(`║ Failed:    ${String(report.summary.failed).padStart(44)} ║`);
  console.log(`║ Success Rate: ${String(report.summary.successRate).padStart(41)} ║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ TIER BREAKDOWN                                           ║`);
  console.log(`║ ├─ Tier 1 (Playwright):  ${String(report.tierBreakdown.playwright).padStart(31)} ║`);
  console.log(`║ ├─ Tier 1.1 (AMP):       ${String(report.tierBreakdown.amp).padStart(31)} ║`);
  console.log(`║ ├─ Tier 1.5 (Browserbase):${String(report.tierBreakdown.browserbase).padStart(30)} ║`);
  console.log(`║ ├─ Tier 1.8 (Direct+Cook):${String(report.tierBreakdown.directCookies).padStart(30)} ║`);
  console.log(`║ ├─ Tier 2 (ScrapingBee): ${String(report.tierBreakdown.scrapingbee).padStart(31)} ║`);
  console.log(`║ ├─ Tier 3 (Bright Data): ${String(report.tierBreakdown.brightdata).padStart(31)} ║`);
  console.log(`║ ├─ Tier 3.6 (archive.ph):${String(report.tierBreakdown.archiveToday).padStart(31)} ║`);
  console.log(`║ └─ Tier 4 (Archive.org): ${String(report.tierBreakdown.archive).padStart(31)} ║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ API USAGE                                                ║`);
  console.log(`║ ├─ SB page credits:    ${String(stats.scrapingBeePageCredits).padStart(32)} ║`);
  console.log(`║ ├─ SB SERP credits:    ${String(stats.scrapingBeeSerpCredits).padStart(32)} ║`);
  console.log(`║ └─ Browserbase sessions: ${String(stats.browserbaseSessionsUsed).padStart(31)} ║`);
  if (stats.urlDiscoveryAttempts > 0) {
    console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
    console.log(`║ URL DISCOVERY                                            ║`);
    console.log(`║ ├─ Attempted: ${String(stats.urlDiscoveryAttempts).padStart(42)} ║`);
    console.log(`║ ├─ Found: ${String(stats.urlDiscoverySuccess).padStart(46)} ║`);
    if (stats.urlDiscoveryCapped > 0) {
      console.log(`║ ├─ Skipped (cap reached): ${String(stats.urlDiscoveryCapped).padStart(30)} ║`);
    }
    const rate = stats.urlDiscoveryAttempts > 0
      ? ((stats.urlDiscoverySuccess / stats.urlDiscoveryAttempts) * 100).toFixed(0) + '%'
      : 'N/A';
    console.log(`║ └─ Success rate: ${String(rate).padStart(39)} ║`);
    if (stats.urlDiscoveryDetails.length > 0) {
      for (const d of stats.urlDiscoveryDetails) {
        console.log(`║   ${d.reviewId.substring(0, 54).padEnd(55)}║`);
      }
    }
  }
  console.log(`${'╚' + '═'.repeat(58) + '╝'}`);

  // Print failures by outlet - helps identify which sites need subscriptions or better scraping
  const outletFailures = Object.entries(stats.failuresByOutlet)
    .sort((a, b) => b[1].count - a[1].count);
  if (outletFailures.length > 0) {
    console.log(`\n${'╔' + '═'.repeat(58) + '╗'}`);
    console.log(`║${'FAILURES BY OUTLET'.padStart(38).padEnd(58)}║`);
    console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
    for (const [outlet, info] of outletFailures.slice(0, 15)) {
      const status = info.isPaywalled
        ? (info.hasCredentials ? '🔑 has creds (login issue?)' : '🔒 NEEDS SUBSCRIPTION')
        : (info.isKnownBlocked ? '🚫 bot-blocked' : '❌ scraping failed');
      console.log(`║ ${String(info.count).padStart(3)} fails: ${outlet.padEnd(22)} ${status.padEnd(23)}║`);
    }
    console.log(`${'╚' + '═'.repeat(58) + '╝'}`);
  }

  console.log(`Report saved: ${reportPath}`);

  return report;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  // Test URL mode
  if (CLI.testUrl) {
    await loadDependencies();
    await testUrl(CLI.testUrl);
    return;
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  REVIEW TEXT COLLECTION - Multi-Tier Fallback System       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Config: batch=${CONFIG.batchSize}, max=${CONFIG.maxReviews}, priority=${CONFIG.priority}`);
  console.log(`Flags: aggressive=${CLI.aggressive}, forceTier=${CLI.forceTier || 'auto'}`);
  if (CONFIG.domainFilter.length > 0) {
    console.log(`Domain filter: ${CONFIG.domainFilter.join(', ')}`);
  }
  if (CONFIG.excludeDomains.length > 0) {
    console.log(`Excluding domains: ${CONFIG.excludeDomains.join(', ')}`);
  }

  // Load dependencies
  await loadDependencies();

  console.log(`\nAPI Status:`);
  console.log(`  ScrapingBee: ${CONFIG.scrapingBeeKey ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Bright Data: ${CONFIG.brightDataKey ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Browserbase: ${CONFIG.browserbaseEnabled ? `✓ enabled (limit: ${CONFIG.browserbaseMaxSessionsPerDay}/day)` : '✗ disabled'}`);
  console.log(`  Stealth Plugin: ${stealthLoaded ? '✓ loaded' : '⚠ using fallback'}`);
  console.log(`  URL Discovery Limit: ${URL_DISCOVERY_MAX_PER_RUN}/run`);

  // Validate cookie secrets — fail loudly if any are corrupted
  console.log(`\nCookie Status:`);
  let cookieErrors = 0;
  const seenEnvVars = new Set();
  for (const [domain, config] of Object.entries(COOKIE_DOMAIN_MAP)) {
    if (seenEnvVars.has(config.envVar)) continue; // Skip aliases (nymag→VULTURE, huffingtonpost→HUFFPOST)
    seenEnvVars.add(config.envVar);
    const envVal = process.env[config.envVar];
    if (envVal) {
      try {
        const decoded = Buffer.from(envVal, 'base64').toString('utf-8');
        const cookies = JSON.parse(decoded);
        if (Array.isArray(cookies) && cookies.length > 0) {
          console.log(`  🍪 ${config.envVar}: ✓ ${cookies.length} cookies`);
        } else {
          console.log(`  ⚠ ${config.envVar}: decoded but empty/invalid array`);
          cookieErrors++;
        }
      } catch (e) {
        console.log(`  ✗ ${config.envVar}: CORRUPTED — ${e.message}`);
        cookieErrors++;
      }
    }
    // Don't log missing — most domains won't have env vars set locally
  }
  if (cookieErrors > 0) {
    console.log(`\n  ⚠ WARNING: ${cookieErrors} cookie secret(s) are CORRUPTED — they will NOT work.`);
    console.log(`  Re-upload with: base64 < data/cookies/FILE.json | gh secret set SECRET_NAME`);
  }

  // Load previous state if resuming
  loadState();

  // Load Browserbase usage tracking (for spending limits)
  if (CONFIG.browserbaseEnabled) {
    loadBrowserbaseUsage();
  }

  // Find reviews to process
  const reviews = findReviewsToProcess();
  console.log(`\nFound ${reviews.length} reviews to process`);

  if (reviews.length === 0) {
    console.log('No reviews to process. Exiting.');
    return;
  }

  // Setup browser
  await setupBrowser();

  try {
    let batchCount = 0;

    for (let i = 0; i < reviews.length; i++) {
      const review = reviews[i];

      // Hard timeout per review - prevents hung Playwright from killing entire run
      let result;
      try {
        result = await Promise.race([
          processReview(review),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('REVIEW_TIMEOUT')), CONFIG.reviewTimeout)
          )
        ]);
      } catch (e) {
        if (e.message === 'REVIEW_TIMEOUT') {
          console.log(`  ✗ TIMEOUT: Review took >${CONFIG.reviewTimeout/1000}s - skipping (${review.outlet} - ${review.critic})`);
          // Kill and restart browser to clear hung state
          try { await closeBrowser(); } catch(_) {}
          try { await setupBrowser(); } catch(_) {}
        }
        result = { success: false, error: e.message };
      }

      if (result.success) {
        state.processed.push(review.reviewId);
      } else {
        state.failed.push(review.reviewId);
      }

      state.lastProcessed = review.reviewId;
      batchCount++;

      // Save state and commit after each batch
      if (batchCount >= CONFIG.batchSize) {
        saveState();
        commitChanges(state.processed.length);
        console.log(`\n─── Batch complete, state saved (${state.processed.length} processed) ───`);
        batchCount = 0;
      }

      // Delay between reviews
      if (i < reviews.length - 1) {
        await sleep(CONFIG.requestDelay);
      }
    }

    // Final state save and commit (force push to ensure all data lands)
    saveState();
    commitChanges(state.processed.length, true);

  } finally {
    await closeBrowser();
  }

  // Generate report
  generateReport();
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  closeBrowser().finally(() => process.exit(1));
});
