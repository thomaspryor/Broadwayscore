#!/usr/bin/env node
/**
 * Gather Reviews Script
 *
 * Automated review gathering for Broadway shows.
 * This script powers the gather-reviews.yml GitHub Action.
 *
 * Process:
 * 1. Search aggregators (DTLI, Show Score) for reviews
 *    - Show Score: Uses Playwright to scroll through carousel and extract ALL critic reviews
 *    - URL patterns try -broadway suffix first to avoid redirects to off-broadway shows
 * 2. Search individual outlets via Claude API web search
 * 3. Create review-text files for each found review
 * 4. Rebuild reviews.json
 *
 * Show Score Technical Notes:
 * - Show Score paginates critic reviews in a carousel (only 8 visible initially)
 * - Playwright scrolls through the carousel to load all reviews
 * - URLs like /broadway-shows/redwood can redirect to /off-off-broadway-shows/redwood
 * - We detect these redirects and try -broadway suffix patterns first
 *
 * Usage:
 *   node scripts/gather-reviews.js --shows=show-id-1,show-id-2
 *   node scripts/gather-reviews.js --shows=all-out-2025
 *
 * Environment Variables:
 *   ANTHROPIC_API_KEY - Required for Claude API web search
 *   BRIGHTDATA_TOKEN - Optional for scraping
 *   SCRAPINGBEE_API_KEY - Optional for scraping fallback
 *
 * Dependencies:
 *   - playwright (optional but recommended for full Show Score extraction)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  normalizeOutlet,
  normalizeCritic,
  normalizePublishDate,
  generateReviewFilename,
  generateReviewKey,
  getOutletDisplayName,
  mergeReviews,
  validateCriticOutlet,
} = require('./lib/review-normalization');
const { verifyProduction, quickDateCheck } = require('./lib/production-verifier');
const { cleanText } = require('./lib/text-cleaning');
const { classifyContentTier } = require('./lib/content-quality');
const { LETTER_GRADES } = require('./lib/score-extractors');
let chromium, playwright;
try {
  playwright = require('playwright');
  chromium = playwright.chromium;
} catch (e) {
  // Playwright not available - will fall back to HTTP scraping
}

// Paths
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTLETS_PATH = path.join(__dirname, 'config', 'critic-outlets.json');

// Rate limiting
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load show data
 */
function loadShowData(showId) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  return shows.find(s => s.id === showId);
}

/**
 * Load outlet configuration
 */
function loadOutlets() {
  const config = JSON.parse(fs.readFileSync(OUTLETS_PATH, 'utf8'));
  return [
    ...config.tier1.map(o => ({ ...o, tier: 1 })),
    ...config.tier2.map(o => ({ ...o, tier: 2 })),
    ...config.tier3.map(o => ({ ...o, tier: 3 }))
  ];
}

/**
 * Search for reviews using Claude API with web search
 */
async function searchForReview(showTitle, year, outlet) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('    ⚠️  ANTHROPIC_API_KEY not set, skipping web search');
    return null;
  }

  const searchQuery = `"${showTitle}" Broadway review ${year} site:${outlet.domain}`;

  const prompt = `Search for: ${searchQuery}

I need you to search the web and find if there's a review of "${showTitle}" (Broadway, ${year}) on ${outlet.name} (${outlet.domain}).

If you find a review, extract:
1. The exact URL of the review
2. The critic's name
3. Any explicit rating (stars, letter grade, etc.) if present
4. A brief excerpt or pull quote from the review (1-2 sentences)
5. The publish date (in format like "January 25, 2026")

If you CANNOT find a review after searching, respond with: {"found": false}

If you FIND a review, respond with JSON only:
{
  "found": true,
  "url": "full URL",
  "critic": "Critic Name",
  "originalRating": "4/5 stars" or null,
  "excerpt": "Brief quote from the review",
  "publishDate": "Month Day, Year"
}

Important: Only report a review if you actually find one via web search. Do not guess or make up URLs.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data.content[0].text;

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return result.found ? result : null;
    }
    return null;
  } catch (error) {
    console.log(`    ⚠️  Search error: ${error.message}`);
    return null;
  }
}

/**
 * Search aggregator for show reviews using simple HTTP
 */
async function searchAggregator(aggregatorName, searchUrl, maxRedirects = 3) {
  return new Promise((resolve) => {
    // Validate URL before making request
    try {
      new URL(searchUrl);
    } catch (e) {
      resolve({ found: false, error: `Invalid URL: ${searchUrl}` });
      return;
    }

    const req = https.get(searchUrl, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: searchUrl }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Check if redirect goes to homepage (not what we want)
        let redirectUrl = res.headers.location;

        // Handle relative redirects by making them absolute
        if (redirectUrl.startsWith('/')) {
          try {
            const originalUrl = new URL(searchUrl);
            redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`;
          } catch (e) {
            resolve({ found: false, error: `Invalid redirect: ${redirectUrl}` });
            return;
          }
        }

        if (redirectUrl.includes('/shows/all') || redirectUrl.endsWith('/shows') || redirectUrl === '/') {
          // Redirected to homepage - this URL doesn't exist
          resolve({ found: false, redirectedToHomepage: true });
        } else if (maxRedirects > 0) {
          // Follow redirect
          searchAggregator(aggregatorName, redirectUrl, maxRedirects - 1).then(resolve);
        } else {
          resolve({ found: false, tooManyRedirects: true });
        }
      } else {
        resolve({ found: false, status: res.statusCode });
      }
    });
    req.on('error', (err) => resolve({ found: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, error: 'timeout' });
    });
  });
}

/**
 * Fetch additional Show Score critic reviews via their pagination API.
 * Show Score only renders 8 critic reviews in the initial page load.
 * The remaining reviews are fetched via AJAX at /shows/{slug}/paginate_critic_reviews?page=N.
 * Each page returns JSON: {"html": "<review tile HTML>"} with ~8 review tiles per page.
 */
