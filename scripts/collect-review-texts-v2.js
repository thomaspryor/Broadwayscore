/**
 * Collect Review Texts v2
 *
 * Enhanced version with:
 * - Stealth mode (human-like behavior)
 * - ScrapingBee fallback
 * - Archive.org fallback
 * - Better failure tracking
 * - Random delays (2-5s)
 * - Page scrolling
 * - Realistic user agents
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  batchSize: parseInt(process.env.BATCH_SIZE || '20'),
  maxReviews: parseInt(process.env.MAX_REVIEWS || '0'), // 0 = all
  commitEvery: 20,

  // Directories
  reviewTextsDir: 'data/review-texts',
  archivesDir: 'data/archives/reviews',
  failedFetchesFile: 'data/review-texts/failed-fetches.json',

  // Human-like delays (ms)
  minDelay: 2000,
  maxDelay: 5000,

  // Minimum word count for valid review
  minWordCount: 300,

  // User agents (rotate between these)
  userAgents: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ],

  // ScrapingBee API key (from env)
  scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '',
};

// Tracking
let stats = {
  processed: 0,
  succeeded: 0,
  failed: 0,
  startTime: new Date().toISOString(),
};

let failedFetches = [];

// Load existing failed fetches
function loadFailedFetches() {
  if (fs.existsSync(CONFIG.failedFetchesFile)) {
    try {
      failedFetches = JSON.parse(fs.readFileSync(CONFIG.failedFetchesFile, 'utf8'));
    } catch (e) {
      failedFetches = [];
    }
  }
}

// Save failed fetches
function saveFailedFetches() {
  fs.mkdirSync(path.dirname(CONFIG.failedFetchesFile), { recursive: true });
  fs.writeFileSync(CONFIG.failedFetchesFile, JSON.stringify(failedFetches, null, 2));
}

// Random delay between min and max
function randomDelay() {
  const delay = CONFIG.minDelay + Math.random() * (CONFIG.maxDelay - CONFIG.minDelay);
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Get random user agent
function getRandomUserAgent() {
  return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
}

// Human-like scrolling
async function humanScroll(page) {
  await page.evaluate(async () => {
    const scrollHeight = document.body.scrollHeight;
    const viewportHeight = window.innerHeight;
    let currentPosition = 0;

    while (currentPosition < scrollHeight * 0.7) {
      const scrollAmount = viewportHeight * (0.3 + Math.random() * 0.4);
      currentPosition += scrollAmount;
      window.scrollTo({ top: currentPosition, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    }

    // Scroll back up a bit (human behavior)
    window.scrollTo({ top: currentPosition * 0.3, behavior: 'smooth' });
  });
}

// Find reviews needing text
function findReviewsNeedingText() {
  const reviews = [];

  if (!fs.existsSync(CONFIG.reviewTextsDir)) {
    console.log('No review-texts directory found');
    return reviews;
  }

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => {
      const p = path.join(CONFIG.reviewTextsDir, f);
      return fs.statSync(p).isDirectory();
    });

  for (const showId of shows) {
    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has sufficient full text
        if (data.fullText && data.textWordCount && data.textWordCount >= CONFIG.minWordCount) {
          continue;
        }

        // Skip if no URL
        if (!data.url) continue;

        // Check if already in failed fetches (skip if failed 3+ times)
        const failedEntry = failedFetches.find(f => f.filePath === filePath);
        if (failedEntry && failedEntry.attempts >= 3) {
          continue;
        }

        reviews.push({
          filePath,
          showId,
          outletId: data.outletId,
          outlet: data.outlet,
          critic: data.criticName,
          url: data.url,
          data,
        });
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }

  console.log(`Found ${reviews.length} reviews needing text`);

  if (CONFIG.maxReviews > 0) {
    return reviews.slice(0, CONFIG.maxReviews);
  }
  return reviews;
}

// Method 1: Playwright with stealth-like behavior
async function fetchWithPlaywright(browser, url, review) {
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
  });

  const page = await context.newPage();

  // Stealth: Override webdriver detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!response || response.status() >= 400) {
      throw new Error(`HTTP ${response ? response.status() : 'no response'}`);
    }

    // Wait for content to load
    await page.waitForTimeout(2000);

    // Human-like scrolling
    await humanScroll(page);

    // Get HTML for archive
    const html = await page.content();

    // Extract text
    const text = await extractArticleText(page);

    await context.close();

    return { html, text, method: 'playwright' };
  } catch (e) {
    await context.close();
    throw e;
  }
}

// Method 2: ScrapingBee fallback
async function fetchWithScrapingBee(url) {
  if (!CONFIG.scrapingBeeKey) {
    throw new Error('No ScrapingBee API key configured');
  }

  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${CONFIG.scrapingBeeKey}&url=${encodeURIComponent(url)}&render_js=true&premium_proxy=true`;

  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`ScrapingBee error: ${response.status}`);
  }

  const html = await response.text();

  // Extract text from HTML
  const text = extractTextFromHtml(html);

  return { html, text, method: 'scrapingbee' };
}

// Method 3: Archive.org fallback
async function fetchFromArchive(browser, url) {
  const archiveUrl = `https://web.archive.org/web/2024/${url}`;

  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
  });
  const page = await context.newPage();

  try {
    const response = await page.goto(archiveUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!response || response.status() >= 400) {
      throw new Error(`Archive.org returned ${response ? response.status() : 'no response'}`);
    }

    await page.waitForTimeout(2000);

    const html = await page.content();
    const text = await extractArticleText(page);

    await context.close();

    return { html, text, method: 'archive.org' };
  } catch (e) {
    await context.close();
    throw e;
  }
}

// Extract article text from page (Playwright)
async function extractArticleText(page) {
  return await page.evaluate(() => {
    // Common article selectors
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
      'main article',
      'article',
      'main',
    ];

    let bestText = '';

    // Try each selector
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          // Get paragraphs within element
          const paragraphs = el.querySelectorAll('p');
          const pText = Array.from(paragraphs)
            .map(p => p.textContent.trim())
            .filter(t => t.length > 30)
            .join('\n\n');

          if (pText.length > bestText.length) {
            bestText = pText;
          }
        }
      } catch (e) {}
    }

    // Fallback: find all substantial paragraphs
    if (bestText.length < 1000) {
      const allP = Array.from(document.querySelectorAll('p'))
        .filter(p => {
          const text = p.textContent.trim();
          return text.length > 50 &&
                 !text.toLowerCase().includes('cookie') &&
                 !text.toLowerCase().includes('subscribe') &&
                 !text.toLowerCase().includes('sign up');
        })
        .map(p => p.textContent.trim())
        .join('\n\n');

      if (allP.length > bestText.length) {
        bestText = allP;
      }
    }

    // Clean up
    return bestText
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();
  });
}

// Extract text from HTML string (for ScrapingBee)
function extractTextFromHtml(html) {
  // Simple extraction - remove tags and get text
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

// Validate extracted text
function validateText(text, review) {
  const wordCount = text.split(/\s+/).length;

  if (wordCount < CONFIG.minWordCount) {
    return { valid: false, reason: `Only ${wordCount} words (need ${CONFIG.minWordCount})` };
  }

  // Check if show is mentioned
  const showWords = review.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').toLowerCase();
  const textLower = text.toLowerCase();
  const showMentioned = showWords.split(' ').some(word =>
    word.length > 3 && textLower.includes(word)
  );

  if (!showMentioned) {
    return { valid: false, reason: 'Show title not found in text' };
  }

  return { valid: true, wordCount };
}

// Save archive HTML
function saveArchive(review, html, method) {
  const archiveDir = path.join(CONFIG.archivesDir, review.showId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${review.outletId}--${(review.critic || 'unknown').toLowerCase().replace(/\s+/g, '-')}_${date}.html`;
  const archivePath = path.join(archiveDir, filename);

  // Add metadata header
  const header = `<!--
  URL: ${review.url}
  Fetched: ${new Date().toISOString()}
  Method: ${method}
  Show: ${review.showId}
  Outlet: ${review.outlet}
  Critic: ${review.critic || 'unknown'}
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  return archivePath;
}

// Classify text quality based on rules:
// - full: >1500 chars AND mentions show title AND >300 words
// - partial: 500-1500 chars OR mentions show title but <300 words
// - excerpt: <500 chars
// - missing: no text
function classifyTextQuality(text, showTitle, wordCount) {
  if (!text || text.trim().length === 0) {
    return 'missing';
  }

  const charCount = text.length;
  const titleLower = showTitle ? showTitle.toLowerCase() : '';
  const textLower = text.toLowerCase();
  const hasShowTitle = titleLower && textLower.includes(titleLower);

  // Full: >1500 chars AND mentions show title AND >300 words
  if (charCount > 1500 && hasShowTitle && wordCount > 300) {
    return 'full';
  }

  // Partial: 500-1500 chars OR mentions show title but <300 words
  if (charCount >= 500 && charCount <= 1500) {
    return 'partial';
  }
  if (hasShowTitle && wordCount < 300 && charCount >= 500) {
    return 'partial';
  }
  if (charCount > 500 && charCount < 1500) {
    return 'partial';
  }
  // Also partial if we have good chars but didn't meet full criteria
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
    'archive.org': 'archive',
    'archive': 'archive',
    'webfetch': 'webfetch',
  };
  return map[method] || method;
}

// Update review JSON with text
function updateReviewJson(review, text, archivePath, method) {
  const wordCount = text.split(/\s+/).length;
  const showTitle = review.data.showId ? review.data.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ') : '';
  const textQuality = classifyTextQuality(text, showTitle, wordCount);
  const sourceMethod = mapSourceMethod(method);

  const updatedData = {
    ...review.data,
    fullText: text,
    textWordCount: wordCount,
    textStatus: 'complete',
    textFetchedAt: new Date().toISOString(),
    textFetchMethod: method,
    archivePath: archivePath,
    textQuality: textQuality,
    sourceMethod: sourceMethod,
  };

  fs.writeFileSync(review.filePath, JSON.stringify(updatedData, null, 2));
}

// Record failed fetch
function recordFailure(review, errors) {
  const existing = failedFetches.find(f => f.filePath === review.filePath);

  if (existing) {
    existing.attempts++;
    existing.lastAttempt = new Date().toISOString();
    existing.errors = errors;
  } else {
    failedFetches.push({
      filePath: review.filePath,
      url: review.url,
      showId: review.showId,
      outlet: review.outlet,
      critic: review.critic,
      attempts: 1,
      firstAttempt: new Date().toISOString(),
      lastAttempt: new Date().toISOString(),
      errors: errors,
    });
  }
}

// Process a single review
async function processReview(browser, review) {
  console.log(`\nProcessing: ${review.outlet} - ${review.critic || 'unknown'}`);
  console.log(`  URL: ${review.url}`);

  const errors = [];

  // Method 1: Playwright with stealth
  try {
    console.log('  Trying: Playwright (stealth mode)...');
    const result = await fetchWithPlaywright(browser, review.url, review);

    const validation = validateText(result.text, review);
    if (validation.valid) {
      const archivePath = saveArchive(review, result.html, result.method);
      updateReviewJson(review, result.text, archivePath, result.method);
      console.log(`  SUCCESS: ${validation.wordCount} words via ${result.method}`);
      return { success: true, method: result.method };
    } else {
      errors.push({ method: 'playwright', error: validation.reason });
      console.log(`  Playwright failed validation: ${validation.reason}`);
    }
  } catch (e) {
    errors.push({ method: 'playwright', error: e.message });
    console.log(`  Playwright error: ${e.message}`);
  }

  // Method 2: ScrapingBee (if configured)
  if (CONFIG.scrapingBeeKey) {
    try {
      console.log('  Trying: ScrapingBee...');
      await randomDelay();
      const result = await fetchWithScrapingBee(review.url);

      const validation = validateText(result.text, review);
      if (validation.valid) {
        const archivePath = saveArchive(review, result.html, result.method);
        updateReviewJson(review, result.text, archivePath, result.method);
        console.log(`  SUCCESS: ${validation.wordCount} words via ${result.method}`);
        return { success: true, method: result.method };
      } else {
        errors.push({ method: 'scrapingbee', error: validation.reason });
        console.log(`  ScrapingBee failed validation: ${validation.reason}`);
      }
    } catch (e) {
      errors.push({ method: 'scrapingbee', error: e.message });
      console.log(`  ScrapingBee error: ${e.message}`);
    }
  }

  // Method 3: Archive.org
  try {
    console.log('  Trying: Archive.org...');
    await randomDelay();
    const result = await fetchFromArchive(browser, review.url);

    const validation = validateText(result.text, review);
    if (validation.valid) {
      const archivePath = saveArchive(review, result.html, result.method);
      updateReviewJson(review, result.text, archivePath, result.method);
      console.log(`  SUCCESS: ${validation.wordCount} words via ${result.method}`);
      return { success: true, method: result.method };
    } else {
      errors.push({ method: 'archive.org', error: validation.reason });
      console.log(`  Archive.org failed validation: ${validation.reason}`);
    }
  } catch (e) {
    errors.push({ method: 'archive.org', error: e.message });
    console.log(`  Archive.org error: ${e.message}`);
  }

  // All methods failed
  console.log(`  FAILED: All methods exhausted`);
  recordFailure(review, errors);
  return { success: false, errors };
}

// Main
async function main() {
  console.log('=== Review Text Collection v2 ===');
  console.log(`Config: batch=${CONFIG.batchSize}, max=${CONFIG.maxReviews || 'all'}`);
  console.log(`ScrapingBee: ${CONFIG.scrapingBeeKey ? 'configured' : 'not configured'}`);

  loadFailedFetches();

  const reviews = findReviewsNeedingText();
  if (reviews.length === 0) {
    console.log('No reviews need text collection');
    return;
  }

  console.log(`Processing ${reviews.length} reviews...`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  try {
    for (let i = 0; i < reviews.length; i++) {
      const review = reviews[i];
      stats.processed++;

      const result = await processReview(browser, review);
      if (result.success) {
        stats.succeeded++;
      } else {
        stats.failed++;
      }

      // Random delay between requests
      if (i < reviews.length - 1) {
        await randomDelay();
      }

      // Save failed fetches periodically
      if ((i + 1) % 10 === 0) {
        saveFailedFetches();
        console.log(`\n--- Progress: ${i + 1}/${reviews.length} (${stats.succeeded} succeeded, ${stats.failed} failed) ---`);
      }
    }
  } finally {
    await browser.close();
  }

  // Final save
  saveFailedFetches();

  // Summary
  console.log('\n=== Collection Complete ===');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Succeeded: ${stats.succeeded}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Success rate: ${((stats.succeeded / stats.processed) * 100).toFixed(1)}%`);
  console.log(`Failed fetches logged to: ${CONFIG.failedFetchesFile}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
