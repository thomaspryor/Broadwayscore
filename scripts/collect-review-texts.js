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
const { listShowDirs } = require('./lib/list-show-dirs');
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
const { extractScore, extractDesignation, extractNYTCriticsPick, OUTLET_VERIFIED_SOURCES, OUTLET_EXTRACTORS } = require('./lib/score-extractors');
const { findBoldHeaderAnchors, loadShows: loadSplitterShows } = require('./lib/multi-show-splitter');
const { extractExplicitScore } = require('./lib/llm-score-extractor');

// Text cleaning (entity decoding, junk stripping)
const { cleanText, stripTrailingJunk, TRAILING_JUNK_PATTERNS } = require('./lib/text-cleaning');

// LLM-based content verification
const { verifyContent, quickValidityCheck } = require('./lib/content-verifier');
const { isLongRunningProduction: _isLongRunner } = require('./lib/long-runner-registry');

// Content quality detection (garbage/invalid content filter)
const { assessTextQuality, isGarbageContent, validateShowMentioned, validateContentMentionsShow, extractByline, matchesCritic, computeContentFingerprint, classifyContentTier, verifyFullTextContent, extractAuthorFromHtml, extractHighConfidenceAuthor } = require('./lib/content-quality');
const { resolveOutletFromUrl, getOutletDisplayName, generateReviewFilename, normalizeOutlet } = require('./lib/review-normalization');
const { setExtractedScore, AGGREGATOR_SCORE_SOURCES } = require('./lib/score-routing');
const { runScoreExtractorPrePass } = require('./lib/score-extractor-prepass');
const { classifyIncompleteReason } = require('./lib/incomplete-reason');
const { isTourReviewExcerpt, isFilmTvReview } = require('./lib/excerpt-validation');
const { isAnticipatoryPreviewPost } = require('./lib/content-filters');