async function fetchShowScorePaginatedReviews(showPageUrl, initialHtml, showId) {
  const additionalReviews = [];

  // Parse pagination attributes from the critic reviews scrollable block
  const nextPagePathMatch = initialHtml.match(/data-next-page-path="([^"]+)"/);
  const totalCountMatch = initialHtml.match(/js-show-page-v2__critic-reviews[^>]*data-total-count="(\d+)"/);

  if (!nextPagePathMatch) return additionalReviews;

  const nextPagePath = nextPagePathMatch[1]; // e.g., /shows/death-becomes-her-broadway/paginate_critic_reviews
  const totalCount = totalCountMatch ? parseInt(totalCountMatch[1]) : 0;

  if (totalCount <= 8) return additionalReviews; // No pagination needed

  console.log(`    Show Score pagination: ${totalCount} total reviews, fetching remaining pages...`);

  // Fetch additional pages (page 2, 3, etc.)
  const maxPages = Math.ceil(totalCount / 8) + 1; // Safety margin
  for (let page = 2; page <= maxPages; page++) {
    const paginationUrl = `https://www.show-score.com${nextPagePath}?page=${page}`;

    try {
      const result = await searchAggregator('ShowScorePagination', paginationUrl);
      if (!result.found || !result.html) break;

      // The response is JSON with {"html": "..."} containing review tile HTML
      let tileHtml = result.html;
      try {
        const parsed = JSON.parse(result.html);
        tileHtml = parsed.html || '';
      } catch (e) {
        // If not JSON, use as-is (unlikely but safe fallback)
      }

      if (!tileHtml || tileHtml.length < 10) break; // Empty page = no more reviews

      // Extract reviews from the tile HTML fragments
      // Pattern: outlet from img alt, critic from member link, URL from "Read more" link
      const tileRegex = /review-tile-v2 -critic[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/gi;
      const tiles = tileHtml.match(tileRegex) || [];

      // Simpler approach: extract each review's data from the flat HTML
      const outletRegex = /alt="([^"]+)"/g;
      const criticRegex = /href="\/member\/[^"]*">([^<]+)<\/a>/g;
      const urlRegex = /href="(https?:\/\/[^"]+)"[^>]*>Read more/gi;
      const dateRegex = /review-tile-v2__date[^>]*>\s*([^<]+)/g;
      const excerptRegex = /&quot;([^&]+)&quot;/g;

      const outlets = [];
      const critics = [];
      const urls = [];
      const dates = [];
      let m;

      while ((m = outletRegex.exec(tileHtml)) !== null) {
        // Filter out non-outlet images (avatars, pixel images, etc.)
        if (!m[1].includes('white-pixel') && !m[1].includes('user-avatar') && m[1].length > 2) {
          outlets.push(m[1]);
        }
      }
      while ((m = criticRegex.exec(tileHtml)) !== null) critics.push(m[1].trim());
      while ((m = urlRegex.exec(tileHtml)) !== null) urls.push(m[1]);
      while ((m = dateRegex.exec(tileHtml)) !== null) dates.push(m[1].trim());

      const pageReviewCount = Math.max(outlets.length, urls.length);
      for (let i = 0; i < pageReviewCount; i++) {
        const outletRaw = outlets[i] || 'Unknown';
        const outletId = normalizeOutlet(outletRaw);
        const outletName = getOutletDisplayName(outletId);
        const critic = critics[i] || 'Unknown';
        const url = urls[i] || null;
        const date = dates[i] || null;

        if (url && !additionalReviews.some(r => r.url === url)) {
          additionalReviews.push({
            showId,
            outlet: outletName,
            outletId,
            criticName: critic,
            url,
            publishDate: normalizePublishDate(date) || null,
            source: 'show-score',
          });
        }
      }

      if (pageReviewCount === 0) break; // No more reviews
      await sleep(300); // Rate limit
    } catch (e) {
      console.log(`    Pagination page ${page} error: ${e.message}`);
      break;
    }
  }

  if (additionalReviews.length > 0) {
    console.log(`    Fetched ${additionalReviews.length} additional reviews via pagination`);
  }

  return additionalReviews;
}

/**
 * Try to find show on Did They Like It
 * Revival shows often use -bway or -broadway suffixes
 */
async function searchDTLI(show) {
  const titleSlug = slugify(show.title);
  const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));
  const baseSlug = show.slug.replace(/-\d{4}$/, ''); // Remove year suffix

  // Base variations (without suffix)
  const baseVariations = [
    baseSlug,
    titleSlug,
    titleNoArticle,
    show.title.toLowerCase().replace(/:/g, '').replace(/[^a-z0-9]+/g, '-'),
    show.title.toLowerCase().replace(/-the-/g, '-').replace(/[^a-z0-9]+/g, '-'),
  ];

  // PRIORITY: Try -bway suffix FIRST for Broadway shows
  // This avoids hitting Off-Broadway or prior production pages
  const allVariations = [];

  // First, try all variations WITH -bway suffix (highest priority for Broadway)
  for (const base of baseVariations) {
    allVariations.push(base + '-bway');
  }

  // Then try -broadway suffix
  for (const base of baseVariations) {
    allVariations.push(base + '-broadway');
  }

  // Then try -revival suffix
  for (const base of baseVariations) {
    allVariations.push(base + '-revival');
  }

  // Finally, try without suffix (lowest priority - may hit wrong production)
  for (const base of baseVariations) {
    allVariations.push(base);
  }

  // Special cases for known patterns (revivals, common name conflicts)
  const specialCases = {
    'merrily-we-roll-along': ['merrily-we-roll-along-bway'],
    'appropriate': ['appropriate-bway'],
    'an-enemy-of-the-people': ['an-enemy-of-the-people-bway', 'enemy-of-the-people'],
    'the-outsiders': ['the-outsiders-bway', 'outsiders'],
    'the-notebook': ['the-notebook-bway', 'notebook'],
    'water-for-elephants': ['water-for-elephants-bway'],
    'mother-play': ['mother-play-bway'],
    'stereophonic': ['stereophonic-bway'],
    'suffs': ['suffs-bway'],
    'the-great-gatsby': ['the-great-gatsby-bway', 'great-gatsby'],
    'the-roommate': ['the-roommate-bway', 'roommate'],
    'cabaret': ['cabaret-bway', 'cabaret-revival'],
    'uncle-vanya': ['uncle-vanya-bway'],
    'prayer-for-the-french-republic': ['prayer-for-the-french-republic-bway'],
    'illinoise': ['illinoise-bway'],
    'the-wiz': ['the-wiz-bway', 'wiz'],
    'lempicka': ['lempicka-bway'],
    'the-who-s-tommy': ['the-whos-tommy-bway', 'whos-tommy'],
    'days-of-wine-and-roses': ['days-of-wine-and-roses-bway'],
    // Shows with subtitles - full title needed
    'doubt': ['doubt-a-parable', 'doubt-a-parable-bway'],
    'doubt-a-parable': ['doubt-a-parable'],
    'just-for-us': ['just-for-us-bway', 'just-for-us-a-very-important-show'],
    'harmony': ['harmony-bway', 'harmony-a-new-musical'],
    'purlie-victorious': ['purlie-victorious-bway', 'purlie-victorious-a-non-confederate-romp'],
    'gutenberg-the-musical': ['gutenberg-the-musical-bway'],
    'the-thanksgiving-play': ['the-thanksgiving-play-bway'],
    'titanique': ['titanique-bway'],
    'the-outsiders': ['the-outsiders-bway'],
  };

  // Check special cases for baseSlug
  if (specialCases[baseSlug]) {
    // Insert special cases at the BEGINNING (highest priority)
    allVariations.unshift(...specialCases[baseSlug]);
  }

  // Also check special cases for titleSlug (handles subtitles like "Doubt: A Parable")
  if (specialCases[titleSlug] && titleSlug !== baseSlug) {
    allVariations.unshift(...specialCases[titleSlug]);
  }

  console.log('  Searching Did They Like It...');

  // Remove duplicates and empty strings
  const uniqueVariations = [...new Set(allVariations)].filter(v => v && v.length > 0);

  for (const slug of uniqueVariations) {
    const url = `https://didtheylikeit.com/shows/${slug}/`;
    const result = await searchAggregator('DTLI', url);
    if (result.found && result.html && result.html.includes('<div class="review-item">')) {
      console.log(`    ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(300);
  }

  console.log('    ✗ Not found on DTLI');
  return null;
}

/**
 * Try to find show on Show Score using URL pattern matching
 * Show Score uses various URL patterns - we try multiple variations
 * Uses Playwright to scroll through the carousel and get ALL critic reviews
 */
async function searchShowScore(show) {
  console.log('  Searching Show Score...');
  const year = new Date(show.openingDate).getFullYear();
  const titleSlug = slugify(show.title);
  const titleNoColonSlug = slugify(show.title.replace(/:/g, ''));

  // For musicals, Show Score often appends "-the-musical-broadway"
  const isMusical = show.type === 'musical';

  // Try more specific patterns first (with -broadway suffix) to avoid
  // redirects to off-broadway shows with similar names
  const variations = [
    // Most specific: -broadway suffix patterns first
    `${titleSlug}-broadway`,
    `${titleNoColonSlug}-broadway`,
    `${show.slug}-broadway`,
    // For musicals, Show Score often uses "-the-musical-broadway"
    ...(isMusical ? [
      `${titleSlug}-the-musical-broadway`,
      `${titleNoColonSlug}-the-musical-broadway`,
      `${show.slug}-the-musical-broadway`,
    ] : []),
    // For plays, might use "-play-broadway"
    ...(!isMusical ? [
      `${titleSlug}-play-broadway`,
      `${titleNoColonSlug}-play-broadway`,
    ] : []),
    // Then try without suffix (less specific, may redirect to wrong shows)
    show.slug,
    titleSlug,
    titleNoColonSlug,
    // Some shows include the year
    `${titleSlug}-${year}`,
    `${titleNoColonSlug}-${year}`,
  ];

  // Try Playwright first if available (to get ALL reviews via carousel scrolling)
  if (chromium) {
    for (const slug of [...new Set(variations)]) {
      const url = `https://www.show-score.com/broadway-shows/${slug}`;
      const result = await scrapeShowScoreWithPlaywright(url);
      if (result) {
        console.log(`    ✓ Found at: ${url}`);
        return { url, html: result.html, reviews: result.reviews };
      }
      await sleep(300);
    }
  } else {
    // Fall back to HTTP scraping if Playwright not available
    for (const slug of [...new Set(variations)]) {
      const url = `https://www.show-score.com/broadway-shows/${slug}`;
      const result = await searchAggregator('ShowScore', url);

      // Check that we got actual show content, not the homepage or off-broadway shows
      if (result.found && result.html &&
          result.html.includes('score') &&
          !result.html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>') &&
          !result.html.includes('/off-broadway-shows/') &&
          !result.html.includes('/off-off-broadway-shows/')) {
        console.log(`    ✓ Found at: ${url}`);
        return { url, html: result.html };
      }
      await sleep(300);
    }
  }

  console.log('    ✗ Not found on Show Score');
  return null;
}

