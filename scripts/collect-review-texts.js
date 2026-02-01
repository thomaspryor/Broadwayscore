/**
 * Collect Review Texts - Multi-Tier Fallback System
 *
 * TIER 0: Archive.org (for archiveFirstSites - paywalled domains where Archive.org excels)
 * TIER 1: Playwright-extra with stealth plugin + login for paywalls
 * TIER 1.5: Browserbase (managed browser cloud with CAPTCHA solving) - SPENDING LIMITS APPLY
 * TIER 2: ScrapingBee API
 * TIER 3: Bright Data Web Unlocker
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
 *   BRIGHTDATA_API_KEY - Bright Data API key
 *   BRIGHTDATA_CUSTOMER_ID - Bright Data customer ID
 *   BROWSERBASE_API_KEY - Browserbase API key (for managed browser cloud)
 *   BROWSERBASE_PROJECT_ID - Browserbase project ID
 *   BROWSERBASE_ENABLED - 'true' to enable Browserbase tier
 *   BROWSERBASE_MAX_SESSIONS_PER_DAY - Daily limit (default: 30 = ~$3/day)
 *   BROWSERBASE_MAX_SESSIONS_PER_RUN - Per-run limit (default: 10)
 *   BATCH_SIZE - Reviews per batch (default: 10)
 *   MAX_REVIEWS - Max reviews to process (default: 50, 0 = all)
 *   PRIORITY - 'tier1' or 'all' (default: all)
 *   SHOW_FILTER - Only process specific show ID
 *   RETRY_FAILED - 'true' to retry previously failed reviews
 *
 * CLI Flags:
 *   --aggressive - Skip Playwright for known-blocked sites, start with ScrapingBee
 *   --tier=N - Force specific tier (1-4) for testing
 *   --test-url="URL" - Test single URL with all tiers
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
// const { HttpsProxyAgent } = require('https-proxy-agent'); // Not used - Bright Data needs zone setup

// Score extraction for original scores
const { extractScore, extractDesignation } = require('./lib/score-extractors');

// LLM-based content verification
const { verifyContent, quickValidityCheck } = require('./lib/content-verifier');

// Content quality detection (garbage/invalid content filter)
const { assessTextQuality, isGarbageContent } = require('./lib/content-quality');

// Parse CLI arguments
const args = process.argv.slice(2);
const CLI = {
  aggressive: args.includes('--aggressive'),
  forceTier: args.find(a => a.startsWith('--tier='))?.split('=')[1],
  testUrl: args.find(a => a.startsWith('--test-url='))?.split('=')[1],
  stealthProxy: args.includes('--stealth-proxy'), // Use ScrapingBee stealth proxy (25 credits/req)
  llmVerify: args.includes('--llm-verify') || process.env.LLM_VERIFY === 'true', // Use LLM to verify content
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
  maxReviews: parseInt(process.env.MAX_REVIEWS || '50'),
  priority: process.env.PRIORITY || 'all',
  showFilter: process.env.SHOW_FILTER || '',
  retryFailed: process.env.RETRY_FAILED === 'true',
  commitEvery: parseInt(process.env.COMMIT_EVERY || '10'), // Git commit after every N reviews
  outletTier: process.env.OUTLET_TIER || '', // Filter by outlet tier: tier1, tier2, tier3
  archiveFirst: process.env.ARCHIVE_FIRST === 'true', // Try Archive.org first for older reviews

  // API Keys
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
  brightDataKey: process.env.BRIGHTDATA_API_KEY || '',
  brightDataCustomerId: process.env.BRIGHTDATA_CUSTOMER_ID || '',
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || '',
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID || '',

  // Browserbase spending limits (to control costs - $0.10/browser hour)
  browserbaseEnabled: process.env.BROWSERBASE_ENABLED === 'true',
  browserbaseMaxSessionsPerDay: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY || '30'), // ~$3/day max
  browserbaseMaxSessionsPerRun: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_RUN || '5'), // Per workflow run (5 × 5 parallel = 25, under 30 daily cap)
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
  tier3Outlets: ['theatrely', 'broadway-news', 'cititour', 'culture-sauce', 'stage-and-cinema', 'forward', 'ny-stage-review', 'new-york-stage-review', 'am-new-york', 'chicago-tribune', 'nj-arts', 'dc-metro-theater-arts', 'talkin-broadway'],

  // Paywalled domains and their credential env vars
  paywalledDomains: {
    'nytimes.com': { emailVar: 'NYT_EMAIL', passVar: 'NYT_PASSWORD' },
    'vulture.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'nymag.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'newyorker.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'washingtonpost.com': { emailVar: 'WAPO_EMAIL', passVar: 'WAPO_PASSWORD' },
    'wsj.com': { emailVar: 'WSJ_EMAIL', passVar: 'WSJ_PASSWORD' },
  },

  // Sites known to block aggressively (skip Playwright, start with ScrapingBee)
  knownBlockedSites: [
    'variety.com', 'hollywoodreporter.com', 'deadline.com', 'thewrap.com',
    'theatermania.com', 'observer.com', 'chicagotribune.com',
    'dailybeast.com', 'thedailybeast.com', 'amny.com', 'newsday.com',
    'nypost.com', 'nydailynews.com', 'indiewire.com',
    // Note: wsj.com removed - now using login
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
    // Entertainment/trade publications with soft paywalls
    'deadline.com', 'variety.com', 'hollywoodreporter.com', 'rollingstone.com',
    // Regional papers with paywalls
    'chicagotribune.com', 'nypost.com', 'nydailynews.com',
    // Sites where Archive.org has proven successful
    'theatrely.com', 'amny.com', 'forward.com',
  ],

  // Minimum word count for valid review
  minWordCount: 300,

  // Timeouts
  loginTimeout: 90000,    // 90s for slow logins
  pageTimeout: 60000,     // 60s for page load
  apiTimeout: 60000,      // 60s for API calls

  // Retry settings
  maxRetries: 3,
  retryDelays: [2000, 4000, 8000], // Exponential backoff

  // Request delays
  requestDelay: 2000,

  // Outlet-to-domain mapping for URL discovery via Google SERP
  outletDomains: {
    'nytimes': 'nytimes.com',
    'nyt': 'nytimes.com',
    'variety': 'variety.com',
    'hollywood-reporter': 'hollywoodreporter.com',
    'thr': 'hollywoodreporter.com',
    'vulture': 'vulture.com',
    'vult': 'vulture.com',
    'timeout': 'timeout.com',
    'time-out': 'timeout.com',
    'deadline': 'deadline.com',
    'wsj': 'wsj.com',
    'ew': 'ew.com',
    'entertainment-weekly': 'ew.com',
    'nypost': 'nypost.com',
    'new-york-post': 'nypost.com',
    'guardian': 'theguardian.com',
    'the-guardian': 'theguardian.com',
    'chicagotribune': 'chicagotribune.com',
    'chicago-tribune': 'chicagotribune.com',
    'wapo': 'washingtonpost.com',
    'washpost': 'washingtonpost.com',
    'washington-post': 'washingtonpost.com',
    'usatoday': 'usatoday.com',
    'usa-today': 'usatoday.com',
    'ap': 'apnews.com',
    'associated-press': 'apnews.com',
    'rollingstone': 'rollingstone.com',
    'rolling-stone': 'rollingstone.com',
    'daily-beast': 'thedailybeast.com',
    'thedailybeast': 'thedailybeast.com',
    'observer': 'observer.com',
    'the-wrap': 'thewrap.com',
    'thewrap': 'thewrap.com',
    'nydailynews': 'nydailynews.com',
    'new-york-daily-news': 'nydailynews.com',
    'newsday': 'newsday.com',
    'theatermania': 'theatermania.com',
    'newyorktheatreguide': 'newyorktheatreguide.com',
    'new-york-theatre-guide': 'newyorktheatreguide.com',
    'nystagereview': 'nystagereview.com',
    'ny-stage-review': 'nystagereview.com',
    'new-york-stage-review': 'nystagereview.com',
    'theatrely': 'theatrely.com',
    'newyorktheater': 'newyorktheater.me',
    'broadwayworld': 'broadwayworld.com',
    'bww': 'broadwayworld.com',
    'cititour': 'cititour.com',
    'amny': 'amny.com',
    'am-new-york': 'amny.com',
    'newyorker': 'newyorker.com',
    'the-new-yorker': 'newyorker.com',
    'indiewire': 'indiewire.com',
    'forward': 'forward.com',
    'talkinbroadway': 'talkinbroadway.com',
    'talkin-broadway': 'talkinbroadway.com',
    'broadway-news': 'broadwaynews.com',
    'stage-and-cinema': 'stageandcinema.com',
    'culture-sauce': 'culturesauce.com',
    'dc-metro-theater-arts': 'dcmetrotheaterarts.com',
    'nj-arts': 'njarts.net',
  },
};

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
  tier4Attempts: 0,
  tier4Success: 0,
  totalFailed: 0,
  scrapingBeeCreditsUsed: 0,
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
    browserbase: [],
    scrapingbee: [],
    brightdata: [],
    archive: [],
  },
  startTime: new Date().toISOString(),
  lastProcessed: null,
};

// Browserbase usage tracking (persisted to disk)
let browserbaseUsage = {
  date: new Date().toISOString().split('T')[0],
  sessionsToday: 0,
  sessionsThisRun: 0,
  minutesToday: 0,
  history: [],
};

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
  const paywallCreds = getPaywallCredentials(url);
  if (paywallCreds && paywallCreds.email && !loggedInDomains.has(paywallCreds.domain)) {
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

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.pageTimeout,
      });

      // Wait for content to load
      await Promise.race([
        page.waitForSelector('article', { timeout: 15000 }),
        page.waitForSelector('[class*="article"]', { timeout: 15000 }),
        page.waitForSelector('[class*="story"]', { timeout: 15000 }),
        page.waitForSelector('main p', { timeout: 15000 }),
        page.waitForTimeout(10000),
      ]).catch(() => {});

      // Scroll to bottom to trigger lazy-loaded content
      await autoScroll(page);

      // Additional wait for JS rendering after scroll
      await page.waitForTimeout(2000);

      // Dismiss paywall overlays and expand hidden content
      await dismissPaywallOverlays(page);

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

    if (domain === 'vulture.com' || domain === 'nymag.com' || domain === 'newyorker.com') {
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

    if (domain === 'wsj.com') {
      // WSJ redirects to sso.accounts.dowjones.com for login
      // Two-step: email/username → "Continue" button → password → "Continue" button
      await page.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000); // Allow redirect to sso.accounts.dowjones.com

      // Step 1: Enter email/username
      // The field may not have standard name attributes - use role-based or generic selectors
      const emailInput = await page.$('input[type="email"], input[name="username"], input[name="email"], [role="textbox"]');
      if (!emailInput) {
        console.log('    ✗ WSJ login FAILED (no email/username field found)');
        return false;
      }
      await emailInput.click();
      await emailInput.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Continue" button (WSJ uses "Continue" not "Submit")
      const continueBtn = await page.$('button:has-text("Continue"), button:has-text("Sign In"), button[type="submit"]');
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

        // Click Continue/Sign In for password step
        const signInBtn = await page.$('button:has-text("Continue"), button:has-text("Sign In"), button[type="submit"]');
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

      // Verify: check if redirected away from login (both old and new URLs)
      const postUrl = page.url();
      const leftLogin = !postUrl.includes('accounts.wsj.com/login') && !postUrl.includes('accounts.dowjones.com/login');
      const hasError = await page.$('[class*="error"], [class*="Error"], .message--error').catch(() => null);

      if (hasError) {
        const errorText = await hasError.textContent().catch(() => '');
        console.log(`    ✗ WSJ login FAILED (error: ${errorText.substring(0, 80)})`);
        return false;
      }
      if (leftLogin) {
        console.log('    ✓ WSJ login verified (left login page)');
        return true;
      }
      console.log('    ⚠ WSJ login uncertain (still on login page) - continuing anyway');
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

    // Connect via Playwright CDP
    bbBrowser = await bbChromium.connectOverCDP(connectUrl);
    const contexts = bbBrowser.contexts();
    const bbContext = contexts[0] || await bbBrowser.newContext();
    bbPage = await bbContext.newPage();

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

    // Extract text using same method as Playwright
    const text = await bbPage.evaluate(() => {
      const selectors = [
        'article .entry-content', 'article .post-content', 'article .article-body',
        '[data-testid="article-body"]', '.article-body', '.story-body', '.entry-content',
        '.post-content', '.review-content', '.article__body', '.article-content',
        '.rich-text', '[class*="ArticleBody"]', '[class*="article-body"]',
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
  console.log(`    ScrapingBee (${proxyType}, ${credits} credits)...`);

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

    const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params,
      timeout: CONFIG.apiTimeout,
    });

    stats.scrapingBeeCreditsUsed += credits;

    const html = response.data;

    if (isBlocked(html)) {
      // If premium failed with CAPTCHA and we haven't tried stealth yet, retry with stealth
      if (!useStealth && CLI.stealthProxy) {
        console.log(`    → CAPTCHA with premium, retrying with stealth_proxy...`);
        return await fetchWithScrapingBee(url, true);
      }
      throw new Error(`CAPTCHA detected (${proxyType})`);
    }

    const text = extractTextFromHtml(html);

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

    const text = extractTextFromHtml(html);

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
// TIER 4: Archive.org Wayback Machine
// ============================================================================

async function fetchFromArchive(url) {
  if (!axios) {
    throw new Error('axios not available');
  }

  stats.tier4Attempts++;

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
  const text = extractTextFromHtml(html);

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

// ============================================================================
// URL DISCOVERY - Find correct URLs for reviews with dead/fabricated links
// ============================================================================

/**
 * Discover the correct URL for a review by searching Google via ScrapingBee SERP API.
 * Used when the existing URL returns 404 (common with ~88 fabricated web-search URLs).
 *
 * @param {Object} review - Review object with showId, outletId, outlet, criticName, url
 * @returns {string|null} - Discovered URL, or null if not found
 */
