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
async function searchAggregator(aggregatorName, searchUrl) {
  return new Promise((resolve) => {
    const req = https.get(searchUrl, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        searchAggregator(aggregatorName, res.headers.location).then(resolve);
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
 * Try to find show on Show Score
 */
async function searchShowScore(show) {
  const variations = [
    show.slug,
    slugify(show.title),
    slugify(show.title.replace(/:/g, ''))
  ];

  console.log('  Searching Show Score...');

  for (const slug of [...new Set(variations)]) {
    const url = `https://www.show-score.com/broadway-shows/${slug}`;
    const result = await searchAggregator('ShowScore', url);
    if (result.found && result.html && result.html.includes('score')) {
      console.log(`    ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(500);
  }

  console.log('    ✗ Not found on Show Score');
  return null;
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
  // Show Score processing would go here (similar to DTLI)
  await sleep(DELAY_MS);

  // STEP 2: Search key outlets directly
  console.log('\n[2/3] Searching key outlets...');

  // Prioritize Tier 1 and key Tier 2 outlets
  const priorityOutlets = outlets.filter(o => o.tier <= 2).slice(0, 15);

  for (const outlet of priorityOutlets) {
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