/**
 * Scrape Show Score page using Playwright with carousel navigation
 * This allows us to get ALL critic reviews, not just the first 8
 */
async function scrapeShowScoreWithPlaywright(url) {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Check if we got redirected to a different type of show (off-broadway, off-off-broadway)
    const finalUrl = page.url();
    if (finalUrl.includes('/off-broadway-shows/') || finalUrl.includes('/off-off-broadway-shows/')) {
      // We got redirected to a non-Broadway show - this is the wrong show
      await browser.close();
      return null;
    }

    // Check if we're on the right page (not homepage)
    const title = await page.title();
    if (title === 'Show Score | NYC Theatre Reviews and Tickets' || !title.includes('Show Score')) {
      await browser.close();
      return null;
    }

    // Wait for critic reviews section to load
    await page.waitForSelector('h2:has-text("Critic Reviews")', { timeout: 5000 }).catch(() => null);

    // Extract all critic reviews by scrolling through the carousel
    const reviews = await page.evaluate(() => {
      const reviews = [];

      // Find the critic reviews section
      let criticSection = null;
      document.querySelectorAll('h2').forEach(h2 => {
        if (h2.textContent.includes('Critic Reviews')) {
          criticSection = h2.nextElementSibling;
        }
      });

      if (!criticSection) return reviews;

      // Extract reviews from the visible carousel
      // Show Score renders reviews in cards with outlet logo, critic name, excerpt, and URL
      const reviewCards = criticSection.querySelectorAll('[class*="review"]');

      // Also try finding by structure - look for Read more links
      const readMoreLinks = criticSection.querySelectorAll('a[href*="http"]:not([href*="show-score.com"])');

      readMoreLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.includes('youtube.com') || href.includes('youtu.be') ||
            href.includes('spotify.com') || href.includes('facebook.com') ||
            href.includes('twitter.com') || href.includes('instagram.com')) {
          return;
        }

        // Find the parent review card to extract outlet and critic info
        // Must use .review-tile-v2 to reach the full card root (not just the excerpt div)
        const card = link.closest('.review-tile-v2') || link.closest('div[class]');
        if (!card) return;

        // Look for outlet image alt text (in the header section)
        const outletImg = card.querySelector('img[alt]');
        const outlet = outletImg?.getAttribute('alt') || '';

        // Look for critic name link (in the header section)
        const criticLink = card.querySelector('a[href*="/member/"]');
        const critic = criticLink?.textContent?.trim() || '';

        // Look for date
        let date = '';
        card.querySelectorAll('div').forEach(div => {
          const text = div.textContent;
          if (text && text.match(/\w+\s+\d+,?\s*\d{4}/) && text.length < 30) {
            date = text.trim();
          }
        });

        // Look for excerpt
        const paragraph = card.querySelector('p');
        const excerpt = paragraph?.textContent?.replace(/Read more.*$/, '').trim() || '';

        if (href && !reviews.some(r => r.url === href)) {
          reviews.push({
            url: href,
            outlet: outlet,
            critic: critic,
            date: date,
            excerpt: excerpt
          });
        }
      });

      return reviews;
    });

    // Extract expected review count from "Critic Reviews (N)" heading
    const expectedReviewCount = await page.evaluate(() => {
      let count = null;
      document.querySelectorAll('h2').forEach(h2 => {
        const match = h2.textContent.match(/Critic Reviews\s*\((\d+)\)/);
        if (match) {
          count = parseInt(match[1]);
        }
      });
      return count;
    });
    if (expectedReviewCount) {
      console.log(`    Show Score reports ${expectedReviewCount} critic reviews`);
    }

    // Scroll down to critic reviews section for better interaction
    await page.evaluate(() => {
      const h2s = document.querySelectorAll('h2');
      for (const h2 of h2s) {
        if (h2.textContent.includes('Critic Reviews')) {
          h2.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    });
    await sleep(1000);

    // Now try to scroll the carousel to get more reviews using MULTIPLE methods
    // Method 1: Click right arrows | Method 2: Keyboard navigation | Method 3: Direct scroll
    let previousCount = reviews.length;
    let noProgressRounds = 0;
    const maxNoProgressRounds = 8; // Stop after 8 rounds with no new reviews
    const maxTotalAttempts = 100; // Safety limit
    let totalAttempts = 0;

    console.log(`    Initial reviews found: ${reviews.length}`);

    while (noProgressRounds < maxNoProgressRounds && totalAttempts < maxTotalAttempts) {
      totalAttempts++;

      // Early exit if we've captured all expected reviews
      if (expectedReviewCount && reviews.length >= expectedReviewCount) {
        console.log(`    ✓ Captured all ${reviews.length} reviews (expected ${expectedReviewCount})`);
        break;
      }

      let navigated = false;

      // Method 1: Try to find and click the right arrow (multiple selectors)
      // Show Score uses .js-scrollable-block__next-page-btn for the critic carousel
      const arrowSelectors = [
        '.js-scrollable-block__next-page-btn',
        '.scrollable-block__next-page-btn',
        'div[class*="critic"] button[class*="right"]',
        'div[class*="critic"] [class*="angle-right"]',
        'h2:has-text("Critic Reviews") + div button:last-child',
        '[class*="carousel"] button:last-child',
        '[class*="slider"] button:last-child',
        'button[aria-label*="next" i]',
        'button[aria-label*="right" i]',
        '[class*="swiper-button-next"]'
      ];

      for (const selector of arrowSelectors) {
        const arrow = await page.$(selector);
        if (arrow) {
          try {
            await arrow.click();
            navigated = true;
            await sleep(600);
            break;
          } catch (e) {
            // Arrow found but click failed, try next selector
          }
        }
      }

      // Method 2: If arrow click failed, try keyboard navigation
      if (!navigated) {
        // Focus on the carousel area and use arrow keys
        await page.evaluate(() => {
          const h2s = document.querySelectorAll('h2');
          for (const h2 of h2s) {
            if (h2.textContent.includes('Critic Reviews')) {
              const carousel = h2.nextElementSibling;
              if (carousel) {
                carousel.focus();
                // Also try clicking on it to give it focus
                carousel.click();
              }
              break;
            }
          }
        });
        await page.keyboard.press('ArrowRight');
        navigated = true;
        await sleep(600);
      }

      // Method 3: Try scrolling the carousel container directly
      const scrolled = await page.evaluate(() => {
        let criticSection = null;
        document.querySelectorAll('h2').forEach(h2 => {
          if (h2.textContent.includes('Critic Reviews')) {
            criticSection = h2.nextElementSibling;
          }
        });
        if (criticSection) {
          // Find scrollable container
          const scrollable = criticSection.querySelector('[class*="carousel"], [class*="slider"], [style*="overflow"]') || criticSection;
          const beforeScroll = scrollable.scrollLeft;
          scrollable.scrollBy({ left: 350, behavior: 'smooth' });
          return scrollable.scrollLeft !== beforeScroll;
        }
        return false;
      });

      await sleep(400);

      // Extract reviews again after navigation
      const newReviews = await page.evaluate(() => {
        const reviews = [];
        let criticSection = null;
        document.querySelectorAll('h2').forEach(h2 => {
          if (h2.textContent.includes('Critic Reviews')) {
            criticSection = h2.nextElementSibling;
          }
        });

        if (!criticSection) return reviews;

        const readMoreLinks = criticSection.querySelectorAll('a[href*="http"]:not([href*="show-score.com"])');
        readMoreLinks.forEach(link => {
          const href = link.getAttribute('href');
          if (!href || href.includes('youtube.com') || href.includes('youtu.be') ||
              href.includes('spotify.com') || href.includes('facebook.com') ||
              href.includes('twitter.com') || href.includes('instagram.com')) {
            return;
          }

          // Must use .review-tile-v2 to reach the full card root (not just the excerpt div)
          const card = link.closest('.review-tile-v2') || link.closest('div[class]');
          if (!card) return;

          const outletImg = card.querySelector('img[alt]');
          const outlet = outletImg?.getAttribute('alt') || '';
          const criticLink = card.querySelector('a[href*="/member/"]');
          const critic = criticLink?.textContent?.trim() || '';

          // Also extract excerpt for better matching
          const paragraph = card.querySelector('p');
          const excerpt = paragraph?.textContent?.replace(/Read more.*$/, '').trim() || '';

          if (href && !reviews.some(r => r.url === href)) {
            reviews.push({ url: href, outlet, critic, excerpt });
          }
        });

        return reviews;
      });

      // Merge new reviews
      let newCount = 0;
      for (const review of newReviews) {
        if (!reviews.some(r => r.url === review.url)) {
          reviews.push(review);
          newCount++;
        }
      }

      // Track progress
      if (reviews.length === previousCount) {
        noProgressRounds++;
      } else {
        if (newCount > 0) {
          console.log(`    Scroll ${totalAttempts}: +${newCount} reviews (total: ${reviews.length})`);
        }
        noProgressRounds = 0; // Reset on progress
        previousCount = reviews.length;
      }
    }

    if (reviews.length < (expectedReviewCount || 0)) {
      console.log(`    ⚠ Only captured ${reviews.length}/${expectedReviewCount} reviews (stopped after ${totalAttempts} attempts)`);
    }

    // Get the full HTML for fallback extraction
    const html = await page.content();

    await browser.close();
    return { html, reviews };
  } catch (error) {
    console.log(`    Playwright error: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

/**
 * Extract reviews from Show Score HTML
 */
function extractShowScoreReviews(html, showId) {
  const reviews = [];

  // Extract critic reviews from review tiles
  // Show Score uses .review-tile-v2.-critic for critic reviews
  const reviewTileRegex = /<div[^>]*class="[^"]*review-tile-v2[^"]*-critic[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;

  // Simpler approach: Look for outlet names with URLs
  // Pattern: outlet image alt text, author name, date, excerpt, URL

  // Extract from JSON-LD if present (more reliable)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const script of jsonLdMatch) {
      try {
        const jsonContent = script.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(jsonContent);
        if (data.review && Array.isArray(data.review)) {
          for (const review of data.review) {
            if (review.author && review.url) {
              reviews.push({
                showId,
                outlet: review.publisher?.name || 'Unknown',
                outletId: slugify(review.publisher?.name || 'unknown'),
                criticName: review.author?.name || 'Unknown',
                url: review.url,
                excerpt: review.reviewBody || null,
                publishDate: normalizePublishDate(review.datePublished) || null,
                source: 'show-score'
              });
            }
          }
        }
      } catch (e) {
        // Skip invalid JSON-LD
      }
    }
  }

  // Also try to extract from HTML structure
  // Look for review URLs with outlet context
  const outletUrlPattern = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>.*?Read\s*(?:more|full\s*review)/gi;
  let match;
  while ((match = outletUrlPattern.exec(html)) !== null) {
    const url = match[1];

    // Skip non-review URLs (video platforms, social media, etc.)
    const skipDomains = [
      'youtube.com', 'youtu.be', 'vimeo.com',
      'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
      'spotify.com', 'apple.com', 'music.amazon.com',
      'show-score.com'  // Skip internal links
    ];
    if (skipDomains.some(domain => url.includes(domain))) {
      continue;
    }

    // Try to find outlet context nearby
    const contextStart = Math.max(0, match.index - 500);
    const context = html.substring(contextStart, match.index + match[0].length);

    // Common outlet patterns
    const outletPatterns = [
      { pattern: /New York Times|nytimes\.com/i, outlet: 'The New York Times', outletId: 'nytimes' },
      { pattern: /Vulture|vulture\.com/i, outlet: 'Vulture', outletId: 'vulture' },
      { pattern: /Variety|variety\.com/i, outlet: 'Variety', outletId: 'variety' },
      { pattern: /Hollywood Reporter|hollywoodreporter\.com/i, outlet: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
      { pattern: /Time Out|timeout\.com/i, outlet: 'Time Out New York', outletId: 'timeout' },
      { pattern: /New York Post|nypost\.com/i, outlet: 'New York Post', outletId: 'nypost' },
      { pattern: /TheaterMania|theatermania\.com/i, outlet: 'TheaterMania', outletId: 'theatermania' },
      { pattern: /Deadline|deadline\.com/i, outlet: 'Deadline', outletId: 'deadline' },
      { pattern: /New York Theater|newyorktheater\.me/i, outlet: 'New York Theater', outletId: 'nyt-theater' },
      { pattern: /Theatrely|theatrely\.com/i, outlet: 'Theatrely', outletId: 'theatrely' },
      { pattern: /Broadway World|broadwayworld\.com/i, outlet: 'BroadwayWorld', outletId: 'broadwayworld' },
      { pattern: /Stage and Cinema|stageandcinema\.com/i, outlet: 'Stage and Cinema', outletId: 'stageandcinema' },
      // Additional outlets found on Show Score
      { pattern: /New York Theatre Guide|newyorktheatreguide\.com/i, outlet: 'New York Theatre Guide', outletId: 'nytg' },
      { pattern: /Talkin'?\s*Broadway|talkinbroadway\.com/i, outlet: "Talkin' Broadway", outletId: 'talkinbroadway' },
      { pattern: /TheaterScene|theaterscene\.net/i, outlet: 'TheaterScene.net', outletId: 'theaterscene' },
      { pattern: /Entertainment Weekly|ew\.com/i, outlet: 'Entertainment Weekly', outletId: 'ew' },
      { pattern: /The Guardian|theguardian\.com/i, outlet: 'The Guardian', outletId: 'guardian' },
      { pattern: /Associated Press|apnews\.com/i, outlet: 'Associated Press', outletId: 'ap' },
      { pattern: /New Yorker|newyorker\.com/i, outlet: 'The New Yorker', outletId: 'newyorker' },
      { pattern: /The Wrap|thewrap\.com/i, outlet: 'The Wrap', outletId: 'thewrap' },
      { pattern: /The Stage|thestage\.co\.uk/i, outlet: 'The Stage', outletId: 'thestage' },
      { pattern: /CurtainUp|curtainup\.com/i, outlet: 'CurtainUp', outletId: 'curtainup' },
      { pattern: /AM New York|amnewyork\.com/i, outlet: 'AM New York', outletId: 'amny' },
    ];

    let matched = false;
    for (const { pattern, outlet, outletId } of outletPatterns) {
      if (pattern.test(context) || pattern.test(url)) {
        // Check if we already have this review (by URL, not just outlet — same outlet may have multiple critics)
        if (!reviews.some(r => r.url === url)) {
          // Try to extract critic name from context
          // Show Score has links like: <a href="/member/jonathan-mandell">Jonathan Mandell</a>
          let criticName = 'Unknown';
          const criticLinkMatch = context.match(/href="\/member\/[^"]+">([^<]+)<\/a>/i);
          if (criticLinkMatch) {
            criticName = criticLinkMatch[1].trim();
          }

          reviews.push({
            showId,
            outlet,
            outletId,
            criticName,
            url,
            source: 'show-score'
          });
        }
        matched = true;
        break;
      }
    }

    // Fallback: extract review even if outlet not in predefined list
    if (!matched && !reviews.some(r => r.url === url)) {
      // Try to get outlet name from image alt text in context
      const imgAltMatch = context.match(/img[^>]*alt="([^"]+)"/i);
      let outlet = 'Unknown';
      let outletId = 'unknown';

      if (imgAltMatch && imgAltMatch[1]) {
        outlet = imgAltMatch[1].trim();
        outletId = slugify(outlet);
      } else {
        // Try to infer from URL domain
        const domainMatch = url.match(/https?:\/\/(?:www\.)?([^\/]+)/);
        if (domainMatch) {
          const domain = domainMatch[1].replace(/\.(com|org|net|co\.uk)$/i, '');
          outlet = domain.charAt(0).toUpperCase() + domain.slice(1);
          outletId = slugify(domain);
        }
      }

      // Try to extract critic name
      let criticName = 'Unknown';
      const criticLinkMatch = context.match(/href="\/member\/[^"]+">([^<]+)<\/a>/i);
      if (criticLinkMatch) {
        criticName = criticLinkMatch[1].trim();
      }

      reviews.push({
        showId,
        outlet,
        outletId,
        criticName,
        url,
        source: 'show-score'
      });
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} reviews from Show Score`);
  }

  return reviews;
}