const URL_DISCOVERY_MAX_PER_RUN = 50; // Cap SERP API calls to control costs

async function discoverCorrectUrl(review) {
  if (!CONFIG.scrapingBeeKey || !axios) {
    return null;
  }

  // Per-run cap to prevent runaway SERP API costs
  if (stats.urlDiscoveryAttempts >= URL_DISCOVERY_MAX_PER_RUN) {
    stats.urlDiscoveryCapped++;
    console.log(`    ⚠ URL discovery capped (${URL_DISCOVERY_MAX_PER_RUN}/run limit reached)`);
    return null;
  }

  stats.urlDiscoveryAttempts++;

  // Look up real show title from shows.json (handles apostrophes, special chars)
  // Falls back to slug-derived title if lookup fails
  let showTitle;
  let showYear = '';
  try {
    const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
    const showEntry = showsData.shows.find(s => s.id === review.showId);
    if (showEntry) {
      showTitle = showEntry.title;
      showYear = (showEntry.openingDate || '').substring(0, 4);
    }
  } catch (e) { /* fall through to slug-based */ }

  if (!showTitle) {
    showTitle = (review.showId || '')
      .replace(/-\d{4}$/, '')
      .replace(/-/g, ' ');
    // Extract year from showId as fallback
    const yearMatch = (review.showId || '').match(/-(\d{4})$/);
    if (yearMatch) showYear = yearMatch[1];
  }

  if (!showTitle) return null;

  // Get domain for the outlet
  const outletId = (review.outletId || '').toLowerCase();
  const domain = CONFIG.outletDomains[outletId];

  // Build search query — include year to disambiguate revivals (Our Town 2024 vs 2009)
  // NOTE: We intentionally omit the critic name from the query. Fabricated reviews
  // (source: "web-search") often have wrong critic attributions, and including a
  // non-existent critic name kills the search (0 results). The goal is to find
  // the real review URL at the outlet, not to verify the critic.
  const yearClause = showYear ? ` ${showYear}` : '';
  let query;
  if (domain) {
    query = `site:${domain} "${showTitle}" Broadway review${yearClause}`;
  } else {
    // No known domain - use outlet name
    const outletName = review.outlet || outletId;
    query = `"${showTitle}" Broadway review${yearClause} "${outletName}"`;
  }

  console.log(`  [URL Discovery] Searching: ${query}`);

  try {
    const response = await axios.get('https://app.scrapingbee.com/api/v1/store/google', {
      params: {
        api_key: CONFIG.scrapingBeeKey,
        search: query,
      },
      timeout: 30000,
    });

    // ScrapingBee SERP API returns JSON with organic_results
    const data = response.data;
    const results = data.organic_results || data.results || [];

    if (!results.length) {
      console.log('    ✗ No search results found');
      return null;
    }

    // Extract the old URL's domain for comparison
    let oldDomain = '';
    try {
      oldDomain = new URL(review.url).hostname.replace(/^www\./, '');
    } catch (e) {}

    // Find best matching result
    const targetDomain = domain || oldDomain;
    const showTitleLower = showTitle.toLowerCase();

    for (const result of results.slice(0, 5)) {
      const url = result.url || result.link;
      if (!url) continue;

      // Skip non-article URLs (homepage, category pages, search results)
      const urlLower = url.toLowerCase();
      if (urlLower.endsWith('.com/') || urlLower.endsWith('.com')) continue;
      if (urlLower.includes('/search?') || urlLower.includes('/tag/') || urlLower.includes('/category/')) continue;

      // Skip if same as the dead URL
      if (url === review.url) continue;

      // Check domain match
      let urlDomain = '';
      try {
        urlDomain = new URL(url).hostname.replace(/^www\./, '');
      } catch (e) { continue; }

      if (targetDomain && !urlDomain.includes(targetDomain.replace(/^www\./, ''))) continue;

      // Check relevance - title must mention the show (snippets have too many false positives)
      const title = (result.title || '').toLowerCase();
      const showSlugCheck = showTitleLower.replace(/\s+/g, '-');

      const titleHasShow = title.includes(showTitleLower);
      const urlHasShow = urlLower.includes(showSlugCheck);
      const titleHasReview = title.includes('review');

      // Require: (title mentions show) OR (URL contains show slug)
      // AND at least one signal it's a review (title says "review" or URL contains "review")
      if (!titleHasShow && !urlHasShow) continue;
      if (!titleHasReview && !urlLower.includes('review')) continue;

      // Looks like a match
      console.log(`    ✓ Found: ${url}`);
      stats.urlDiscoverySuccess++;
      stats.urlDiscoveryDetails.push({
        reviewId: review.reviewId || `${review.showId}/${review.file}`,
        oldUrl: review.url,
        newUrl: url,
      });
      return url;
    }

    // Fallback: if we have domain match but no title match, take first domain-matching result
    if (targetDomain) {
      for (const result of results.slice(0, 3)) {
        const url = result.url || result.link;
        if (!url || url === review.url) continue;
        let urlDomain = '';
        try { urlDomain = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { continue; }
        if (urlDomain.includes(targetDomain.replace(/^www\./, ''))) {
          const urlLower = url.toLowerCase();
          if (urlLower.endsWith('.com/') || urlLower.endsWith('.com')) continue;
          // Accept only if URL path contains show-related slug (not just "review" — too permissive)
          const showSlug = showTitleLower.replace(/\s+/g, '-');
          if (urlLower.includes(showSlug)) {
            console.log(`    ✓ Found (fallback): ${url}`);
            stats.urlDiscoverySuccess++;
            stats.urlDiscoveryDetails.push({
              reviewId: review.reviewId || `${review.showId}/${review.file}`,
              oldUrl: review.url,
              newUrl: url,
            });
            return url;
          }
        }
      }
    }

    console.log('    ✗ No matching URL found in search results');
    return null;
  } catch (error) {
    console.log(`    ✗ URL discovery failed: ${error.message}`);
    return null;
  }
}

// ============================================================================
// UNIFIED FETCH FUNCTION
// ============================================================================

async function fetchReviewText(review) {
  const attempts = [];
  let html = null;
  let text = null;
  let method = null;
  let archiveData = {};

  const url = review.url;
  const urlLower = url.toLowerCase();

  // Determine if we should skip Playwright (known-blocked or --aggressive flag)
  const isKnownBlocked = CONFIG.knownBlockedSites.some(s => urlLower.includes(s));
  const skipPlaywright = CLI.aggressive && isKnownBlocked;
  const isBrightDataPreferred = CONFIG.brightDataPreferred.some(s => urlLower.includes(s));
  const isArchiveFirstSite = CONFIG.archiveFirstSites.some(s => urlLower.includes(s));

  // Determine if this is an "old" review (>6 months) - Archive.org often works better for these
  let isOldReview = false;
  if (review.publishDate) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    isOldReview = review.publishDate < sixMonthsAgo;
  }

  // Use archive-first approach if:
  // 1. ARCHIVE_FIRST env var is set to true, OR
  // 2. Site is in archiveFirstSites list, OR
  // 3. Review is older than 6 months (when ARCHIVE_FIRST is enabled)
  const isArchiveFirst = isArchiveFirstSite || (CONFIG.archiveFirst && isOldReview);

  // Force specific tier if requested
  if (CLI.forceTier) {
    const tier = parseFloat(CLI.forceTier);
    try {
      switch (tier) {
        case 1:
          const r1 = await fetchWithPlaywright(url, review);
          return { html: r1.html, text: r1.text, method: 'playwright', attempts: [{ tier: 1, method: 'playwright', success: true }] };
        case 1.5:
          const r1_5 = await fetchWithBrowserbase(url, review);
          return { html: r1_5.html, text: r1_5.text, method: 'browserbase', attempts: [{ tier: 1.5, method: 'browserbase', success: true }] };
        case 2:
          const r2 = await fetchWithScrapingBee(url);
          return { html: r2.html, text: r2.text, method: 'scrapingbee', attempts: [{ tier: 2, method: 'scrapingbee', success: true }] };
        case 3:
          const r3 = await fetchWithBrightData(url);
          return { html: r3.html, text: r3.text, method: 'brightdata', attempts: [{ tier: 3, method: 'brightdata', success: true }] };
        case 4:
          const r4 = await fetchFromArchive(url);
          return { html: r4.html, text: r4.text, method: 'archive', archiveData: r4, attempts: [{ tier: 4, method: 'archive', success: true }] };
      }
    } catch (e) {
      throw new Error(`Forced tier ${tier} failed: ${e.message}`);
    }
  }

  // For paywalled sites, try Archive.org FIRST (Wayback often has pre-paywall content)
  if (isArchiveFirst) {
    console.log('  [Tier 0] Archive.org (paywalled site - trying archive first)...');
    try {
      const result = await fetchFromArchive(url);
      html = result.html;
      text = result.text;
      method = 'archive';
      archiveData = result;
      attempts.push({ tier: 0, method: 'archive-first', success: true });
      return { html, text, method, archiveData, attempts };
    } catch (error) {
      attempts.push({ tier: 0, method: 'archive-first', success: false, error: error.message });
      console.log(`    ✗ Archive.org failed: ${error.message}`);
      console.log('    Falling back to standard tier chain...');
    }
  }

  // TIER 1: Playwright with stealth (unless skipped)
  if (!skipPlaywright) {
    console.log('  [Tier 1] Playwright with stealth...');
    try {
      const result = await fetchWithPlaywright(url, review);
      html = result.html;
      text = result.text;
      method = 'playwright';
      attempts.push({ tier: 1, method: 'playwright', success: true });
      return { html, text, method, attempts };
    } catch (error) {
      attempts.push({ tier: 1, method: 'playwright', success: false, error: error.message });
      console.log(`    ✗ Failed: ${error.message}`);

      // If 404, only try Archive.org then bail - don't waste API credits on dead URLs
      // (URL discovery is handled by processReview after this function throws)
      if (error.message.includes('404')) {
        console.log('  [Tier 4] Archive.org (404 detected - skipping other tiers)...');
        try {
          const result = await fetchFromArchive(url);
          html = result.html;
          text = result.text;
          method = 'archive';
          archiveData = result;
          attempts.push({ tier: 4, method: 'archive', success: true });
          return { html, text, method, archiveData, attempts };
        } catch (e) {
          attempts.push({ tier: 4, method: 'archive', success: false, error: e.message });
          console.log(`    ✗ Archive.org failed: ${e.message}`);
        }
        // URL is definitely dead - don't waste ScrapingBee/BrightData credits
        throw new Error(`URL returned 404 (archive also failed): ${JSON.stringify(attempts)}`);
      }
    }
  } else {
    console.log('  [Tier 1] Skipped (known-blocked site + aggressive mode)');
    attempts.push({ tier: 1, method: 'playwright', success: false, error: 'Skipped - known blocked site' });
  }

  // TIER 1.5: Browserbase (managed browser cloud with CAPTCHA solving)
  // Only use for known-blocked sites or when Playwright fails with CAPTCHA
  const lastAttempt = attempts[attempts.length - 1];
  const playwrightHitCaptcha = lastAttempt?.error?.includes('CAPTCHA') || lastAttempt?.error?.includes('blocked');
  const shouldTryBrowserbase = CONFIG.browserbaseEnabled && (isKnownBlocked || playwrightHitCaptcha);

  if (shouldTryBrowserbase && canUseBrowserbase()) {
    console.log('  [Tier 1.5] Browserbase (managed browser + CAPTCHA solving)...');
    try {
      const result = await fetchWithBrowserbase(url, review);
      html = result.html;
      text = result.text;
      method = 'browserbase';
      attempts.push({ tier: 1.5, method: 'browserbase', success: true });
      state.tierBreakdown.browserbase.push(review.filePath);
      return { html, text, method, attempts };
    } catch (error) {
      attempts.push({ tier: 1.5, method: 'browserbase', success: false, error: error.message });
      console.log(`    ✗ Failed: ${error.message}`);
    }
  }

  // TIER 2: ScrapingBee (with stealth retry if --stealth-proxy flag)
  if (CONFIG.scrapingBeeKey) {
    console.log('  [Tier 2] ScrapingBee API...');
    try {
      const result = await fetchWithScrapingBee(url, false);
      html = result.html;
      text = result.text;
      method = 'scrapingbee';
      attempts.push({ tier: 2, method: 'scrapingbee', success: true });
      return { html, text, method, attempts };
    } catch (error) {
      attempts.push({ tier: 2, method: 'scrapingbee', success: false, error: error.message });
      console.log(`    ✗ Failed: ${error.message}`);
      // If ScrapingBee also got 404, URL is confirmed dead - bail out
      // (URL discovery is handled by processReview after this function throws)
      if (error.message.includes('404')) {
        throw new Error(`URL confirmed dead (404 from multiple tiers): ${JSON.stringify(attempts)}`);
      }
    }
  }

  // TIER 3: Bright Data (especially for paywalls)
  if (CONFIG.brightDataKey) {
    console.log('  [Tier 3] Bright Data Web Unlocker...');
    try {
      const result = await fetchWithBrightData(url);
      html = result.html;
      text = result.text;
      method = 'brightdata';
      attempts.push({ tier: 3, method: 'brightdata', success: true });
      return { html, text, method, attempts };
    } catch (error) {
      attempts.push({ tier: 3, method: 'brightdata', success: false, error: error.message });
      console.log(`    ✗ Failed: ${error.message}`);
    }
  }

  // TIER 4: Archive.org (last resort)
  console.log('  [Tier 4] Archive.org Wayback Machine...');
  try {
    const result = await fetchFromArchive(url);
    html = result.html;
    text = result.text;
    method = 'archive';
    archiveData = result;
    attempts.push({ tier: 4, method: 'archive', success: true });
    return { html, text, method, archiveData, attempts };
  } catch (error) {
    attempts.push({ tier: 4, method: 'archive', success: false, error: error.message });
    console.log(`    ✗ Failed: ${error.message}`);
  }

  // All tiers failed
  throw new Error(`All tiers failed: ${JSON.stringify(attempts)}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getPaywallCredentials(url) {
  for (const [domain, creds] of Object.entries(CONFIG.paywalledDomains)) {
    if (url.includes(domain)) {
      const email = process.env[creds.emailVar];
      const password = process.env[creds.passVar];
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
  const lower = html.toLowerCase();
  return (
    lower.includes('captcha') ||
    lower.includes('datadome') ||
    lower.includes('access denied') ||
    lower.includes('please verify') ||
    lower.includes('robot check') ||
    lower.includes('unusual traffic') ||
    lower.includes('rate limit') ||
    (lower.includes('403') && lower.includes('forbidden')) ||
    (lower.includes('blocked') && lower.includes('request'))
  );
}

function isPaywalled(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('subscribe to continue') ||
    lower.includes('subscription required') ||
    lower.includes('create a free account') ||
    lower.includes('sign in to read') ||
    lower.includes('already a subscriber') ||
    (lower.includes('paywall') && !lower.includes('no paywall'))
  );
}

async function extractArticleText(page) {
  return await page.evaluate(() => {
    // Site-specific selectors first (most precise), then generic fallbacks
    const selectors = [
      // NYT
      '[data-testid="article-body"]',
      'section[name="articleBody"]',
      // Vulture / NY Mag / Condé Nast
      '[class*="ArticlePageChunks"]',
      '[class*="RawHtmlBody"]',
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
          } else {
            const text = el.textContent.trim();
            if (text.length > bestText.length) {
              bestText = text;
            }
          }
        }
      } catch (e) {}
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

    return bestText
      .replace(/\s+/g, ' ')
      .replace(/Subscribe to our newsletter[^.]*\./gi, '')
      .replace(/Sign up for[^.]*\./gi, '')
      .replace(/Advertisement/gi, '')
      .trim();
  });
}

function extractTextFromHtml(html) {
  if (!html || typeof html !== 'string') return '';

  // Remove scripts, styles, nav, etc.
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

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

  return paragraphs.join('\n\n');
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

  fs.writeFileSync(archivePath, header + html);
  return archivePath;
}

// Junk patterns to strip from end of reviews (newsletter promos, login prompts, site footers)
const TRAILING_JUNK_PATTERNS = [
  // TheaterMania newsletter promos
  /\s*Get the latest news, discounts and updates on theater and shows by signing up for TheaterMania.*$/is,
  /\s*TheaterMania&#039;s newsletter today!.*$/is,
  // BroadwayNews login prompts
  /\s*Already have an account\?\s*(Sign in|Log in).*$/is,
  // amNY "Read more" promos
  /\s*Read more:\s*[^\n]+$/i,
  // Vulture/NY Mag signup junk
  /\s*This email will be used to sign into all New York sites.*$/is,
  /\s*By submitting your email, you agree to our Terms and Privacy Policy.*$/is,
  /\s*Password must be at least 8 characters.*$/is,
  /\s*You're in!\s*As part of your account.*$/is,
  /\s*which you can opt out of anytime\.\s*$/i,
  /\s*occasional updates and offers from New York.*$/is,
  // Generic newsletter/promo junk
  /\s*Sign up for our newsletter.*$/is,
  /\s*Subscribe to our newsletter.*$/is,
  // Site footers
  /\s*About Us\s*\|\s*Editorial Guidelines\s*\|\s*Contact Us.*$/is,
  /\s*Share full article\d*Related Content.*$/is,
  /\s*Copyright\s*©?\s*\d{4}.*$/is,
  /\s*All rights reserved\.?\s*$/i,
  /\s*Excerpts and links to the content may be used.*$/is,
  // NYT bio junk
  /\s*is the chief theater critic for The Times\..*$/is,
  /\s*is a theater critic for The Times\..*$/is,
];

// Strip trailing junk (newsletter promos, login prompts) from review text
function stripTrailingJunk(text) {
  if (!text) return text;
  let cleaned = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TRAILING_JUNK_PATTERNS) {
      const before = cleaned;
      cleaned = cleaned.replace(pattern, '').trim();
      if (cleaned !== before) changed = true;
    }
  }
  return cleaned;
}

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
  };
  return map[method] || method;
}

function updateReviewJson(review, text, validation, archivePath, method, attempts, archiveData = {}, html = '', contentVerification = null) {
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
    data.previousLlmScore = data.llmScore.score;
    console.log(`    → Flagged for rescore: was scored at ${data.llmScore.score} on excerpt, now has ${text.length} char fullText`);
  }

  // Text quality classification with truncation detection (also cleans trailing junk)
  const qualityResult = classifyTextQuality(text, review.showId || data.showId, validation.wordCount, excerptLength);

  // Use cleaned text (junk stripped) if available, otherwise original
  const cleanedText = qualityResult.cleanedText || text;
  data.fullText = cleanedText;
  data.isFullReview = cleanedText.length > 1500;
  data.textWordCount = cleanedText.split(/\s+/).filter(w => w.length > 0).length;
  data.archivePath = archivePath;
  data.textFetchedAt = new Date().toISOString();

  // Extract original score from HTML/text if not already present
  if (!data.originalScore && (html || text)) {
    const outletId = data.outletId || review.outletId || '';
    const scoreResult = extractScore(html, text, outletId);
    if (scoreResult) {
      data.originalScore = scoreResult.originalScore;
      data.originalScoreNormalized = scoreResult.normalizedScore;
      data.scoreSource = scoreResult.source;
      console.log(`    → Extracted score: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100)`);
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

  // Store LLM content verification results
  if (contentVerification) {
    data.contentVerification = {
      isValid: contentVerification.isValid,
      confidence: contentVerification.confidence,
      truncated: contentVerification.truncated,
      wrongArticle: contentVerification.wrongArticle,
      issues: contentVerification.issues,
      verifiedBy: contentVerification.verifiedBy,
      verifiedAt: new Date().toISOString()
    };

    // Flag for manual review if LLM detected issues
    if (contentVerification.wrongArticle) {
      data.flaggedForReview = true;
      data.flagReason = 'LLM detected possible wrong article';
    }
    if (contentVerification.truncated && !data.truncationSignals) {
      data.textQuality = 'truncated';
    }
  }

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
        // Ensure tierBreakdown exists
        if (!state.tierBreakdown) {
          state.tierBreakdown = { playwright: [], scrapingbee: [], brightdata: [], archive: [] };
        }
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
}

/**
 * Commit changes to git (for incremental saving during long runs)
 * This prevents losing work if the job times out
 */
function commitChanges(processed) {
  const { execSync } = require('child_process');

  try {
    // Check if we're in a git repo and in CI
    if (!process.env.GITHUB_ACTIONS) {
      console.log('  (Skipping git commit - not in GitHub Actions)');
      return;
    }

    // Stage changes
    execSync('git add data/review-texts/ data/archives/reviews/ data/collection-state/', {
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

      // Commit
      execSync(`git commit -m "chore: Checkpoint - collected ${processed} review texts"`, {
        stdio: 'pipe'
      });

      // Sync with remote and push
      // Strategy: fetch, rebase, auto-resolve conflicts in data files (keep ours)
      let pushSucceeded = false;

      try {
        // First fetch to see what's on remote
        execSync('git fetch origin main', { stdio: 'pipe' });

        // Try simple rebase first
        try {
          execSync('git rebase origin/main', { stdio: 'pipe' });
          pushSucceeded = true;
        } catch (rebaseErr) {
          // Rebase has conflicts - for data files, keep our version
          console.log('    Rebase conflict detected, auto-resolving data files...');

          try {
            // Accept our version for all conflicted data files
            execSync('git checkout --ours data/', { stdio: 'pipe' });
            execSync('git add data/', { stdio: 'pipe' });

            // Continue the rebase
            try {
              execSync('git rebase --continue', { stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
              pushSucceeded = true;
            } catch (continueErr) {
              // If continue fails, abort and try merge approach
              try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch (e) {}
            }
          } catch (resolveErr) {
            // Couldn't resolve, abort rebase
            try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch (e) {}
          }
        }

        // If rebase approach failed, try merge with ours strategy for data
        if (!pushSucceeded) {
          console.log('    Trying merge approach...');
          try {
            execSync('git merge origin/main -X ours --no-edit', { stdio: 'pipe' });
            pushSucceeded = true;
          } catch (mergeErr) {
            console.log('    Merge also failed');
          }
        }

        if (pushSucceeded) {
          execSync('git push origin HEAD:main', { stdio: 'pipe' });
        } else {
          throw new Error('Could not sync with remote');
        }
      } catch (syncErr) {
        // Last resort: force push just our data changes
        // This is safe because we're only adding/modifying data/review-texts files
        console.log('    Attempting force push for data files only...');
        try {
          execSync('git push origin HEAD:main --force-with-lease', { stdio: 'pipe' });
        } catch (forceErr) {
          throw new Error(`Push failed: ${forceErr.message}`);
        }
      }

      console.log(`  ✓ Committed and pushed checkpoint (${processed} reviews)`);
    } else {
      console.log('  (No changes to commit)');
    }
  } catch (e) {
    console.error(`  ✗ Git commit/push FAILED: ${e.message}`);
    console.error(`    This means work may be lost if the job times out!`);
    console.error(`    Check workflow permissions: needs 'contents: write'`);
    // Don't throw - we don't want to stop the collection
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

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => fs.statSync(path.join(CONFIG.reviewTextsDir, f)).isDirectory());

  // Load failed fetches to retry if requested
  const failedFetches = new Set();
  if (CONFIG.retryFailed) {
    const failedPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
    if (fs.existsSync(failedPath)) {
      try {
        const failed = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
        failed.forEach(f => failedFetches.add(f.reviewId || `${f.showId}/${f.file}`));
      } catch (e) {}
    }
  }

  for (const showId of shows) {
    if (CONFIG.showFilter && showId !== CONFIG.showFilter) continue;

    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const reviewId = `${showId}/${file}`;

      // Skip already processed in this run
      if (state.processed.includes(reviewId)) continue;
      // Skip failed unless retry mode
      if (!CONFIG.retryFailed && state.failed.includes(reviewId)) continue;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip misattributed/wrong reviews entirely
        if (data.wrongAttribution || data.wrongProduction || data.wrongShow) {
          continue;
        }

        // Skip if already has good text (unless retrying failed)
        const textLen = data.fullText ? data.fullText.length : 0;
        const isTruncated = data.textQuality === 'truncated' || data.textStatus === 'truncated';
        // Always re-try truncated reviews - they have text but it's incomplete
        if (!isTruncated && (data.isFullReview === true || data.textQuality === 'full' || textLen > 1500) && !failedFetches.has(reviewId)) {
          continue;
        }

        // Skip if no URL
        if (!data.url) continue;

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

        // Parse publish date for archive-first logic
        let publishDate = null;
        if (data.publishDate) {
          try {
            publishDate = new Date(data.publishDate);
          } catch (e) {}
        }

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
        });
      } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
      }
    }
  }

  // Sort by priority (Tier 1 outlets first)
  reviews.sort((a, b) => a.priority - b.priority);

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
    // If we can't create a new page, browser may be crashed - health check will handle it
    console.log(`  ⚠ Could not create fresh page: ${e.message}`);
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

      // Record as failed fetch with reason
      const failedEntry = {
        reviewId: review.reviewId,
        showId: review.showId,
        outlet: review.outlet,
        critic: review.critic,
        url: review.url,
        method: result.method,
        failureReason: 'garbage_content',
        garbageReason: qualityCheck.issues.join('; '),
        textLength: result.text.length,
        timestamp: new Date().toISOString()
      };

      // Save to failed fetches tracking
      const failedFetchesPath = path.join(CONFIG.reviewTextsDir, 'failed-fetches.json');
      let failedFetches = [];
      if (fs.existsSync(failedFetchesPath)) {
        try {
          failedFetches = JSON.parse(fs.readFileSync(failedFetchesPath, 'utf8'));
        } catch (e) {
          failedFetches = [];
        }
      }
      // Remove any existing entry for this review
      failedFetches = failedFetches.filter(f => f.reviewId !== review.reviewId);
      failedFetches.push(failedEntry);
      fs.writeFileSync(failedFetchesPath, JSON.stringify(failedFetches, null, 2));

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

    // LLM-based content verification (if enabled)
    let contentVerification = null;
    if (CLI.llmVerify && validation.wordCount >= 200) {
      console.log(`  LLM Verification...`);
      try {
        // Get excerpt from existing review data
        const reviewData = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));
        const excerpt = reviewData.dtliExcerpt || reviewData.bwwExcerpt || reviewData.showScoreExcerpt || '';

        contentVerification = await verifyContent({
          scrapedText: result.text,
          excerpt: excerpt,
          showTitle: reviewData.showId?.replace(/-\d{4}$/, '').replace(/-/g, ' ') || '',
          outletName: review.outlet,
          criticName: review.critic
        });

        console.log(`  LLM Verify: ${contentVerification.isValid ? 'VALID' : 'ISSUES'} (${contentVerification.confidence} confidence)`);
        if (contentVerification.issues.length > 0) {
          console.log(`  LLM Issues: ${contentVerification.issues.join(', ')}`);
        }
        if (contentVerification.wrongArticle) {
          console.log(`  ⚠ WARNING: May be wrong article!`);
        }
        if (contentVerification.truncated) {
          console.log(`  ⚠ WARNING: Content appears truncated`);
        }
      } catch (e) {
        console.log(`  LLM Verify error: ${e.message}`);
      }
    }

    // Update JSON (pass HTML for score extraction)
    updateReviewJson(review, result.text, validation, archivePath, result.method, result.attempts, result.archiveData || {}, result.html || '', contentVerification);

    // Track tier breakdown
    if (result.method && state.tierBreakdown[result.method]) {
      state.tierBreakdown[result.method].push(review.reviewId);
    }

    return { success: true, method: result.method, validation };

  } catch (error) {
    console.log(`  ✗ FAILED: ${error.message}`);

    // URL Discovery: If the failure was a 404 and we haven't retried yet, try to find the correct URL
    if (error.message.includes('404') && !review._discoveryAttempted && review.filePath) {
      review._discoveryAttempted = true;
      console.log('\n  [URL Discovery] Attempting to find correct URL via Google...');
      const discoveredUrl = await discoverCorrectUrl(review);

      if (discoveredUrl) {
        const originalUrl = review.url;
        review.url = discoveredUrl;
        console.log(`  [Retry] Re-attempting fetch with discovered URL...`);

        try {
          const retryResult = await fetchReviewText(review);
          console.log(`  ✓ SUCCESS via ${retryResult.method} with discovered URL (${retryResult.text.length} chars)`);

          // Update the review file's URL atomically (write to .tmp, then rename)
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

          // Continue with normal success processing (quality check, validation, etc.)
          const showTitle = review.showId ? review.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ') : '';
          const qualityCheck = assessTextQuality(retryResult.text, showTitle);
          if (qualityCheck.quality === 'garbage' && qualityCheck.confidence === 'high') {
            console.log(`  ✗ GARBAGE CONTENT from discovered URL: ${qualityCheck.issues[0]}`);
            stats.totalFailed++;
            return { success: false, error: 'garbage_content_from_discovered_url' };
          }

          const archivePath = retryResult.html ? archiveHtml(retryResult.html, review, retryResult.method) : null;
          const validation = validateReviewText(retryResult.text, review);
          updateReviewJson(review, retryResult.text, validation, archivePath, retryResult.method, retryResult.attempts, retryResult.archiveData || {}, retryResult.html || '', null);

          if (retryResult.method && state.tierBreakdown[retryResult.method]) {
            state.tierBreakdown[retryResult.method].push(review.reviewId);
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
      playwright: state.tierBreakdown.playwright.length,
      browserbase: state.tierBreakdown.browserbase?.length || 0,
      scrapingbee: state.tierBreakdown.scrapingbee.length,
      brightdata: state.tierBreakdown.brightdata.length,
      archive: state.tierBreakdown.archive.length,
    },
    statistics: {
      tier1Attempts: stats.tier1Attempts,
      tier1Success: stats.tier1Success,
      tier1_5Attempts: stats.tier1_5Attempts,
      tier1_5Success: stats.tier1_5Success,
      tier2Attempts: stats.tier2Attempts,
      tier2Success: stats.tier2Success,
      tier3Attempts: stats.tier3Attempts,
      tier3Success: stats.tier3Success,
      tier4Attempts: stats.tier4Attempts,
      tier4Success: stats.tier4Success,
      totalFailed: stats.totalFailed,
      scrapingBeeCreditsUsed: stats.scrapingBeeCreditsUsed,
      browserbaseSessionsUsed: stats.browserbaseSessionsUsed,
      browserbaseMinutesUsed: Math.round(stats.browserbaseMinutesUsed * 10) / 10,
      urlDiscoveryAttempts: stats.urlDiscoveryAttempts,
      urlDiscoverySuccess: stats.urlDiscoverySuccess,
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
  console.log(`║ ├─ Tier 1.5 (Browserbase):${String(report.tierBreakdown.browserbase).padStart(30)} ║`);
  console.log(`║ ├─ Tier 2 (ScrapingBee): ${String(report.tierBreakdown.scrapingbee).padStart(31)} ║`);
  console.log(`║ ├─ Tier 3 (Bright Data): ${String(report.tierBreakdown.brightdata).padStart(31)} ║`);
  console.log(`║ └─ Tier 4 (Archive.org): ${String(report.tierBreakdown.archive).padStart(31)} ║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ API USAGE                                                ║`);
  console.log(`║ ├─ ScrapingBee credits: ${String(stats.scrapingBeeCreditsUsed).padStart(32)} ║`);
  console.log(`║ └─ Browserbase sessions: ${String(stats.browserbaseSessionsUsed).padStart(31)} ║`);
  if (stats.urlDiscoveryAttempts > 0) {
    console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
    console.log(`║ URL DISCOVERY                                            ║`);
    console.log(`║ ├─ Attempted: ${String(stats.urlDiscoveryAttempts).padStart(42)} ║`);
    console.log(`║ ├─ Found: ${String(stats.urlDiscoverySuccess).padStart(46)} ║`);
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

  // Load dependencies
  await loadDependencies();

  console.log(`\nAPI Status:`);
  console.log(`  ScrapingBee: ${CONFIG.scrapingBeeKey ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Bright Data: ${CONFIG.brightDataKey ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Browserbase: ${CONFIG.browserbaseEnabled ? `✓ enabled (limit: ${CONFIG.browserbaseMaxSessionsPerDay}/day)` : '✗ disabled'}`);
  console.log(`  Stealth Plugin: ${stealthLoaded ? '✓ loaded' : '⚠ using fallback'}`);

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

      const result = await processReview(review);

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

    // Final state save and commit
    saveState();
    commitChanges(state.processed.length);

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
