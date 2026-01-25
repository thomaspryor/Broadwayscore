/**
 * Discover Real Review URLs
 *
 * Searches outlet websites to find actual review URLs for shows.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Outlet search URL patterns
const OUTLET_SEARCH = {
  'nystagereview.com': show => `https://nystagereview.com/?s=${encodeURIComponent(show)}`,
  'timeout.com': show => `https://www.timeout.com/search?q=${encodeURIComponent(show + ' broadway review')}&type=Article`,
  'newyorktheatreguide.com': show => `https://www.newyorktheatreguide.com/search?q=${encodeURIComponent(show)}`,
  'theatrely.com': show => `https://www.theatrely.com/?s=${encodeURIComponent(show)}`,
  'broadwaynews.com': show => `https://www.broadwaynews.com/?s=${encodeURIComponent(show)}`,
  'hollywoodreporter.com': show => `https://www.hollywoodreporter.com/search/?q=${encodeURIComponent(show + ' broadway review')}`,
  'chicagotribune.com': show => `https://www.chicagotribune.com/search/?q=${encodeURIComponent(show + ' broadway review')}`,
  'ew.com': show => `https://ew.com/search/?q=${encodeURIComponent(show + ' broadway')}`,
};

const CONFIG = {
  reviewTextsDir: 'data/review-texts',
};

// Get show name from showId
function getShowName(showId) {
  return showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
}

// Find reviews needing URL verification
function findReviewsNeedingUrls() {
  const reviewsByShow = {};

  if (!fs.existsSync(CONFIG.reviewTextsDir)) return reviewsByShow;

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => fs.statSync(path.join(CONFIG.reviewTextsDir, f)).isDirectory());

  for (const showId of shows) {
    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has valid full text
        if (data.fullText && data.textWordCount >= 300) continue;

        // Skip if no URL or verified URL
        if (!data.url) continue;
        if (data.urlVerified) continue;

        // Get domain
        let domain;
        try {
          domain = new URL(data.url).hostname.replace('www.', '');
        } catch (e) {
          continue;
        }

        // Only process outlets we can search
        if (!OUTLET_SEARCH[domain]) continue;

        if (!reviewsByShow[showId]) {
          reviewsByShow[showId] = {
            showName: getShowName(showId),
            reviews: []
          };
        }

        reviewsByShow[showId].reviews.push({
          filePath,
          domain,
          currentUrl: data.url,
          outlet: data.outlet,
          critic: data.criticName,
          data,
        });
      } catch (e) {}
    }
  }

  return reviewsByShow;
}

// Search for reviews on an outlet site
async function searchOutlet(page, domain, showName) {
  const searchUrl = OUTLET_SEARCH[domain](showName);
  console.log(`    Searching: ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Extract review links
    const links = await page.evaluate((show) => {
      const results = [];
      const showWords = show.toLowerCase().split(' ').filter(w => w.length > 3);

      document.querySelectorAll('a').forEach(a => {
        const href = a.href;
        const text = (a.textContent || '').toLowerCase();

        // Must be article link and mention the show
        if (!href.includes('http')) return;
        if (href.includes('/search') || href.includes('/category')) return;

        const mentionsShow = showWords.some(word =>
          href.toLowerCase().includes(word) || text.includes(word)
        );

        if (mentionsShow && (
          href.includes('/review') ||
          href.includes('/theater/') ||
          href.includes('/theatre/') ||
          href.includes('/entertainment/') ||
          text.includes('review')
        )) {
          results.push({
            url: href,
            title: a.textContent.trim().substring(0, 100)
          });
        }
      });

      // Deduplicate
      const seen = new Set();
      return results.filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      }).slice(0, 5);
    }, showName);

    return links;
  } catch (e) {
    console.log(`    Search error: ${e.message}`);
    return [];
  }
}

// Verify a URL returns valid content
async function verifyUrl(page, url, showName) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    if (!response || response.status() >= 400) {
      return { valid: false, reason: `HTTP ${response ? response.status() : 'no response'}` };
    }

    await page.waitForTimeout(1000);

    // Check content
    const content = await page.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll('p'))
        .map(p => p.textContent)
        .join(' ');
      return paragraphs.substring(0, 5000);
    });

    const wordCount = content.split(/\s+/).length;
    const showWords = showName.toLowerCase().split(' ').filter(w => w.length > 3);
    const mentionsShow = showWords.some(word => content.toLowerCase().includes(word));

    if (wordCount < 300) {
      return { valid: false, reason: `Only ${wordCount} words` };
    }

    if (!mentionsShow) {
      return { valid: false, reason: 'Show not mentioned' };
    }

    return { valid: true, wordCount };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

async function main() {
  console.log('=== Discovering Real Review URLs ===\n');

  const reviewsByShow = findReviewsNeedingUrls();
  const showIds = Object.keys(reviewsByShow);

  console.log(`Found ${showIds.length} shows with reviews needing URL verification\n`);

  if (showIds.length === 0) {
    console.log('Nothing to process!');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let updated = 0;
  let failed = 0;

  // Process only first few shows for testing
  const testShows = showIds.slice(0, 5);

  for (const showId of testShows) {
    const { showName, reviews } = reviewsByShow[showId];
    console.log(`\n=== ${showName} (${showId}) ===`);

    // Group by domain
    const byDomain = {};
    for (const review of reviews) {
      if (!byDomain[review.domain]) byDomain[review.domain] = [];
      byDomain[review.domain].push(review);
    }

    for (const [domain, domainReviews] of Object.entries(byDomain)) {
      console.log(`\n  Searching ${domain}...`);

      const foundUrls = await searchOutlet(page, domain, showName);
      console.log(`    Found ${foundUrls.length} potential URLs`);

      for (const found of foundUrls) {
        console.log(`    - ${found.url}`);
        const verification = await verifyUrl(page, found.url, showName);

        if (verification.valid) {
          console.log(`      VALID: ${verification.wordCount} words`);

          // Update the first matching review
          if (domainReviews.length > 0) {
            const review = domainReviews.shift();
            review.data.url = found.url;
            review.data.urlVerified = true;
            review.data.urlUpdatedAt = new Date().toISOString();
            fs.writeFileSync(review.filePath, JSON.stringify(review.data, null, 2));
            console.log(`      Updated: ${review.filePath}`);
            updated++;
          }
        } else {
          console.log(`      Invalid: ${verification.reason}`);
        }
      }

      // Mark remaining as failed to find URL
      for (const review of domainReviews) {
        failed++;
      }
    }
  }

  await browser.close();

  console.log('\n=== Summary ===');
  console.log(`URLs updated: ${updated}`);
  console.log(`URLs not found: ${failed}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