/**
 * Extract reviews from DTLI HTML with individual thumb data
 */
function extractDTLIReviews(html, showId, dtliUrl) {
  const reviews = [];

  // Extract summary thumb counts from the numbered hand images
  // Format: thumbs-up/thumb-N.png, thumbs-meh/thumb-N.png, thumbs-down/thumb-N.png
  const thumbUpMatch = html.match(/thumbs-up\/thumb-(\d+)\.png/);
  const thumbMehMatch = html.match(/thumbs-meh\/thumb-(\d+)\.png/);
  const thumbDownMatch = html.match(/thumbs-down\/thumb-(\d+)\.png/);

  const summary = {
    up: thumbUpMatch ? parseInt(thumbUpMatch[1]) : 0,
    meh: thumbMehMatch ? parseInt(thumbMehMatch[1]) : 0,
    down: thumbDownMatch ? parseInt(thumbDownMatch[1]) : 0,
  };
  console.log(`    Found ${summary.up} UP, ${summary.meh} MEH, ${summary.down} DOWN`);

  // Extract individual reviews from <div class="review-item"> blocks
  // Pattern matches each review item block
  const reviewItemRegex = /<div class="review-item">([\s\S]*?)(?=<div class="review-item">|<\/section>|<div class="" id="modal-breakdown")/gi;

  let match;
  while ((match = reviewItemRegex.exec(html)) !== null) {
    const reviewHtml = match[1];

    // Extract outlet from img alt text (class="review-item-attribution")
    // DTLI uses two HTML formats: old-style uses img.review-item-attribution with alt text,
    // new-style (2024+) uses div.review_image with outlet name as text content
    const outletMatch = reviewHtml.match(/class="review-item-attribution"[^>]*alt="([^"]+)"/i) ||
                        reviewHtml.match(/alt="([^"]+)"[^>]*class="review-item-attribution"/i) ||
                        reviewHtml.match(/class="review_image"><div>([^<]+)<\/div>/i);

    // Extract thumb from BigThumbs image (BigThumbs_UP, BigThumbs_MEH, BigThumbs_DOWN)
    const thumbMatch = reviewHtml.match(/BigThumbs_(UP|MEH|DOWN)/i);

    // Extract critic name — prefer ?s= query param (always has full name)
    const criticSearchMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*><a[^>]*href="[^"]*\?s=([^&"]+)/i);
    // Fallback: capture all text content including across <br> tags
    const criticTextMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*>(?:<a[^>]*>)?([\s\S]*?)<\/(?:a|h2)>/i);

    // Extract date
    const dateMatch = reviewHtml.match(/class="review-item-date"[^>]*>([^<]+)/i);

    // Extract excerpt from paragraph
    const excerptMatch = reviewHtml.match(/<p class="paragraph">([^]*?)<\/p>/i);

    // Extract review URL from button link
    const urlMatch = reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*button-pink[^"]*review-item-button/i) ||
                     reviewHtml.match(/class="[^"]*button-pink[^"]*review-item-button[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i) ||
                     reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*>READ THE REVIEW/i);

    if (outletMatch && urlMatch) {
      const outletName = outletMatch[1].trim();
      const outletId = slugify(outletName);
      const thumb = thumbMatch ? thumbMatch[1].toUpperCase() : null;
      let criticName = 'Unknown';
      if (criticSearchMatch) {
        criticName = decodeURIComponent(criticSearchMatch[1]).trim();
      } else if (criticTextMatch) {
        criticName = criticTextMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      }
      criticName = criticName.replace(/\s+/g, ' ').trim();
      const date = dateMatch ? dateMatch[1].trim() : null;
      let excerpt = excerptMatch ? excerptMatch[1].trim() : null;

      // Clean up excerpt HTML entities
      if (excerpt) {
        excerpt = excerpt
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#8217;/g, "'")
          .replace(/&#8220;/g, '"')
          .replace(/&#8221;/g, '"')
          .replace(/&#8212;/g, '—')
          .replace(/\s+/g, ' ')
          .trim();
      }

      reviews.push({
        showId,
        outletId,
        outlet: outletName,
        criticName,
        url: urlMatch[1],
        publishDate: normalizePublishDate(date),
        dtliExcerpt: excerpt,
        dtliThumb: thumb,
        source: 'dtli',
        dtliUrl,
      });
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} individual reviews with thumb data`);
  } else {
    console.log(`    Warning: Could not extract individual reviews (HTML structure may have changed)`);
  }

  return reviews;
}

/**
 * Search BroadwayWorld for Review Roundup article
 */
async function searchBWWRoundup(show, year) {
  console.log('  Searching BroadwayWorld Review Roundups...');

  // Generate title variations for URL
  const titleVariations = [
    show.title.toUpperCase().replace(/[^A-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/'/g, '').replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
  ];

  const searchUrls = [];
  for (const title of titleVariations) {
    // BWW URLs have inconsistent capitalization — try common variants
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-Updating-LIVE-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-On-Broadway-Updating-Live-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-On-Broadway-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-${year}`);
  }

  // Try Playwright first — BWW loads review content via JavaScript on many pages
  if (chromium) {
    for (const url of searchUrls) {
      const result = await scrapeBWWRoundupWithPlaywright(url);
      if (result) {
        console.log(`    ✓ Found at: ${url} (Playwright)`);
        return { url, html: result.html };
      }
      await sleep(300);
    }
  }

  // Fall back to HTTP fetch (works for older BWW pages with static content)
  for (const url of searchUrls) {
    const result = await searchAggregator('BWW', url);
    if (result.found && result.html && result.html.includes('Review Roundup')) {
      console.log(`    ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(200);
  }

  // Final fallback: Google search for the BWW roundup page
  const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
  if (SCRAPINGBEE_KEY) {
    try {
      const titleForSearch = show.title.replace(/'/g, '');
      const searchQuery = `site:broadwayworld.com/article "Review Roundup" "${titleForSearch}" broadway ${year}`;
      console.log(`    Trying Google search for BWW roundup...`);
      const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(searchQuery)}&nb_results=5`;
      const searchResult = await new Promise((resolve, reject) => {
        const req = https.get(apiUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const results = JSON.parse(data);
                const urls = (results.organic_results || [])
                  .map(r => r.url)
                  .filter(url => url && url.includes('broadwayworld.com/article/Review-Roundup'));
                resolve(urls.length > 0 ? urls[0] : null);
              } catch (e) { resolve(null); }
            } else { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
      });
      if (searchResult) {
        console.log(`    ✓ Found via Google: ${searchResult}`);
        if (chromium) {
          const result = await scrapeBWWRoundupWithPlaywright(searchResult);
          if (result) return { url: searchResult, html: result.html };
        }
        const result = await searchAggregator('BWW', searchResult);
        if (result.found && result.html) return { url: searchResult, html: result.html };
      }
    } catch (e) { /* Google search failed, continue */ }
  }

  console.log('    ✗ Not found on BWW');
  return null;
}

/**
 * Scrape BWW roundup page using Playwright to get JS-rendered content.
 * BWW loads review quotes dynamically on many roundup pages.
 */
async function scrapeBWWRoundupWithPlaywright(url) {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Use domcontentloaded instead of networkidle — BWW has constant ad/tracking
    // requests that prevent networkidle from ever resolving
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check we're on a real roundup page, not a 404 or homepage
    const title = await page.title();
    if (!title || !title.includes('Review Roundup')) {
      await browser.close();
      return null;
    }

    // Wait for article content to render (BWW loads review quotes dynamically)
    await page.waitForSelector('article, .article-body, [class*="article"], script[type="application/ld+json"]', { timeout: 10000 }).catch(() => null);
    await sleep(3000); // Extra wait for dynamic content to fully render

    const html = await page.content();

    await browser.close();

    // Verify we actually got review content (not just the page shell)
    if (html.includes('BlogPosting') || html.includes('articleBody') || html.includes('Photo Credit:')) {
      return { html };
    }

    // Also check for common BWW review patterns in HTML body
    if (html.includes('critics had to say') || html.includes('review-roundup')) {
      return { html };
    }

    return null;
  } catch (error) {
    console.log(`    BWW Playwright error: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

/**
 * Extract reviews from BWW Review Roundup HTML
 * Uses two methods: BlogPosting JSON-LD entries (newer articles) and articleBody parsing (older)
 */
function extractBWWRoundupReviews(html, showId, bwwUrl) {
  let reviews = [];

  // Method 1: Extract from BlogPosting JSON-LD entries (newer BWW articles)
  const scriptMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const scriptMatch of scriptMatches) {
    try {
      const cleanedJson = scriptMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const json = JSON.parse(cleanedJson);

      if (json['@type'] === 'BlogPosting' && json.author) {
        const authorName = Array.isArray(json.author) ? json.author[0]?.name : json.author?.name;
        if (!authorName) continue;

        let outletRaw = authorName;
        let criticName = null;
        if (authorName.includes(' - ')) {
          const parts = authorName.split(' - ');
          outletRaw = parts[0].trim();
          criticName = parts[1]?.trim() || null;
        }

        const outletId = normalizeOutlet(outletRaw);
        const outletName = getOutletDisplayName(outletId);
        const quote = json.articleBody || json.description || '';

        reviews.push({
          showId,
          outletId,
          outlet: outletName,
          criticName,
          url: null,
          bwwExcerpt: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
          bwwRoundupUrl: bwwUrl,
          source: 'bww-roundup',
        });
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} reviews from BWW roundup (BlogPosting)`);
    return reviews;
  }

  // Method 2: Fall back to articleBody text parsing (older BWW articles)
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    try {
      const cleanedJson = jsonLdMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
      const jsonLd = JSON.parse(cleanedJson);
      const articleBody = jsonLd.articleBody || '';
      const publishDate = jsonLd.datePublished || null;

      if (articleBody) {
        // Find where reviews start
        const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
        const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

        // Pattern: "Critic Name, Outlet:" followed by review text
        // Name pattern supports apostrophes (D'Addario, O'Brien) and hyphens (Jean-Paul)
        const pattern = /([A-Z][a-z'\-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'\-]+),\s+([A-Za-z][A-Za-z\s&'.]+):\s*([^]+?)(?=(?:[A-Z][a-z'\-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'\-]+,\s+[A-Za-z][A-Za-z\s&'.]+:)|Photo Credit:|$)/g;

        let match;
        const seen = new Set();
        while ((match = pattern.exec(text)) !== null) {
          const criticName = match[1].trim();
          const outletRaw = match[2].trim();
          let quote = match[3].trim();

          if (quote.length > 500) {
            quote = quote.substring(0, 500);
            const lastPeriod = quote.lastIndexOf('.');
            if (lastPeriod > 200) quote = quote.substring(0, lastPeriod + 1);
            quote += '...';
          }

          const key = `${criticName.toLowerCase()}-${outletRaw.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Filter out false positives
          if (outletRaw.length < 2 || outletRaw.length > 60) continue;
          if (outletRaw.match(/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i)) continue;

          const outletId = normalizeOutlet(outletRaw);
          const outletName = getOutletDisplayName(outletId);

          reviews.push({
            showId,
            outletId,
            outlet: outletName,
            criticName,
            url: null,
            publishDate: normalizePublishDate(publishDate) || null,
            bwwExcerpt: quote.substring(0, 300) + (quote.length > 300 ? '...' : ''),
            bwwRoundupUrl: bwwUrl,
            source: 'bww-roundup',
          });
        }
      }
    } catch (e) {
      // Skip JSON parse errors
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} reviews from BWW roundup (articleBody)`);
  }

  return reviews;
}

/**
 * Archive aggregator page for future reference
 */
function archiveAggregatorPage(aggregator, showId, url, html) {
  const archiveDir = path.join(__dirname, '..', 'data', 'aggregator-archive', aggregator);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const archivePath = path.join(archiveDir, `${showId}.html`);

  // Refresh archives older than 14 days to capture newly added reviews
  if (fs.existsSync(archivePath)) {
    const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 14) return;
  }

  const header = `<!--
  Archived: ${new Date().toISOString()}
  Source: ${url}
  Status: 200
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  console.log(`    Archived to ${aggregator}/${showId}.html`);
}

/**
 * Create a review-text file
 * Uses centralized normalization to prevent duplicate files with different naming
 */
function createReviewFile(showId, reviewData) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  // Use centralized normalization for consistent file naming
  const normalizedOutletId = normalizeOutlet(reviewData.outlet || reviewData.outletId);
  const normalizedCriticName = normalizeCritic(reviewData.criticName);
  const filename = generateReviewFilename(reviewData.outlet || reviewData.outletId, reviewData.criticName);
  const filepath = path.join(showDir, filename);
  const reviewKey = generateReviewKey(reviewData.outlet || reviewData.outletId, reviewData.criticName);

  // PRODUCTION VERIFICATION: Check for wrong production (off-Broadway, West End, etc.)
  if (!quickDateCheck(showId, reviewData.url, reviewData.publishDate)) {
    const verification = verifyProduction({
      showId,
      url: reviewData.url,
      publishDate: reviewData.publishDate,
      text: reviewData.excerpt || reviewData.fullText
    });

    if (verification.shouldReject) {
      console.log(`    ✗ REJECTED ${filename}: Wrong production detected`);
      for (const issue of verification.issues) {
        console.log(`      - ${issue.message}`);
      }
      return false;
    }
  }

  // CRITIC-OUTLET VALIDATION: Warn if critic is at an unexpected outlet
  if (validateCriticOutlet) {
    const validation = validateCriticOutlet(reviewData.criticName, reviewData.outlet || reviewData.outletId);
    if (validation.isSuspicious && validation.confidence === 'high') {
      console.log(`    ⚠ SUSPICIOUS: ${reviewData.criticName} at ${reviewData.outlet || reviewData.outletId} (known outlets: ${validation.knownOutlets.join(', ')})`);
    }
  }

  // Check for existing review with same normalized key
  if (fs.existsSync(showDir)) {
    const existingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const existingFile of existingFiles) {
      try {
        const existingReview = JSON.parse(fs.readFileSync(path.join(showDir, existingFile), 'utf8'));
        const existingKey = generateReviewKey(existingReview.outlet, existingReview.criticName);

        // Check if same outlet + critic is a first-name prefix match
        // e.g., incoming "Jesse" at "nytimes" should match existing "Jesse Green" at "nytimes"
        const existingOutletId = normalizeOutlet(existingReview.outlet || existingReview.outletId);
        if (existingOutletId === normalizedOutletId && existingKey !== reviewKey) {
          const existingCriticSlug = normalizeCritic(existingReview.criticName);
          const incomingCriticSlug = normalizedCriticName;
          // If incoming is a prefix of existing (e.g., "jesse" is prefix of "jesse-green")
          // or existing is a prefix of incoming
          if (incomingCriticSlug.length >= 3 && existingCriticSlug.startsWith(incomingCriticSlug + '-')) {
            // Incoming "jesse" matches existing "jesse-green" — merge into existing
            const merged = mergeReviews(existingReview, {
              ...reviewData,
              source: reviewData.source || 'gather-reviews',
            });
            fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));
            console.log(`    ⟳ Prefix match: merged ${filename} into ${existingFile}`);
            return true;
          }
          if (existingCriticSlug.length >= 3 && incomingCriticSlug.startsWith(existingCriticSlug + '-')) {
            // Existing "jesse" matches incoming "jesse-green" — merge and rename
            const merged = mergeReviews(existingReview, {
              ...reviewData,
              source: reviewData.source || 'gather-reviews',
            });
            fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));
            if (existingFile !== filename) {
              fs.renameSync(path.join(showDir, existingFile), filepath);
            }
            console.log(`    ⟳ Prefix match: merged ${existingFile} into ${filename}`);
            return true;
          }
        }

        // Check if same review (by key or URL)
        if (existingKey === reviewKey) {
          // Same outlet+critic - merge data instead of skipping
          const merged = mergeReviews(existingReview, {
            ...reviewData,
            source: reviewData.source || 'gather-reviews',
          });
          fs.writeFileSync(path.join(showDir, existingFile), JSON.stringify(merged, null, 2));

          // Rename to canonical filename if different
          if (existingFile !== filename) {
            fs.renameSync(path.join(showDir, existingFile), filepath);
          }

          console.log(`    ⟳ Merged into ${filename}`);
          return true;
        }

        // Check URL match
        if (reviewData.url && existingReview.url === reviewData.url) {
          console.log(`    Skipping ${filename} (URL already exists in ${existingFile})`);
          return false;
        }
      } catch (e) {
        // Skip files that can't be parsed
      }
    }
  }

  // Create new review file with normalized data
  // Clean all text fields to decode HTML entities and strip junk
  const review = {
    showId,
    outletId: normalizedOutletId,
    outlet: getOutletDisplayName(normalizedOutletId),
    criticName: reviewData.criticName || 'Unknown',
    url: reviewData.url || null,
    publishDate: normalizePublishDate(reviewData.publishDate) || null,
    fullText: null,  // Never populate from excerpts — let collect-review-texts.js scrape real fullText
    isFullReview: false,
    dtliExcerpt: cleanText(reviewData.dtliExcerpt || reviewData.excerpt) || null,
    originalScore: reviewData.originalRating ? parseRating(reviewData.originalRating, normalizedOutletId) : null,
    assignedScore: null,
    source: reviewData.source || 'gather-reviews',
    dtliThumb: reviewData.dtliThumb || null,
    dtliUrl: reviewData.dtliUrl || null,
    bwwExcerpt: cleanText(reviewData.bwwExcerpt) || null,
    bwwRoundupUrl: reviewData.bwwRoundupUrl || null,
    showScoreExcerpt: cleanText(reviewData.showScoreExcerpt || reviewData.excerpt) || null
  };

  // Classify content quality so downstream scoring knows what it's working with
  const tier = classifyContentTier(review);
  review.contentTier = tier.contentTier;
  review.contentTierReason = tier.tierReason;

  // Date-based production guard: warn if review was published >60 days before
  // the show's earliest date (previews/opening). Likely from an off-Broadway,
  // West End, or TV production rather than the Broadway run.
  if (review.publishDate) {
    try {
      const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
      const showsJSON = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      const show = showsJSON.shows.find(s => s.id === showId);
      if (show) {
        const earliest = show.previewsStartDate || show.openingDate;
        if (earliest) {
          const pubDate = new Date(review.publishDate);
          const earliestDate = new Date(earliest);
          const daysBefore = (earliestDate - pubDate) / (1000 * 60 * 60 * 24);
          if (daysBefore > 60) {
            console.log(`    ⚠️  WARNING: Review published ${Math.round(daysBefore)} days before show's earliest date (${earliest}).`);
            console.log(`       Likely from a prior production. Flagging as wrongProduction.`);
            review.wrongProduction = true;
            review.wrongProductionNote = `Auto-flagged: published ${Math.round(daysBefore)} days before show earliest date ${earliest}`;
          }
        }
      }
    } catch (e) {}
  }

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
  console.log(`    ✓ Created ${filename}`);
  return true;
}

