#!/usr/bin/env node
/**
 * Paywall Browser Extract — Extract Article Text Using Persistent Profile
 *
 * Uses the persistent browser profile created by paywall-browser-login.js
 * to access paywalled articles and extract their text.
 *
 * Usage:
 *   # Extract a single article (prints text to stdout)
 *   node scripts/paywall-browser-extract.js --site=nyt --url=URL
 *
 *   # Extract and save as a seed file for a specific show
 *   node scripts/paywall-browser-extract.js --site=nyt --url=URL --show=rent-1996 --critic="Ben Brantley"
 *
 *   # Batch extract from a file of URLs (one per line)
 *   node scripts/paywall-browser-extract.js --site=nyt --urls-file=/tmp/nyt-urls.txt --show=rent-1996
 *
 *   # Test mode — just check if the page loads behind the paywall
 *   node scripts/paywall-browser-extract.js --site=nyt --url=URL --test
 *
 * Prerequisites:
 *   Run paywall-browser-login.js first to create the persistent profile.
 *
 * Output:
 *   Without --show: prints extracted text to stdout
 *   With --show: saves seed file to data/review-texts/{show-id}/{outlet}--{critic}.json
 */

const fs = require('fs');
const path = require('path');

const SITES = {
  nyt: {
    name: 'New York Times',
    outletId: 'nytimes',
    outlet: 'New York Times',
    profileDir: '/tmp/nyt-browser-profile',
    // Multiple selectors tried in order — first non-empty wins
    selectors: [
      'section[name="articleBody"]',
      'article[id="story"]',
      'article .meteredContent',
      'article',
      'div.StoryBodyCompanionColumn',
    ],
    // Elements to remove before extracting text (ads, related articles, etc.)
    removeSelectors: [
      'div[data-testid="photoviewer-wrapper"]',
      'figcaption',
      'div[role="complementary"]',
      'div[data-testid="related-links-block"]',
      'aside',
      'header', // byline/date already captured separately
    ],
    extractMeta: async (page) => {
      return page.evaluate(() => {
        const headline = document.querySelector('h1')?.textContent?.trim() || '';
        const byline = document.querySelector('span[data-testid="byline-prefix"]')?.parentElement?.textContent?.trim()
          || document.querySelector('.byline-name, .last-byline')?.textContent?.trim()
          || document.querySelector('meta[name="byl"]')?.content || '';
        const dateEl = document.querySelector('time[datetime]');
        const date = dateEl?.getAttribute('datetime')?.split('T')[0] || '';
        return { headline, byline, date };
      });
    },
  },
  wsj: {
    name: 'Wall Street Journal',
    outletId: 'wsj',
    outlet: 'Wall Street Journal',
    profileDir: '/tmp/wsj-browser-profile',
    selectors: [
      'div.article-content',
      'article section',
      'article',
      'div.wsj-snippet-body',
    ],
    removeSelectors: [
      'div.media-object-inline',
      'figure',
      'aside',
      'div[class*="newsletter"]',
      'div[class*="related"]',
    ],
    extractMeta: async (page) => {
      return page.evaluate(() => {
        const headline = document.querySelector('h1')?.textContent?.trim() || '';
        const byline = document.querySelector('.byline, .author-container')?.textContent?.trim() || '';
        const dateEl = document.querySelector('time[datetime]');
        const date = dateEl?.getAttribute('datetime')?.split('T')[0] || '';
        return { headline, byline, date };
      });
    },
  },
  bloomberg: {
    name: 'Bloomberg',
    outletId: 'bloomberg',
    outlet: 'Bloomberg',
    profileDir: '/tmp/bloomberg-browser-profile',
    selectors: [
      'div.body-content',
      'article .body-copy',
      'article',
      'div[class*="Article"]',
    ],
    removeSelectors: [
      'figure',
      'aside',
      'div[class*="newsletter"]',
      'div[class*="related"]',
      'div[class*="recirc"]',
    ],
    extractMeta: async (page) => {
      return page.evaluate(() => {
        const headline = document.querySelector('h1')?.textContent?.trim() || '';
        const byline = document.querySelector('.author-name, [class*="author"]')?.textContent?.trim() || '';
        const dateEl = document.querySelector('time[datetime]');
        const date = dateEl?.getAttribute('datetime')?.split('T')[0] || '';
        return { headline, byline, date };
      });
    },
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    site: args.find(a => a.startsWith('--site='))?.split('=')[1],
    url: args.find(a => a.startsWith('--url='))?.split('=')[1],
    urlsFile: args.find(a => a.startsWith('--urls-file='))?.split('=')[1],
    show: args.find(a => a.startsWith('--show='))?.split('=')[1],
    critic: args.find(a => a.startsWith('--critic='))?.split('=')[1],
    test: args.includes('--test'),
  };
}

