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
  browserbaseMaxSessionsPerRun: parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_RUN || '10'), // Per workflow run
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

      // Additional wait for JS rendering
      await page.waitForTimeout(3000);

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
      await page.goto('https://myaccount.nytimes.com/auth/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

      // Email step
      const emailInput = await page.$('input[name="email"]');
      if (emailInput) {
        await emailInput.fill(email);
        await page.click('button[data-testid="submit-email"]').catch(() => {});
        await page.waitForTimeout(3000);

        // Password step
        const passInput = await page.$('input[name="password"]');
        if (passInput) {
          await passInput.fill(password);
          await page.click('button[data-testid="login-button"]').catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }

      // Verify login by checking for user menu
      const loggedIn = await page.$('[data-testid="user-menu"]').catch(() => null);
      if (loggedIn) {
        console.log('    ✓ NYT login successful');
        return true;
      }
      console.log('    ⚠ NYT login may have failed');
      return true; // Continue anyway
    }

    if (domain === 'vulture.com' || domain === 'nymag.com' || domain === 'newyorker.com') {
      await page.goto('https://www.vulture.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

      await page.fill('input[type="email"]', email).catch(() => {});
      await page.fill('input[type="password"]', password).catch(() => {});
      await page.click('button[type="submit"]').catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);

      console.log('    ✓ Vulture/Condé Nast login attempted');
      return true;
    }

    if (domain === 'washingtonpost.com') {
      await page.goto('https://www.washingtonpost.com/subscribe/signin/', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

      await page.fill('input[name="email"]', email).catch(() => {});
      await page.fill('input[name="password"]', password).catch(() => {});
      await page.click('button[type="submit"]').catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);

      console.log('    ✓ Washington Post login attempted');
      return true;
    }

    if (domain === 'wsj.com') {
      await page.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

      // WSJ login form
      await page.fill('input[name="username"]', email).catch(() => {});
      await page.click('button[type="submit"]').catch(() => {}); // Continue button
      await page.waitForTimeout(2000);

      await page.fill('input[name="password"]', password).catch(() => {});
      await page.click('button[type="submit"]').catch(() => {}); // Sign in button
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);

      console.log('    ✓ WSJ login attempted');
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

      // If 404, skip to Archive.org
      if (error.message.includes('404')) {
        console.log('  [Tier 4] Archive.org (404 detected)...');
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
    const selectors = [
      'article .entry-content',
      'article .post-content',
      'article .article-body',
      '[data-testid="article-body"]',
      '.article-body',
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

// Detect truncation signals in text
// Returns object with detected signals and whether likely truncated
function detectTruncationSignals(text, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { signals: [], likelyTruncated: false };
  }

  const signals = [];
  const trimmedText = text.trim();
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
  const likelyTruncated = hasSevereSignal || signals.length >= 2;

  return { signals, likelyTruncated };
}

// Classify text quality based on rules:
// - full: >1500 chars AND mentions show title AND >300 words AND no truncation signals
// - truncated: Has truncation signals (paywall, read more, etc.)
// - partial: 500-1500 chars OR larger but missing criteria
// - excerpt: <500 chars
// - missing: no text
function classifyTextQuality(text, showId, wordCount, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { quality: 'missing', truncationSignals: [] };
  }

  const charCount = text.length;
  // Extract title from showId (e.g., "hamilton-2015" -> "hamilton")
  const titleLower = showId ? showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase() : '';
  const textLower = text.toLowerCase();
  const hasShowTitle = titleLower && textLower.includes(titleLower);

  // Detect truncation signals
  const { signals, likelyTruncated } = detectTruncationSignals(text, excerptLength);

  // If truncation detected, mark as truncated regardless of length
  if (likelyTruncated) {
    return { quality: 'truncated', truncationSignals: signals };
  }

  // Full: >1500 chars AND mentions show title AND >300 words AND no truncation
  if (charCount > 1500 && hasShowTitle && wordCount > 300 && signals.length === 0) {
    return { quality: 'full', truncationSignals: signals };
  }

  // Partial: 500-1500 chars OR larger but missing criteria
  if (charCount >= 500 && charCount <= 1500) {
    return { quality: 'partial', truncationSignals: signals };
  }
  if (charCount > 1500 && (!hasShowTitle || wordCount <= 300)) {
    return { quality: 'partial', truncationSignals: signals };
  }

  // Excerpt: <500 chars
  if (charCount < 500) {
    return { quality: 'excerpt', truncationSignals: signals };
  }

  return { quality: 'partial', truncationSignals: signals };
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

  data.fullText = text;
  data.isFullReview = text.length > 1500;
  data.textWordCount = validation.wordCount;
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

  // Text quality classification with truncation detection
  const qualityResult = classifyTextQuality(text, review.showId || data.showId, validation.wordCount, excerptLength);
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

        // Skip if already has full text (unless retrying failed)
        const textLen = data.fullText ? data.fullText.length : 0;
        if ((data.isFullReview === true || textLen > 1500) && !failedFetches.has(reviewId)) {
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
    stats.totalFailed++;
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
    },
    processed: state.processed,
    failed: state.failed,
    tierDetails: state.tierBreakdown,
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
  console.log(`${'╚' + '═'.repeat(58) + '╝'}`);
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