// NYT Critics' Pick lookup — lazy-loaded once per run from authoritative URL list.
// Do NOT check raw HTML (10% FP from NYT page chrome). URL match only.
let _nytCriticsPicks = null;
function getNytCriticsPicks() {
  if (!_nytCriticsPicks) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nyt-critics-picks.json'), 'utf8'));
      _nytCriticsPicks = new Set(data.urls.map(u => u.replace(/[?#].*$/, '').replace(/\/$/, '')));
    } catch { _nytCriticsPicks = new Set(); }
  }
  return _nytCriticsPicks;
}
const { isLondonMarket } = require('./lib/venue-classification');
const { shouldSkipScoredReview, shouldSkipWrongProductionAudit, wrongShowCleared, evaluateShowMentionGuard, pickShowTitleForHeuristic, checkLlmVerificationAgainstKeywords, hasHighConfidenceLlmScore } = require('./lib/review-guards');
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');
const { checkBrowserbaseCaps } = require('./lib/browserbase-caps');
const { logExclusion } = require('./lib/exclusion-logger');
const { shouldSkipPollerUpdate, safeRenameReview } = require('./lib/review-write-guard');

/**
 * Rename a review-text file to match its in-memory criticName when one of the
 * three criticName-override branches in updateReviewJson() (1A-bis HC override,
 * 1B byline cross-check, 1B-iii Unknown→real-name enrichment) changes the
 * canonical filename.
 *
 * Conflict-mode design (post PR #290 revert, 2026-04-29):
 * - On clean rename (dst doesn't exist): route through safeRenameReview which
 *   honors source `_locked` and updates the llm-scores sidecar + sibling
 *   duplicateTextOf pointers. Update review.filePath so the trailing
 *   updateReviewJson write lands at the new path.
 * - On conflict (dst exists): leave source untouched. Set data.duplicateOf =
 *   newFilename so validate-review-texts.js's skip-gate (line 185) catches
 *   the file before reviews.json. The trailing write at line ~4987 picks
 *   that up. Crucially, review.filePath stays at the SOURCE path — that's
 *   what kills the "merge undone by line 5069" bug PR #290 fell to.
 *
 * @param {object} review - The in-flight review object (mutates review.filePath)
 * @param {object} data - The in-memory review data (mutates data.duplicateOf on conflict)
 * @param {string} extractedAuthor - The new canonical critic name
 * @returns {{ action: 'noop'|'renamed'|'conflict'|'skipped-locked', newFile?: string }}
 */
function renameReviewFileForCriticOverride(review, data, extractedAuthor) {
  if (!review.filePath || !extractedAuthor) {
    return { action: 'noop' };
  }
  const currentFile = path.basename(review.filePath);
  const showDir = path.dirname(review.filePath);
  const outletId = normalizeOutlet(data.outletId || data.outlet);
  const newFilename = generateReviewFilename(outletId, extractedAuthor);

  if (newFilename === currentFile) {
    return { action: 'noop' };
  }

  const newPath = path.join(showDir, newFilename);
  if (fs.existsSync(newPath)) {
    // Conflict: do NOT merge, do NOT delete source. Mark this file as a
    // duplicate so validate-review-texts skips it, and let the operator
    // (or the dedup audit) decide which file is canonical.
    data.duplicateOf = newFilename;
    data.duplicateReason = 'criticName-override-collided-at-rename';
    console.warn(`    ⚠ Rename conflict: ${currentFile} → ${newFilename} already exists. Marking duplicateOf=${newFilename}; source kept at ${currentFile} for triage.`);
    return { action: 'conflict', newFile: newFilename };
  }

  // Pass newData=data so the freshly-overridden criticName etc. land at the
  // new path (the helper writes our in-memory data, not the on-disk source).
  const result = safeRenameReview(review.filePath, newPath, { newData: data });
  if (result.skipped === 'locked') {
    console.warn(`    ⚠ Rename refused: ${currentFile} is _locked. Leaving filename as-is; criticName mismatch will be caught by validate-review-texts on next CI run.`);
    return { action: 'skipped-locked' };
  }
  if (result.skipped === 'conflict') {
    // TOCTOU: another writer created newPath after our existsSync check.
    data.duplicateOf = newFilename;
    data.duplicateReason = 'criticName-override-collided-at-rename';
    return { action: 'conflict', newFile: newFilename };
  }
  if (!result.wrote) {
    console.warn(`    ⚠ Rename skipped (${result.skipped}): ${result.error || ''}`);
    return { action: 'noop' };
  }

  review.filePath = newPath;
  console.log(`    → Renamed ${currentFile} → ${newFilename}`);
  return { action: 'renamed', newFile: newFilename };
}

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

// --- Domains where ScrapingBee needs premium_proxy + render_js=true ---
// Two categories: (1) JS-rendered content, (2) paywalled sites that forward subscriber cookies.
// All other domains use render_js=false with no premium_proxy → 1 credit (was 10).
const SB_PREMIUM_DOMAINS = new Set([
  // JS-rendered content
  'show-score.com',         // React SPA
  'theatermania.com',       // Dynamic content loading
  // Cookie-forwarding paywalled outlets (premium_proxy needed for reliable delivery)
  'wsj.com', 'newyorker.com', 'nytimes.com', 'vulture.com', 'nymag.com',
  'washingtonpost.com', 'ft.com', 'timeout.com', 'nypost.com', 'nydailynews.com',
  'deadline.com', 'observer.com', 'hollywoodreporter.com', 'variety.com',
  'indiewire.com', 'ew.com', 'huffpost.com', 'huffingtonpost.com',
  'usatoday.com', 'northjersey.com', 'bloomberg.com', 'thestage.co.uk',
  'backstage.com', 'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com',
  'standard.co.uk', 'independent.co.uk', 'chicagotribune.com', 'thewrap.com',
  'nbcnewyork.com', 'newsday.com',
]);

// Per-run SB page credit budget — prevents runaway spending.
// For bulk backfills, override: SB_PAGE_CREDIT_BUDGET=1000 node scripts/collect-review-texts.js ...
const SB_PAGE_CREDIT_BUDGET = parseInt(process.env.SB_PAGE_CREDIT_BUDGET || '200', 10);

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

  // Browserbase spending limits (to control costs - $0.10/session).
  // Empirical April 2026 baseline (peak opening-night month): median 84/day, p95
  // 199/day, max 275/day (April 26, Joe Turner). Cap of 250 covers the empirical
  // max with 0 historical clip days; cap of 200 would have clipped April 26 alone.
  // Feb 2026 runaway: max 2,448/day = $244.80 in one day, $1,548 in one week.
  // The 250/day hard ceiling means worst-case month = $750 instead of unbounded.
  browserbaseEnabled: process.env.BROWSERBASE_ENABLED === 'true',
  browserbaseMaxSessionsPerDay: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY || '250'), // $25/day ceiling = $750/mo MAX; normal $5-9/day
  browserbaseMaxSessionsPerRun: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_RUN || '30'), // Per workflow run; matches typical opening-night batch
  browserbaseMaxSessionsPerDomain: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DOMAIN || '10'), // Prevent one paywalled outlet monopolizing
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

  // Sites that require Browserbase (Cloudflare/CAPTCHA/SSO blocks that BD/SB/Playwright can't solve)
  // Keep this list tight — each session costs ~$0.10. Legacy entries without documented blockers removed.
  knownBlockedSites: [
    'nytimes.com',        // DataDome CAPTCHA in headless
    'wsj.com',            // Dow Jones SSO anti-bot — fake-rejects correct password in automated browsers
    'newyorker.com',      // Condé Nast id.condenast.com — routes automated browsers to OTP, not password login
    'hollywoodreporter.com', 'variety.com', 'deadline.com', // PMC sites — CAPTCHA-block Playwright consistently
    'bloomberg.com',      // PerimeterX anti-bot
    'ft.com',             // hCaptcha on login
    'talkinbroadway.com', // Cloudflare managed challenge — BD/SB/Playwright all fail
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
    // UK paywalls + FT — in SB_PREMIUM_DOMAINS but archive-first saves credits
    'ft.com', 'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com',
    'standard.co.uk', 'independent.co.uk',
    // Smaller paywalled outlets surfaced via SERP
    'nysun.com', 'spectator.co.uk', 'thejc.com',
  ],

  // Minimum word count for valid review
  minWordCount: 300,

  // Timeouts
  loginTimeout: 90000,    // 90s for slow logins
  pageTimeout: 60000,     // 60s for page load
  apiTimeout: 20000,      // 20s for API calls (Archive.org/scrapers respond fast or not at all)
  reviewTimeout: 90000,   // 90s hard timeout per review (kills hung Playwright/Browserbase)

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
const { shouldRetryUrlDiscovery, recordSerpAttempt } = require('./lib/review-guards');
const { clearFailureFlags } = require('./lib/clear-failure-flags');
const { emitStage } = require('./lib/stage-latency');
const { recordBdCall } = require('./lib/bd-telemetry');