/**
 * Extract article text from a page using site-specific selectors.
 */
async function extractArticleText(page, siteConfig) {
  // Remove noise elements first
  await page.evaluate((removeSelectors) => {
    for (const sel of removeSelectors) {
      document.querySelectorAll(sel).forEach(el => el.remove());
    }
  }, siteConfig.removeSelectors);

  // Try each selector in order
  for (const selector of siteConfig.selectors) {
    const text = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return '';
      return el.innerText?.trim() || '';
    }, selector);

    if (text && text.length > 200) {
      return { text, selector };
    }
  }

  // Fallback: try extracting from <p> tags within main content area
  const fallbackText = await page.evaluate(() => {
    const paragraphs = Array.from(document.querySelectorAll('article p, main p, [role="main"] p'));
    return paragraphs.map(p => p.textContent?.trim()).filter(t => t && t.length > 20).join('\n\n');
  });

  if (fallbackText && fallbackText.length > 200) {
    return { text: fallbackText, selector: 'fallback (p tags)' };
  }

  return { text: '', selector: 'none matched' };
}

/**
 * Generate a seed filename from critic name and outlet.
 */
function makeSeedFilename(outletId, criticName, publishDate) {
  const critic = criticName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  const year = publishDate ? publishDate.split('-')[0] : new Date().getFullYear().toString();
  return `${outletId}--${critic}-${year}-bway.json`;
}

/**
 * Save extracted text as a review seed file.
 */
function saveSeedFile(showId, outletId, outlet, criticName, url, publishDate, title, fullText) {
  const dir = path.join('data', 'review-texts', showId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filename = makeSeedFilename(outletId, criticName, publishDate);
  const filepath = path.join(dir, filename);

  // Don't overwrite existing files
  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (existing.fullText && existing.fullText.length > 100) {
      console.log(`  ⚠ File already exists with text: ${filepath}`);
      return filepath;
    }
  }

  const seed = {
    showId,
    outletId,
    outlet,
    criticName,
    url,
    publishDate: publishDate || null,
    fullText,
    isFullReview: true,
    source: 'persistent-browser',
    productionNote: `Extracted via persistent browser profile from ${outlet}.`,
    title: title || null,
    fetchMethod: 'paywall-browser-extract',
    textFetchedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filepath, JSON.stringify(seed, null, 2) + '\n');
  console.log(`  ✓ Saved: ${filepath}`);
  return filepath;
}

