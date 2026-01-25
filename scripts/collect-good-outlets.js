/**
 * Collect Review Texts - Good Outlets Only
 *
 * Focuses on outlets that we know work well with stealth Playwright.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  reviewTextsDir: 'data/review-texts',
  archivesDir: 'data/archives/reviews',

  // Outlets that work well with stealth Playwright
  goodOutlets: [
    'newyorktheatreguide.com', 'timeout.com', 'nystagereview.com',
    'theatrely.com', 'broadwaynews.com', 'hollywoodreporter.com',
    'chicagotribune.com', 'nypost.com', 'theguardian.com', 'guardian.com',
    'cititour.com', 'amny.com', 'playbill.com', 'broadwayworld.com',
    'ew.com', 'mashable.com', 'slant.com', '4columns.org',
    'latimes.com', 'usatoday.com', 'forward.com'
  ],

  minWordCount: 300,
  minDelay: 2000,
  maxDelay: 4000,

  userAgents: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ],
};

let stats = { processed: 0, succeeded: 0, failed: 0 };

function randomDelay() {
  const delay = CONFIG.minDelay + Math.random() * (CONFIG.maxDelay - CONFIG.minDelay);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function getRandomUserAgent() {
  return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
}

async function humanScroll(page) {
  await page.evaluate(async () => {
    const scrollHeight = Math.min(document.body.scrollHeight, 5000);
    let pos = 0;
    while (pos < scrollHeight * 0.7) {
      pos += 300 + Math.random() * 200;
      window.scrollTo({ top: pos, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
    }
  });
}

function findGoodOutletReviews() {
  const reviews = [];

  if (!fs.existsSync(CONFIG.reviewTextsDir)) return reviews;

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => fs.statSync(path.join(CONFIG.reviewTextsDir, f)).isDirectory());

  for (const showId of shows) {
    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has text
        if (data.fullText && data.textWordCount >= CONFIG.minWordCount) continue;

        // Skip if no URL
        if (!data.url) continue;

        // Only process good outlets
        const isGoodOutlet = CONFIG.goodOutlets.some(outlet => data.url.includes(outlet));
        if (!isGoodOutlet) continue;

        reviews.push({
          filePath,
          showId,
          outletId: data.outletId,
          outlet: data.outlet,
          critic: data.criticName,
          url: data.url,
          data,
        });
      } catch (e) {}
    }
  }

  return reviews;
}

async function fetchWithPlaywright(browser, url) {
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'max-age=0',
    },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!response || response.status() >= 400) {
      throw new Error(`HTTP ${response ? response.status() : 'no response'}`);
    }

    await page.waitForTimeout(2000);
    await humanScroll(page);

    const html = await page.content();

    // Extract text
    const text = await page.evaluate(() => {
      const selectors = [
        'article .entry-content', 'article .post-content', 'article .article-body',
        '[data-testid="article-body"]', '.article-body', '.story-body',
        '.entry-content', '.post-content', '.review-content', '.article__body',
        '.article-content', '.rich-text', '[class*="ArticleBody"]',
        'main article', 'article', 'main',
      ];

      let bestText = '';
      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            const paragraphs = el.querySelectorAll('p');
            const pText = Array.from(paragraphs)
              .map(p => p.textContent.trim())
              .filter(t => t.length > 30)
              .join('\n\n');
            if (pText.length > bestText.length) bestText = pText;
          }
        } catch (e) {}
      }

      if (bestText.length < 1000) {
        const allP = Array.from(document.querySelectorAll('p'))
          .filter(p => {
            const t = p.textContent.trim();
            return t.length > 50 && !t.toLowerCase().includes('cookie') && !t.toLowerCase().includes('subscribe');
          })
          .map(p => p.textContent.trim())
          .join('\n\n');
        if (allP.length > bestText.length) bestText = allP;
      }

      return bestText.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
    });

    await context.close();
    return { html, text };
  } catch (e) {
    await context.close();
    throw e;
  }
}

function saveArchive(review, html) {
  const archiveDir = path.join(CONFIG.archivesDir, review.showId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${review.outletId}--${(review.critic || 'unknown').toLowerCase().replace(/\s+/g, '-')}_${date}.html`;
  const archivePath = path.join(archiveDir, filename);

  const header = `<!--
  URL: ${review.url}
  Fetched: ${new Date().toISOString()}
  Show: ${review.showId}
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  return archivePath;
}

function updateReviewJson(review, text, archivePath) {
  const wordCount = text.split(/\s+/).length;

  const updatedData = {
    ...review.data,
    fullText: text,
    textWordCount: wordCount,
    textStatus: 'complete',
    textFetchedAt: new Date().toISOString(),
    textFetchMethod: 'playwright-stealth',
    archivePath: archivePath,
  };

  fs.writeFileSync(review.filePath, JSON.stringify(updatedData, null, 2));
}

async function processReview(browser, review) {
  console.log(`\n[${stats.processed + 1}] ${review.outlet} - ${review.critic || 'unknown'}`);
  console.log(`    ${review.url}`);

  try {
    const result = await fetchWithPlaywright(browser, review.url);
    const wordCount = result.text.split(/\s+/).length;

    if (wordCount < CONFIG.minWordCount) {
      console.log(`    FAIL: Only ${wordCount} words`);
      return false;
    }

    const archivePath = saveArchive(review, result.html);
    updateReviewJson(review, result.text, archivePath);
    console.log(`    SUCCESS: ${wordCount} words`);
    return true;
  } catch (e) {
    console.log(`    FAIL: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('=== Collecting Reviews from Good Outlets ===\n');

  const reviews = findGoodOutletReviews();
  console.log(`Found ${reviews.length} reviews from good outlets needing text\n`);

  if (reviews.length === 0) {
    console.log('Nothing to process!');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  try {
    for (const review of reviews) {
      stats.processed++;

      const success = await processReview(browser, review);
      if (success) {
        stats.succeeded++;
      } else {
        stats.failed++;
      }

      if (stats.processed < reviews.length) {
        await randomDelay();
      }

      if (stats.processed % 20 === 0) {
        console.log(`\n--- Progress: ${stats.processed}/${reviews.length} | Success: ${stats.succeeded} | Failed: ${stats.failed} ---\n`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== Complete ===');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Succeeded: ${stats.succeeded}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Success rate: ${((stats.succeeded / stats.processed) * 100).toFixed(1)}%`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
