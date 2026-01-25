/**
 * Collect Review Texts
 *
 * Fetches full review texts using Playwright, archives raw HTML,
 * extracts article content, validates, and updates review JSON files.
 *
 * Environment variables (from GitHub Secrets):
 *   NYT_EMAIL, NYT_PASSWORD - New York Times credentials (secrets: NYT_EMAIL, NYTIMES_PASSWORD)
 *   VULTURE_EMAIL, VULTURE_PASSWORD - Vulture/NY Mag credentials
 *   WAPO_EMAIL, WAPO_PASSWORD - Washington Post credentials (secrets: WAPO_EMAIL, WASHPOST_PASSWORD)
 *   BATCH_SIZE - Reviews per batch (default: 10)
 *   MAX_REVIEWS - Max reviews to process (default: 50, 0 = all)
 *   PRIORITY - 'tier1' or 'all' (default: tier1)
 *   SHOW_FILTER - Only process specific show ID
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  batchSize: parseInt(process.env.BATCH_SIZE || '10'),
  maxReviews: parseInt(process.env.MAX_REVIEWS || '50'),
  priority: process.env.PRIORITY || 'tier1',
  showFilter: process.env.SHOW_FILTER || '',

  // Directories
  reviewTextsDir: 'data/review-texts',
  archivesDir: 'data/archives/reviews',
  stateDir: 'data/collection-state',
  auditDir: 'data/audit/validation',

  // Tier 1 outlets (highest priority)
  tier1Outlets: ['nytimes', 'nyt', 'vulture', 'vult', 'variety', 'hollywood-reporter', 'thr', 'newyorker'],

  // Sites known to be accessible without login (prioritize these)
  accessibleSites: [
    'theatermania.com', 'theatrely.com', 'frontmezzjunkies.com', 'nystagereview.com',
    'newyorktheatreguide.com', 'cititour.com', 'broadwayworld.com', 'playbill.com',
    'timeout.com', 'chicagotribune.com', 'deadline.com', 'observer.com',
  ],

  // Sites known to block/require login
  blockedSites: [
    'nytimes.com', 'vulture.com', 'nymag.com', 'variety.com', 'hollywoodreporter.com',
    'washingtonpost.com', 'nypost.com', 'nydailynews.com', 'newyorker.com',
  ],

  // Paywalled domains and their credential env vars
  paywalledDomains: {
    'nytimes.com': { emailVar: 'NYT_EMAIL', passVar: 'NYT_PASSWORD' },
    'vulture.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'nymag.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'newyorker.com': { emailVar: 'VULTURE_EMAIL', passVar: 'VULTURE_PASSWORD' },
    'washingtonpost.com': { emailVar: 'WAPO_EMAIL', passVar: 'WAPO_PASSWORD' },
  },

  // Minimum word count for valid review
  minWordCount: 300,

  // Request delay to avoid rate limiting (ms)
  requestDelay: 2000,
};

// State tracking
let state = {
  processed: [],
  failed: [],
  skipped: [],
  startTime: new Date().toISOString(),
  lastProcessed: null,
};

// Load existing state if resuming
function loadState() {
  const statePath = path.join(CONFIG.stateDir, 'progress.json');
  if (fs.existsSync(statePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      // Only resume if started within last 24 hours
      const startTime = new Date(saved.startTime);
      const hoursSinceStart = (Date.now() - startTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceStart < 24) {
        console.log(`Resuming from previous run (${saved.processed.length} already processed)`);
        state = saved;
        return true;
      }
    } catch (e) {
      console.log('Could not load previous state, starting fresh');
    }
  }
  return false;
}

// Save state for resumability
function saveState() {
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG.stateDir, 'progress.json'),
    JSON.stringify(state, null, 2)
  );
}

// Find reviews that need full text
function findReviewsToProcess() {
  const reviews = [];
  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => fs.statSync(path.join(CONFIG.reviewTextsDir, f)).isDirectory());

  for (const showId of shows) {
    // Apply show filter if specified
    if (CONFIG.showFilter && showId !== CONFIG.showFilter) continue;

    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const reviewId = `${showId}/${file}`;

      // Skip already processed in this run
      if (state.processed.includes(reviewId) || state.failed.includes(reviewId)) {
        continue;
      }

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has full text
        const textLen = data.fullText ? data.fullText.length : 0;
        if (data.isFullReview === true || textLen > 1500) {
          continue;
        }

        // Skip if no URL
        if (!data.url) {
          continue;
        }

        // Determine priority
        const outletId = (data.outletId || '').toLowerCase();
        const isTier1 = CONFIG.tier1Outlets.some(t => outletId.includes(t));

        // Apply priority filter
        if (CONFIG.priority === 'tier1' && !isTier1) {
          continue;
        }

        // Check if site is accessible or blocked
        const urlLower = data.url.toLowerCase();
        const isAccessible = CONFIG.accessibleSites.some(s => urlLower.includes(s));
        const isBlocked = CONFIG.blockedSites.some(s => urlLower.includes(s));

        // Skip blocked sites unless we have credentials
        if (isBlocked) {
          const creds = getPaywallCredentials(data.url);
          if (!creds || !creds.email) {
            continue; // Skip - no credentials for this blocked site
          }
        }

        // Priority: 1 = accessible tier1, 2 = accessible, 3 = blocked with creds
        let priority = 3;
        if (isAccessible && isTier1) priority = 1;
        else if (isAccessible) priority = 2;

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
          isAccessible,
          priority,
        });
      } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
      }
    }
  }

  // Sort by priority (Tier 1 first)
  reviews.sort((a, b) => a.priority - b.priority);

  // Apply max limit
  if (CONFIG.maxReviews > 0) {
    return reviews.slice(0, CONFIG.maxReviews);
  }

  return reviews;
}

// Check if URL is paywalled
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

// Login to paywalled site
async function loginToSite(page, domain, email, password) {
  console.log(`  Logging in to ${domain}...`);

  try {
    if (domain === 'nytimes.com') {
      await page.goto('https://myaccount.nytimes.com/auth/login');
      await page.waitForLoadState('networkidle');
      await page.fill('input[name="email"]', email);
      await page.click('button[data-testid="submit-email"]');
      await page.waitForTimeout(1000);
      await page.fill('input[name="password"]', password);
      await page.click('button[data-testid="login-button"]');
      await page.waitForLoadState('networkidle');
      console.log('  Logged in to NYT');
      return true;
    }

    if (domain === 'vulture.com' || domain === 'nymag.com' || domain === 'newyorker.com') {
      // These share Conde Nast login
      await page.goto('https://www.vulture.com/login');
      await page.waitForLoadState('networkidle');
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');
      console.log('  Logged in to Vulture/Conde Nast');
      return true;
    }

    if (domain === 'washingtonpost.com') {
      await page.goto('https://www.washingtonpost.com/subscribe/signin/');
      await page.waitForLoadState('networkidle');
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');
      console.log('  Logged in to Washington Post');
      return true;
    }
  } catch (e) {
    console.log(`  Login failed for ${domain}: ${e.message}`);
    return false;
  }

  return false;
}

// Extract article text from page
async function extractArticleText(page) {
  return await page.evaluate(() => {
    // Try to find paragraphs with substantial text content (likely article content)
    const findArticleParagraphs = () => {
      const allParagraphs = Array.from(document.querySelectorAll('p'));
      // Filter to paragraphs with meaningful content (>50 chars)
      const contentParagraphs = allParagraphs.filter(p => {
        const text = p.textContent.trim();
        return text.length > 50 && !text.includes('cookie') && !text.includes('subscribe');
      });
      return contentParagraphs;
    };

    // Common article selectors - try in order
    const selectors = [
      'article .entry-content',
      'article .post-content',
      'article .article-body',
      'article .content',
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
      '[class*="review-body"]',
      '[class*="story-body"]',
      'main article',
      '.story-content',
      'article',
      'main',
    ];

    let articleElement = null;
    let bestText = '';

    // Try each selector
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const text = el.textContent.trim();
          if (text.length > bestText.length) {
            articleElement = el;
            bestText = text;
          }
        }
      } catch (e) {}
    }

    // Also try finding substantial paragraphs
    const paragraphs = findArticleParagraphs();
    if (paragraphs.length > 3) {
      const pText = paragraphs.map(p => p.textContent.trim()).join('\n\n');
      if (pText.length > bestText.length) {
        bestText = pText;
      }
    }

    // If still no good text, try the body with cleanup
    if (bestText.length < 500) {
      articleElement = document.body;
      const clone = articleElement.cloneNode(true);

      // Remove unwanted elements
      const removeSelectors = [
        'script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript',
        '.ad', '.advertisement', '.social-share', '.related-articles',
        '.newsletter-signup', '.comments', '[data-ad]', '.sidebar',
        '.nav', '.menu', '.breadcrumb', '.tags', '.author-bio',
        '[class*="nav"]', '[class*="menu"]', '[class*="sidebar"]',
        '[class*="footer"]', '[class*="header"]', '[class*="cookie"]',
        '[class*="newsletter"]', '[class*="subscribe"]', '[class*="social"]',
      ];

      for (const selector of removeSelectors) {
        try {
          clone.querySelectorAll(selector).forEach(el => el.remove());
        } catch (e) {}
      }

      bestText = clone.textContent || '';
    }

    // Clean up whitespace
    let text = bestText.replace(/\s+/g, ' ').trim();

    // Remove common boilerplate phrases
    const boilerplate = [
      /Subscribe to our newsletter[^.]*\./gi,
      /Sign up for[^.]*\./gi,
      /Advertisement/gi,
      /Cookie Policy/gi,
      /Privacy Policy/gi,
      /Terms of Service/gi,
      /All rights reserved/gi,
      /Share this article/gi,
      /Read more:/gi,
    ];

    for (const pattern of boilerplate) {
      text = text.replace(pattern, '');
    }

    return text.trim();
  });
}

// Validate extracted text
function validateReviewText(text, review) {
  const issues = [];

  // Check word count
  const wordCount = text.split(/\s+/).length;
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
    issues.push(`Show title not found in text`);
  }

  return {
    valid: issues.length === 0,
    wordCount,
    issues,
  };
}

// Archive raw HTML
async function archiveHtml(page, review) {
  const html = await page.content();
  const date = new Date().toISOString().split('T')[0];
  const criticSlug = (review.critic || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const outletSlug = (review.outletId || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');

  const archiveDir = path.join(CONFIG.archivesDir, review.showId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, `${outletSlug}--${criticSlug}_${date}.html`);

  // Add metadata header
  const header = `<!--
  Archive Metadata
  URL: ${review.url}
  Outlet: ${review.outlet}
  Critic: ${review.critic}
  Show: ${review.showId}
  Archived: ${new Date().toISOString()}
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  return archivePath;
}

// Update review JSON with extracted text
function updateReviewJson(review, text, validation, archivePath) {
  const data = JSON.parse(fs.readFileSync(review.filePath, 'utf8'));

  data.fullText = text;
  data.isFullReview = text.length > 1500;
  data.textStatus = validation.valid ? 'complete' : 'partial';
  data.textWordCount = validation.wordCount;
  data.archivePath = archivePath;
  data.textFetchedAt = new Date().toISOString();

  if (validation.issues.length > 0) {
    data.textIssues = validation.issues;
  } else {
    delete data.textIssues;
    delete data.textIssue;
  }

  fs.writeFileSync(review.filePath, JSON.stringify(data, null, 2));
}

// Process a single review
async function processReview(page, review, loggedInDomains) {
  console.log(`\nProcessing: ${review.outlet} - ${review.critic}`);
  console.log(`  URL: ${review.url}`);

  try {
    // Check if we need to login
    const paywallCreds = getPaywallCredentials(review.url);
    if (paywallCreds && paywallCreds.email && !loggedInDomains.has(paywallCreds.domain)) {
      const loginSuccess = await loginToSite(page, paywallCreds.domain, paywallCreds.email, paywallCreds.password);
      if (loginSuccess) {
        loggedInDomains.add(paywallCreds.domain);
      }
    }

    // Navigate to review URL
    await page.goto(review.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Wait for JavaScript content to render
    // Try multiple strategies
    try {
      // Wait for common article selectors
      await Promise.race([
        page.waitForSelector('article', { timeout: 10000 }),
        page.waitForSelector('[class*="article"]', { timeout: 10000 }),
        page.waitForSelector('[class*="review"]', { timeout: 10000 }),
        page.waitForSelector('[class*="content"]', { timeout: 10000 }),
        page.waitForSelector('main p', { timeout: 10000 }),
        page.waitForTimeout(8000), // Fallback: just wait
      ]);
    } catch (e) {
      // Continue anyway - content might still be there
    }

    // Additional wait for JS rendering
    await page.waitForTimeout(2000);

    // Check for CAPTCHA or blocking
    const pageContent = await page.content();
    if (pageContent.includes('captcha') || pageContent.includes('DataDome') ||
        pageContent.includes('Access Denied') || pageContent.includes('blocked')) {
      console.log('  BLOCKED: CAPTCHA or access denied detected');
      return { success: false, error: 'CAPTCHA or access blocked' };
    }

    // Archive raw HTML
    const archivePath = await archiveHtml(page, review);
    console.log(`  Archived: ${archivePath}`);

    // Extract article text
    const text = await extractArticleText(page);
    console.log(`  Extracted: ${text.length} chars`);

    // Validate
    const validation = validateReviewText(text, review);
    if (validation.valid) {
      console.log(`  Validation: PASS (${validation.wordCount} words)`);
    } else {
      console.log(`  Validation: ISSUES - ${validation.issues.join(', ')}`);
    }

    // Update JSON
    updateReviewJson(review, text, validation, archivePath);
    console.log(`  Updated: ${review.filePath}`);

    return { success: true, validation };

  } catch (error) {
    console.log(`  ERROR: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Generate collection report
function generateReport() {
  const report = {
    runDate: new Date().toISOString(),
    config: {
      batchSize: CONFIG.batchSize,
      maxReviews: CONFIG.maxReviews,
      priority: CONFIG.priority,
      showFilter: CONFIG.showFilter,
    },
    summary: {
      processed: state.processed.length,
      failed: state.failed.length,
      skipped: state.skipped.length,
    },
    processed: state.processed,
    failed: state.failed,
  };

  const date = new Date().toISOString().split('T')[0];
  const reportPath = path.join(CONFIG.auditDir, `collection-report-${date}.json`);
  fs.mkdirSync(CONFIG.auditDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n=== Collection Report ===`);
  console.log(`Processed: ${report.summary.processed}`);
  console.log(`Failed: ${report.summary.failed}`);
  console.log(`Report saved: ${reportPath}`);

  return report;
}

// Main execution
async function main() {
  console.log('=== Review Text Collection ===');
  console.log(`Config: batch=${CONFIG.batchSize}, max=${CONFIG.maxReviews}, priority=${CONFIG.priority}`);

  // Load previous state if resuming
  loadState();

  // Find reviews to process
  const reviews = findReviewsToProcess();
  console.log(`Found ${reviews.length} reviews to process`);

  if (reviews.length === 0) {
    console.log('No reviews to process. Exiting.');
    return;
  }

  // Launch browser with stealth settings
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Avoid bot detection
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Add stealth scripts to avoid detection
  await context.addInitScript(() => {
    // Override webdriver property
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Override plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const page = await context.newPage();
  const loggedInDomains = new Set();

  try {
    let batchCount = 0;

    for (let i = 0; i < reviews.length; i++) {
      const review = reviews[i];

      // Process review
      const result = await processReview(page, review, loggedInDomains);

      if (result.success) {
        state.processed.push(review.reviewId);
      } else {
        state.failed.push(review.reviewId);
      }

      state.lastProcessed = review.reviewId;
      batchCount++;

      // Save state after each batch
      if (batchCount >= CONFIG.batchSize) {
        saveState();
        console.log(`\n--- Batch complete, state saved (${state.processed.length} processed) ---`);
        batchCount = 0;
      }

      // Delay between requests
      if (i < reviews.length - 1) {
        await page.waitForTimeout(CONFIG.requestDelay);
      }
    }

    // Final state save
    saveState();

  } finally {
    await browser.close();
  }

  // Generate report
  generateReport();
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