/**
 * Parse a rating string into a 0-100 score
 */
// Outlets that use letter grade scoring (from src/config/scoring.ts scoreFormat: 'letter').
// Letter grades from other outlets are rejected to prevent cross-contamination
// (e.g., BWW roundup leaking EW's grade into a text_bucket outlet like NYDN).
const LETTER_GRADE_OUTLETS = new Set(['ew']);

function parseRating(rating, outletId) {
  if (!rating) return null;

  const r = rating.toLowerCase().trim();

  // Star ratings out of 5 — accepted for any outlet
  const stars5 = r.match(/([\d.]+)\s*(?:\/|\s*out of\s*)?\s*5/);
  if (stars5) return Math.round((parseFloat(stars5[1]) / 5) * 100);

  // Star ratings out of 4 — accepted for any outlet
  const stars4 = r.match(/([\d.]+)\s*(?:\/|\s*out of\s*)?\s*4/);
  if (stars4) return Math.round((parseFloat(stars4[1]) / 4) * 100);

  // Letter grades — only for outlets that use letter grade scoring.
  // Uses canonical LETTER_GRADES from score-extractors.js (matches src/config/scoring.ts).
  const upperR = r.toUpperCase();
  if (LETTER_GRADES[upperR] !== undefined) {
    if (outletId && !LETTER_GRADE_OUTLETS.has(outletId)) {
      console.warn(`⚠️  Rejecting letter grade "${rating}" for ${outletId} (not a letter-grade outlet)`);
      return null;
    }
    return LETTER_GRADES[upperR];
  }

  return null;
}

