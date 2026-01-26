#!/usr/bin/env node
/**
 * Gather Reviews Script
 *
 * Automated review gathering for Broadway shows.
 * This script powers the gather-reviews.yml GitHub Action.
 *
 * Process:
 * 1. Search aggregators (DTLI, BWW, Show Score) for reviews
 * 2. Search individual outlets via Google
 * 3. Create review-text files for each found review
 * 4. Rebuild reviews.json
 *
 * Usage:
 *   node scripts/gather-reviews.js --shows=show-id-1,show-id-2
 *   node scripts/gather-reviews.js --shows=all-out-2025
 *
 * Environment Variables:
 *   ANTHROPIC_API_KEY - Required for Claude API web search
 *   BRIGHTDATA_TOKEN - Optional for scraping
 *   SCRAPINGBEE_API_KEY - Optional for scraping fallback
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

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
    const req = https.get(searchUrl, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: searchUrl }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Check if redirect goes to homepage (not what we want)
        const redirectUrl = res.headers.location;
        if (redirectUrl.includes('/shows/all') || redirectUrl.endsWith('/shows')) {
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
 * Try to find show on Did They Like It
 */
async function searchDTLI(show) {
  const variations = [
    show.slug,
    show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-the-/g, '-'),
    show.title.toLowerCase().replace(/:/g, '').replace(/[^a-z0-9]+/g, '-')
  ];

  console.log('  Searching Did They Like It...');

  for (const slug of [...new Set(variations)]) {
    const url = `https://didtheylikeit.com/shows/${slug}/`;
    const result = await searchAggregator('DTLI', url);
    if (result.found && result.html && result.html.includes('reviews')) {
      console.log(`    ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(500);
  }

  console.log('    ✗ Not found on DTLI');
  return null;
}

/**
 * Try to find show on Show Score using web search first, then URL guessing
 */
async function searchShowScore(show) {
  console.log('  Searching Show Score...');

  // METHOD 1: Web search (most reliable)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const searchQuery = `site:show-score.com "broadway" "${show.title}"`;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Search the web for: ${searchQuery}

Find the Show Score page for the Broadway show "${show.title}".
Return ONLY the URL in this exact format: {"url": "https://www.show-score.com/broadway-shows/..."}
If you cannot find it, return: {"url": null}`
          }]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          if (result.url && result.url.includes('show-score.com/broadway-shows/')) {
            console.log(`    Found via search: ${result.url}`);
            // Fetch the actual page
            const pageResult = await searchAggregator('ShowScore', result.url);
            if (pageResult.found && pageResult.html &&
                !pageResult.html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>')) {
              console.log(`    ✓ Confirmed at: ${result.url}`);
              return { url: result.url, html: pageResult.html };
            }
          }
        }
      }
    } catch (e) {
      console.log(`    Web search failed: ${e.message}`);
    }
  }

  // METHOD 2: URL guessing (fallback)
  console.log('    Trying URL patterns...');
  const year = new Date(show.openingDate).getFullYear();
  const titleSlug = slugify(show.title);
  const titleNoColonSlug = slugify(show.title.replace(/:/g, ''));

  const variations = [
    show.slug,
    titleSlug,
    titleNoColonSlug,
    // Show Score often appends "-broadway" to Broadway show slugs
    `${titleSlug}-broadway`,
    `${titleNoColonSlug}-broadway`,
    `${show.slug}-broadway`,
    // Some shows include the year
    `${titleSlug}-${year}`,
    `${titleNoColonSlug}-${year}`,
  ];

  for (const slug of [...new Set(variations)]) {
    const url = `https://www.show-score.com/broadway-shows/${slug}`;
    const result = await searchAggregator('ShowScore', url);

    // Check that we got actual show content, not the homepage
    if (result.found && result.html &&
        result.html.includes('score') &&
        !result.html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>')) {
      console.log(`    ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(300);
  }

  console.log('    ✗ Not found on Show Score');
  return null;
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
                publishDate: review.datePublished || null,
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
    // Try to find outlet context nearby
    const contextStart = Math.max(0, match.index - 500);
    const context = html.substring(contextStart, match.index + match[0].length);

    // Common outlet patterns
    const outletPatterns = [
      { pattern: /New York Times|nytimes\.com/i, outlet: 'The New York Times', outletId: 'nytimes' },
      { pattern: /Vulture|vulture\.com/i, outlet: 'Vulture', outletId: 'vulture' },
      { pattern: /Variety|variety\.com/i, outlet: 'Variety', outletId: 'variety' },
      { pattern: /Hollywood Reporter|hollywoodreporter\.com/i, outlet: 'The Hollywood Reporter', outletId: 'THR' },
      { pattern: /Time Out|timeout\.com/i, outlet: 'Time Out New York', outletId: 'TIMEOUT' },
      { pattern: /New York Post|nypost\.com/i, outlet: 'New York Post', outletId: 'NYP' },
      { pattern: /TheaterMania|theatermania\.com/i, outlet: 'TheaterMania', outletId: 'TMAN' },
      { pattern: /Deadline|deadline\.com/i, outlet: 'Deadline', outletId: 'DEADLINE' },
      { pattern: /New York Theater|newyorktheater\.me/i, outlet: 'New York Theater', outletId: 'NYTHTR' },
      { pattern: /Theatrely|theatrely\.com/i, outlet: 'Theatrely', outletId: 'THLY' },
      { pattern: /Broadway World|broadwayworld\.com/i, outlet: 'BroadwayWorld', outletId: 'BWW' },
      { pattern: /Stage and Cinema|stageandcinema\.com/i, outlet: 'Stage and Cinema', outletId: 'SAC' },
    ];

    for (const { pattern, outlet, outletId } of outletPatterns) {
      if (pattern.test(context) || pattern.test(url)) {
        // Check if we already have this outlet
        if (!reviews.some(r => r.outletId === outletId)) {
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
        break;
      }
    }
  }

  if (reviews.length > 0) {
    console.log(`    Extracted ${reviews.length} reviews from Show Score`);
  }

  return reviews;
}

/**
 * Extract reviews from DTLI HTML
 */
function extractDTLIReviews(html, showId) {
  const reviews = [];

  // Look for review links - DTLI typically has outlet name, critic, and review URL
  // Pattern: critic name with outlet, sometimes with thumb up/down/meh

  // Simple extraction: find all outlet mentions with URLs
  const outletPatterns = [
    { pattern: /New York Times/i, outlet: 'The New York Times', outletId: 'nytimes' },
    { pattern: /Vulture/i, outlet: 'Vulture', outletId: 'vulture' },
    { pattern: /Variety/i, outlet: 'Variety', outletId: 'variety' },
    { pattern: /Hollywood Reporter/i, outlet: 'The Hollywood Reporter', outletId: 'THR' },
    { pattern: /Time Out/i, outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    { pattern: /Daily News/i, outlet: 'New York Daily News', outletId: 'NYDN' },
    { pattern: /New York Post/i, outlet: 'New York Post', outletId: 'NYP' },
    { pattern: /TheaterMania/i, outlet: 'TheaterMania', outletId: 'TMAN' },
    { pattern: /Washington Post/i, outlet: 'The Washington Post', outletId: 'WASHPOST' },
    { pattern: /Deadline/i, outlet: 'Deadline', outletId: 'DEADLINE' },
    { pattern: /Associated Press|AP News/i, outlet: 'Associated Press', outletId: 'AP' },
    { pattern: /Guardian/i, outlet: 'The Guardian', outletId: 'GUARDIAN' },
    { pattern: /Daily Beast/i, outlet: 'The Daily Beast', outletId: 'TDB' },
    { pattern: /Theatrely/i, outlet: 'Theatrely', outletId: 'THLY' },
    { pattern: /New York Stage Review/i, outlet: 'New York Stage Review', outletId: 'NYSR' },
    { pattern: /New York Theatre Guide/i, outlet: 'New York Theatre Guide', outletId: 'NYTG' },
    { pattern: /Observer/i, outlet: 'Observer', outletId: 'OBSERVER' },
  ];

  // Extract thumb status from page (Up/Meh/Down counts)
  const thumbMatch = html.match(/(\d+)\s*UP.*?(\d+)\s*MEH.*?(\d+)\s*DOWN/i);
  if (thumbMatch) {
    console.log(`    Found ${thumbMatch[1]} UP, ${thumbMatch[2]} MEH, ${thumbMatch[3]} DOWN`);
  }

  // Try to extract individual reviews - this is simplified since DTLI structure varies
  // In a real implementation, we'd need proper HTML parsing
  for (const { pattern, outlet, outletId } of outletPatterns) {
    if (pattern.test(html)) {
      // Found this outlet mentioned - record it as needing review discovery
      reviews.push({
        showId,
        outletId,
        outlet,
        source: 'dtli-mention',
        needsUrl: true
      });
    }
  }

  return reviews;
}

/**
 * Create a review-text file
 */
function createReviewFile(showId, reviewData) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const criticSlug = slugify(reviewData.criticName || 'unknown');
  const outletSlug = reviewData.outletId.toLowerCase();
  const filename = `${outletSlug}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  // Don't overwrite existing files
  if (fs.existsSync(filepath)) {
    console.log(`    Skipping ${filename} (already exists)`);
    return false;
  }

  // Check for existing review with same URL (prevents duplicates with different critic names)
  if (reviewData.url && fs.existsSync(showDir)) {
    const existingFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    for (const existingFile of existingFiles) {
      try {
        const existingReview = JSON.parse(fs.readFileSync(path.join(showDir, existingFile), 'utf8'));
        if (existingReview.url === reviewData.url) {
          console.log(`    Skipping ${filename} (URL already exists in ${existingFile})`);
          return false;
        }
      } catch (e) {
        // Skip files that can't be parsed
      }
    }
  }

  const review = {
    showId,
    outletId: reviewData.outletId,
    outlet: reviewData.outlet,
    criticName: reviewData.criticName || 'Unknown',
    url: reviewData.url || null,
    publishDate: reviewData.publishDate || null,
    fullText: reviewData.excerpt || null,
    isFullReview: false,
    dtliExcerpt: reviewData.excerpt || null,
    originalScore: reviewData.originalRating ? parseRating(reviewData.originalRating) : null,
    assignedScore: null,
    source: reviewData.source || 'gather-reviews',
    dtliThumb: null,
    needsScoring: true
  };

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
  console.log(`    ✓ Created ${filename}`);
  return true;
}

/**
 * Parse a rating string into a 0-100 score
 */
function parseRating(rating) {
  if (!rating) return null;

  const r = rating.toLowerCase().trim();

  // Star ratings out of 5
  const stars5 = r.match(/([\d.]+)\s*(?:\/|\s*out of\s*)?\s*5/);
  if (stars5) return Math.round((parseFloat(stars5[1]) / 5) * 100);

  // Star ratings out of 4
  const stars4 = r.match(/([\d.]+)\s*(?:\/|\s*out of\s*)?\s*4/);
  if (stars4) return Math.round((parseFloat(stars4[1]) / 4) * 100);

  // Letter grades
  const grades = {
    'a+': 100, 'a': 95, 'a-': 92,
    'b+': 88, 'b': 83, 'b-': 78,
    'c+': 73, 'c': 68, 'c-': 63,
    'd+': 58, 'd': 53, 'd-': 48,
    'f': 35
  };
  if (grades[r]) return grades[r];

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

  // STEP 1: Check aggregators
  console.log('\n[1/3] Checking aggregators...');

  const dtliResult = await searchDTLI(show);
  if (dtliResult) {
    const dtliReviews = extractDTLIReviews(dtliResult.html, showId);
    foundReviews.push(...dtliReviews);
  }
  await sleep(DELAY_MS);

  const showScoreResult = await searchShowScore(show);
  if (showScoreResult) {
    const showScoreReviews = extractShowScoreReviews(showScoreResult.html, showId);
    foundReviews.push(...showScoreReviews);
  }
  await sleep(DELAY_MS);

  // STEP 2: Search ALL outlets (comprehensive coverage)
  console.log(`\n[2/3] Searching all ${outlets.length} outlets...`);

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
        publishDate: result.publishDate,
        excerpt: result.excerpt,
        originalRating: result.originalRating,
        source: 'web-search'
      });
    } else {
      console.log('✗');
    }

    await sleep(DELAY_MS);
  }

  // STEP 3: Create review files
  console.log('\n[3/3] Creating review files...');

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