async function processUrl(page, siteConfig, url, opts) {
  console.log(`\nFetching: ${url}`);

  try {
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.error(`  ✗ Navigation failed: ${e.message}`);
    return null;
  }

  // Wait for content to load (some sites render client-side)
  await page.waitForTimeout(5000);

  // Check for paywall/login walls
  const isBlocked = await page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() || '';
    return text.includes('subscribe to continue') ||
           text.includes('create a free account') ||
           text.includes('sign in to read') ||
           text.includes('to continue reading') ||
           (text.includes('subscribe') && text.length < 500);
  });

  if (isBlocked) {
    console.error(`  ✗ Paywall detected — session may have expired. Re-run paywall-browser-login.js`);
    return null;
  }

  // Extract metadata
  const meta = await siteConfig.extractMeta(page);
  console.log(`  Title: ${meta.headline || '(not found)'}`);
  console.log(`  Byline: ${meta.byline || '(not found)'}`);
  console.log(`  Date: ${meta.date || '(not found)'}`);

  if (opts.test) {
    console.log(`  ✓ Page loaded successfully (test mode — not extracting)`);
    return { meta };
  }

  // Extract article text
  const { text, selector } = await extractArticleText(page, siteConfig);
  console.log(`  Selector: ${selector}`);
  console.log(`  Text length: ${text.length} chars`);

  if (text.length < 200) {
    console.error(`  ✗ Extracted text too short (${text.length} chars) — may be paywalled or wrong selector`);
    // Print what we got for debugging
    if (text.length > 0) {
      console.log(`  Preview: ${text.slice(0, 300)}...`);
    }
    return null;
  }

  // Print preview
  console.log(`  Preview: ${text.slice(0, 200).replace(/\n/g, ' ')}...`);

  // Save seed file if show ID provided
  if (opts.show) {
    const criticName = opts.critic || meta.byline?.replace(/^by\s+/i, '').trim() || 'unknown';
    saveSeedFile(
      opts.show,
      siteConfig.outletId,
      siteConfig.outlet,
      criticName,
      url,
      meta.date,
      meta.headline,
      text
    );
  } else {
    // Just print the full text
    console.log(`\n${'='.repeat(50)}`);
    console.log('EXTRACTED TEXT:');
    console.log('='.repeat(50));
    console.log(text);
  }

  return { meta, text };
}

async function main() {
  const opts = parseArgs();

  if (!opts.site || !SITES[opts.site]) {
    console.error('Usage: node scripts/paywall-browser-extract.js --site=SITE --url=URL [--show=SHOW_ID] [--critic=NAME] [--test]');
    console.error('');
    console.error('Sites: ' + Object.keys(SITES).join(', '));
    console.error('');
    console.error('Examples:');
    console.error('  # Print article text');
    console.error('  node scripts/paywall-browser-extract.js --site=nyt --url=https://www.nytimes.com/...');
    console.error('');
    console.error('  # Save as seed file');
    console.error('  node scripts/paywall-browser-extract.js --site=nyt --url=URL --show=rent-1996 --critic="Ben Brantley"');
    console.error('');
    console.error('  # Batch from file');
    console.error('  node scripts/paywall-browser-extract.js --site=nyt --urls-file=/tmp/urls.txt --show=rent-1996');
    process.exit(1);
  }

  if (!opts.url && !opts.urlsFile) {
    console.error('Error: provide --url=URL or --urls-file=FILE');
    process.exit(1);
  }

  const siteConfig = SITES[opts.site];

  // Check profile exists
  if (!fs.existsSync(siteConfig.profileDir)) {
    console.error(`Error: No browser profile found at ${siteConfig.profileDir}`);
    console.error(`Run first: node scripts/paywall-browser-login.js --site=${opts.site}`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Paywall Browser Extract: ${siteConfig.name}`);
  console.log(`Profile: ${siteConfig.profileDir}`);
  console.log(`${'='.repeat(50)}`);

  const { chromium } = require('playwright');

  console.log('\nLaunching browser (headed — required for persistent profile)...');
  const context = await chromium.launchPersistentContext(siteConfig.profileDir, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = context.pages()[0] || await context.newPage();

  // Collect URLs to process
  let urls = [];
  if (opts.url) {
    urls = [opts.url];
  } else if (opts.urlsFile) {
    const content = fs.readFileSync(opts.urlsFile, 'utf8');
    urls = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    console.log(`\nLoaded ${urls.length} URLs from ${opts.urlsFile}`);
  }

  // Process each URL
  let success = 0;
  let failed = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (urls.length > 1) {
      console.log(`\n--- [${i + 1}/${urls.length}] ---`);
    }

    const result = await processUrl(page, siteConfig, url, opts);
    if (result) {
      success++;
    } else {
      failed++;
    }

    // Small delay between requests to avoid rate limiting
    if (i < urls.length - 1) {
      await page.waitForTimeout(2000);
    }
  }

  // Summary
  if (urls.length > 1) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${success} extracted, ${failed} failed out of ${urls.length} URLs`);
  }

  await context.close();
  console.log('\nDone. Browser closed.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