/**
 * Main review gathering for a single show
 */
async function gatherReviewsForShow(showId) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Gathering reviews for: ${showId}`);
  console.log('='.repeat(60));

  const show = loadShowData(showId);
  if (!show) {
    console.error(`Show not found: ${showId}`);
    return { success: false, error: 'Show not found' };
  }

  const year = new Date(show.openingDate).getFullYear();
  console.log(`Title: ${show.title}`);
  console.log(`Year: ${year}`);
  console.log(`Status: ${show.status}`);

  const foundReviews = [];
  const outlets = loadOutlets();

  // STEP 1: Check ALL THREE aggregators (DTLI, Show Score, BWW Review Roundups)
  console.log('\n[1/4] Checking aggregators...');

  // 1a. Did They Like It - Has individual thumb ratings (Up/Meh/Down)
  console.log('\n  === Did They Like It ===');
  const dtliResult = await searchDTLI(show);
  if (dtliResult) {
    const dtliReviews = extractDTLIReviews(dtliResult.html, showId, dtliResult.url);
    foundReviews.push(...dtliReviews);
    // Archive the page
    archiveAggregatorPage('dtli', showId, dtliResult.url, dtliResult.html);
  }
  await sleep(DELAY_MS);

  // 1b. Show Score - Has critic reviews with excerpts
  console.log('\n  === Show Score ===');
  const showScoreResult = await searchShowScore(show);
  if (showScoreResult) {
    // Extract initial reviews from page (first 8 visible in carousel)
    if (showScoreResult.reviews && showScoreResult.reviews.length > 0) {
      console.log(`    Playwright extracted ${showScoreResult.reviews.length} reviews directly`);
      for (const review of showScoreResult.reviews) {
        // Map Playwright review to our format
        const outletId = review.outlet ? slugify(review.outlet) : slugify(new URL(review.url).hostname.replace('www.', ''));
        foundReviews.push({
          showId,
          outlet: review.outlet || 'Unknown',
          outletId,
          criticName: review.critic || 'Unknown',
          url: review.url,
          publishDate: normalizePublishDate(review.date) || null,
          showScoreExcerpt: review.excerpt || null,
          source: 'show-score-playwright'
        });
      }
    } else {
      // Fall back to HTML extraction for initial reviews
      const showScoreReviews = extractShowScoreReviews(showScoreResult.html, showId);
      foundReviews.push(...showScoreReviews);
    }

    // Fetch remaining reviews via Show Score pagination API
    // The initial page only shows 8 critic reviews; the rest are loaded via AJAX
    const paginatedReviews = await fetchShowScorePaginatedReviews(
      showScoreResult.url, showScoreResult.html, showId
    );
    for (const review of paginatedReviews) {
      // Only add if not already found (avoid duplicates from initial extraction)
      if (!foundReviews.some(r => r.url === review.url)) {
        foundReviews.push(review);
      }
    }

    // Archive the page
    archiveAggregatorPage('show-score', showId, showScoreResult.url, showScoreResult.html);
  }
  await sleep(DELAY_MS);

  // 1c. BroadwayWorld Review Roundups - Compiles all reviews in one article
  console.log('\n  === BroadwayWorld Review Roundups ===');
  const bwwResult = await searchBWWRoundup(show, year);
  if (bwwResult) {
    const bwwReviews = extractBWWRoundupReviews(bwwResult.html, showId, bwwResult.url);
    foundReviews.push(...bwwReviews);
    // Archive the page
    archiveAggregatorPage('bww-roundups', showId, bwwResult.url, bwwResult.html);
  }
  await sleep(DELAY_MS);

  // STEP 2: Search ALL outlets via web search (comprehensive coverage)
  console.log(`\n[2/4] Searching all ${outlets.length} outlets via web search...`);

  // Search ALL tiers - we're a comprehensive site, every review matters
  // Tier 1 outlets first, then Tier 2, then Tier 3
  const allOutlets = outlets.sort((a, b) => a.tier - b.tier);

  for (const outlet of allOutlets) {
    process.stdout.write(`  ${outlet.name}... `);

    const result = await searchForReview(show.title, year, outlet);

    if (result && result.url) {
      console.log('✓ Found');
      foundReviews.push({
        showId,
        outletId: outlet.id,
        outlet: outlet.name,
        criticName: result.critic,
        url: result.url,
        publishDate: normalizePublishDate(result.publishDate),
        excerpt: result.excerpt,
        originalRating: result.originalRating,
        source: 'web-search'
      });
    } else {
      console.log('✗');
    }

    await sleep(DELAY_MS);
  }

  // STEP 3: Deduplicate and create review files
  console.log('\n[3/4] Deduplicating and creating review files...');

  let created = 0;
  for (const review of foundReviews) {
    if (review.url && !review.needsUrl) {
      if (createReviewFile(showId, review)) {
        created++;
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total reviews found: ${foundReviews.length}`);
  console.log(`Review files created: ${created}`);
  console.log(`Reviews needing URLs: ${foundReviews.filter(r => r.needsUrl).length}`);

  return {
    success: true,
    showId,
    reviewsFound: foundReviews.length,
    filesCreated: created
  };
}

