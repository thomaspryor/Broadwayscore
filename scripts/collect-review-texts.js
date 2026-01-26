/**
 * Collect Review Texts - Multi-Tier Fallback System
 *
 * TIER 1: Playwright-extra with stealth plugin + login for paywalls
 * TIER 2: ScrapingBee API (945 credits available)
 * TIER 3: Bright Data Web Unlocker (for aggressive paywalls)
 * TIER 4: Archive.org Wayback Machine (for 404s and last resort)
 *
 * Environment variables:
 *   NYT_EMAIL, NYT_PASSWORD - New York Times credentials
 *   VULTURE_EMAIL, VULTURE_PASSWORD - Vulture/NY Mag credentials
 *   WAPO_EMAIL, WAPO_PASSWORD - Washington Post credentials
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key
 *   BRIGHTDATA_API_KEY - Bright Data API key
 *   BRIGHTDATA_CUSTOMER_ID - Bright Data customer ID
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

// Parse CLI arguments
const args = process.argv.slice(2);
const CLI = {
  aggressive: args.includes('--aggressive'),
  forceTier: args.find(a => a.startsWith('--tier='))?.split('=')[1],
  testUrl: args.find(a => a.startsWith('--test-url='))?.split('=')[1],
  stealthProxy: args.includes('--stealth-proxy'), // Use ScrapingBee stealth proxy (25 credits/req)
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

  // API Keys
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
  brightDataKey: process.env.BRIGHTDATA_API_KEY || '',
  brightDataCustomerId: process.env.BRIGHTDATA_CUSTOMER_ID || '',

  // Directories
  reviewTextsDir: 'data/review-texts',
  archivesDir: 'data/archives/reviews',
  stateDir: 'data/collection-state',
  auditDir: 'data/audit/validation',

  // Tier 1 outlets (highest priority for scoring)
  tier1Outlets: ['nytimes', 'nyt', 'vulture', 'vult', 'variety', 'hollywood-reporter', 'thr', 'newyorker'],

  // Paywalled domains and their credential env vars
  paywalledDomains: {
    'nytimes.com': { emailVar: 'NYT_EMAIL', passVar: 'NYT_PASSWORD' },
    'vulture.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'nymag.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'newyorker.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'washingtonpost.com': { emailVar: 'WAPO_EMAIL', passVar: 'WAPO_PASSWORD' },
  },

  // Sites known to block aggressively (skip Playwright, start with ScrapingBee)
  knownBlockedSites: [
    'variety.com', 'hollywoodreporter.com', 'deadline.com', 'thewrap.com',
    'theatermania.com', 'observer.com', 'chicagotribune.com',
    'dailybeast.com', 'thedailybeast.com', 'amny.com', 'newsday.com',
    'nypost.com', 'nydailynews.com', 'wsj.com', 'indiewire.com',
  ],

  // Sites that need residential proxies (Bright Data preferred)
  brightDataPreferred: [
    'nytimes.com', 'vulture.com', 'nymag.com', 'washingtonpost.com',
    'wsj.com', 'newyorker.com',
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
  tier2Attempts: 0,
  tier2Success: 0,
  tier3Attempts: 0,
  tier3Success: 0,
  tier4Attempts: 0,
  tier4Success: 0,
  totalFailed: 0,
  scrapingBeeCreditsUsed: 0,
};

// State tracking
let state = {
  processed: [],
  failed: [],
  skipped: [],
  tierBreakdown: {
    playwright: [],
    scrapingbee: [],
    brightdata: [],
    archive: [],
  },
  startTime: new Date().toISOString(),
  lastProcessed: null,
};

// Browser and context (reused)
let browser = null;
let context = null;
let page = null;
const loggedInDomains = new Set();

// ============================================================================
// TIER 1: Playwright with Stealth Plugin
// ============================================================================

async function fetchWithPlaywright(url, review) {
  stats.tier1Attempts++;

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

    return false;
  } catch (e) {
    console.log(`    ✗ Login error: ${e.message}`);
    return false;
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
  // Bright Data Web Unlocker requires specific zone configuration
  // The MCP token (3686bf13-...) uses their SSE endpoint, not the proxy auth
  // To fix: Set up Web Unlocker zone in Bright Data dashboard and configure:
  //   BRIGHTDATA_CUSTOMER_ID = hl_xxxxx (from dashboard)
  //   BRIGHTDATA_API_KEY = zone password (not the MCP token)
  //   BRIGHTDATA_ZONE = web_unlocker (or your zone name)
  throw new Error('Bright Data not configured (requires Web Unlocker zone setup)');
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

  // Force specific tier if requested
  if (CLI.forceTier) {
    const tier = parseInt(CLI.forceTier);
    try {
      switch (tier) {
        case 1:
          const r1 = await fetchWithPlaywright(url, review);
          return { html: r1.html, text: r1.text, method: 'playwright', attempts: [{ tier: 1, method: 'playwright', success: true }] };
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

// Classify text quality based on rules:
// - full: >1500 chars AND mentions show title AND >300 words
// - partial: 500-1500 chars OR mentions show title but <300 words
// - excerpt: <500 chars
// - missing: no text
function classifyTextQuality(text, showId, wordCount) {
  if (!text || text.trim().length === 0) {
    return 'missing';
  }

  const charCount = text.length;
  // Extract title from showId (e.g., "hamilton-2015" -> "hamilton")
  const titleLower = showId ? showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase() : '';
  const textLower = text.toLowerCase();
  const hasShowTitle = titleLower && textLower.includes(titleLower);

  // Full: >1500 chars AND mentions show title AND >300 words
  if (charCount > 1500 && hasShowTitle && wordCount > 300) {
    return 'full';
  }

  // Partial: 500-1500 chars OR larger but missing criteria
  if (charCount >= 500 && charCount <= 1500) {
    return 'partial';
  }
  if (charCount > 1500 && (!hasShowTitle || wordCount <= 300)) {
    return 'partial';
  }

  // Excerpt: <500 chars
  if (charCount < 500) {
    return 'excerpt';
  }

  return 'partial';
}

// Map fetch method to standardized sourceMethod
function mapSourceMethod(method) {
  const map = {
    'playwright': 'playwright',
    'playwright-stealth': 'playwright',
    'scrapingbee': 'scrapingbee',
    'brightdata': 'brightdata',
    'archive.org': 'archive',
    'archive': 'archive',
    'webfetch': 'webfetch',
  };
  return map[method] || method;
}

function updateReviewJson(review, text, validation, archivePath, method, attempts, archiveData = {}) {
  const data = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));

  data.fullText = text;
  data.isFullReview = text.length > 1500;
  data.textStatus = validation.valid ? 'complete' : 'partial';
  data.textWordCount = validation.wordCount;
  data.archivePath = archivePath;
  data.textFetchedAt = new Date().toISOString();

  // New tracking fields
  data.fetchMethod = method;
  data.fetchAttempts = attempts;
  data.fetchTier = method === 'playwright' ? 1 : method === 'scrapingbee' ? 2 : method === 'brightdata' ? 3 : 4;

  // Text quality classification (new fields)
  data.textQuality = classifyTextQuality(text, review.showId || data.showId, validation.wordCount);
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

      // Pull latest changes first, then push
      try {
        execSync('git pull --rebase origin main', { stdio: 'pipe' });
      } catch (pullErr) {
        // If rebase fails, abort and try merge
        execSync('git rebase --abort', { stdio: 'pipe' }).catch(() => {});
        execSync('git pull --no-rebase origin main', { stdio: 'pipe' });
      }
      execSync('git push origin HEAD:main', { stdio: 'pipe' });

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

        // Apply priority filter
        if (CONFIG.priority === 'tier1' && !isTier1) continue;

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
          priority: isTier1 ? 1 : 2,
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
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

// ============================================================================
// PROCESS REVIEW
// ============================================================================

async function processReview(review) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`Processing: ${review.outlet} - ${review.critic}`);
  console.log(`URL: ${review.url}`);

  try {
    const result = await fetchReviewText(review);

    console.log(`  ✓ SUCCESS via ${result.method} (${result.text.length} chars)`);

    // Archive HTML
    const archivePath = result.html ? archiveHtml(result.html, review, result.method) : null;

    // Validate
    const validation = validateReviewText(result.text, review);
    console.log(`  Validation: ${validation.valid ? 'PASS' : 'ISSUES'} (${validation.wordCount} words)`);
    if (!validation.valid) {
      console.log(`  Issues: ${validation.issues.join(', ')}`);
    }

    // Update JSON
    updateReviewJson(review, result.text, validation, archivePath, result.method, result.attempts, result.archiveData || {});

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
      scrapingbee: state.tierBreakdown.scrapingbee.length,
      brightdata: state.tierBreakdown.brightdata.length,
      archive: state.tierBreakdown.archive.length,
    },
    statistics: {
      tier1Attempts: stats.tier1Attempts,
      tier1Success: stats.tier1Success,
      tier2Attempts: stats.tier2Attempts,
      tier2Success: stats.tier2Success,
      tier3Attempts: stats.tier3Attempts,
      tier3Success: stats.tier3Success,
      tier4Attempts: stats.tier4Attempts,
      tier4Success: stats.tier4Success,
      totalFailed: stats.totalFailed,
      scrapingBeeCreditsUsed: stats.scrapingBeeCreditsUsed,
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
  console.log(`║ ├─ Tier 2 (ScrapingBee): ${String(report.tierBreakdown.scrapingbee).padStart(31)} ║`);
  console.log(`║ ├─ Tier 3 (Bright Data): ${String(report.tierBreakdown.brightdata).padStart(31)} ║`);
  console.log(`║ └─ Tier 4 (Archive.org): ${String(report.tierBreakdown.archive).padStart(31)} ║`);
  console.log(`${'╠' + '═'.repeat(58) + '╣'}`);
  console.log(`║ API USAGE                                                ║`);
  console.log(`║ └─ ScrapingBee credits: ${String(stats.scrapingBeeCreditsUsed).padStart(32)} ║`);
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
  console.log(`  Stealth Plugin: ${stealthLoaded ? '✓ loaded' : '⚠ using fallback'}`);

  // Load previous state if resuming
  loadState();

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