/**
 * Rebuild reviews.json from review-texts
 */
async function rebuildReviewsJson() {
  console.log('\nRebuilding reviews.json...');

  // Use the existing rebuild script if available
  const rebuildScript = path.join(__dirname, 'rebuild-all-reviews.js');
  if (fs.existsSync(rebuildScript)) {
    const { execSync } = require('child_process');
    try {
      execSync(`node "${rebuildScript}"`, { stdio: 'inherit' });
      console.log('✓ reviews.json rebuilt');
    } catch (e) {
      console.log('⚠️  Failed to rebuild reviews.json:', e.message);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse --shows argument
  const showsArg = args.find(a => a.startsWith('--shows='));
  if (!showsArg) {
    console.log('Usage: node scripts/gather-reviews.js --shows=show-id-1,show-id-2');
    console.log('Example: node scripts/gather-reviews.js --shows=all-out-2025');
    process.exit(1);
  }

  const showIds = showsArg.replace('--shows=', '').split(',').map(s => s.trim());

  console.log('========================================');
  console.log('Broadway Review Gatherer');
  console.log('========================================');
  console.log(`Shows to process: ${showIds.join(', ')}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'Set' : 'NOT SET'}`);

  const results = [];

  for (const showId of showIds) {
    const result = await gatherReviewsForShow(showId);
    results.push(result);
    await sleep(2000); // Delay between shows
  }

  // Rebuild reviews.json
  await rebuildReviewsJson();

  // Final summary
  console.log('\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');
  for (const r of results) {
    if (r.success) {
      console.log(`✓ ${r.showId}: ${r.reviewsFound} reviews found, ${r.filesCreated} files created`);
    } else {
      console.log(`✗ ${r.showId}: ${r.error}`);
    }
  }

  // Set output for GitHub Actions
  const totalCreated = results.reduce((sum, r) => sum + (r.filesCreated || 0), 0);
  console.log(`\nshows_processed=${results.length}`);
  console.log(`reviews_created=${totalCreated}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
