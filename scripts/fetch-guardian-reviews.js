#!/usr/bin/env node
/**
 * Fetch Guardian Reviews via Open Platform API
 *
 * The Guardian provides a free Open Platform API that returns full article content.
 * This is much more reliable than scraping since it's official API access.
 *
 * API Documentation: https://open-platform.theguardian.com/documentation/
 * API Key Registration: https://open-platform.theguardian.com/access/
 *
 * Usage:
 *   # Test with a few reviews first
 *   GUARDIAN_API_KEY=your-key node scripts/fetch-guardian-reviews.js --limit=2
 *
 *   # Process all Guardian reviews without fullText
 *   GUARDIAN_API_KEY=your-key node scripts/fetch-guardian-reviews.js
 *
 *   # Process specific shows
 *   GUARDIAN_API_KEY=your-key node scripts/fetch-guardian-reviews.js --shows=hamilton-2015,wicked-2003
 *
 *   # Dry run (don't save changes)
 *   GUARDIAN_API_KEY=your-key node scripts/fetch-guardian-reviews.js --dry-run
 *
 * Environment Variables:
 *   GUARDIAN_API_KEY - Required. Get one at https://open-platform.theguardian.com/access/
 *
 * Rate Limits:
 *   Free tier: 12 calls per second, 5000 calls per day
 *   Developer tier: Higher limits available
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const CONFIG = {
  apiKey: process.env.GUARDIAN_API_KEY || '',
  baseUrl: 'https://content.guardianapis.com',
  reviewTextsDir: 'data/review-texts',
  rateLimitDelay: 100, // ms between requests (12 calls/sec = ~83ms min)
  minTextLength: 500,
};

// Parse CLI arguments
const args = process.argv.slice(2);
const CLI = {
  dryRun: args.includes('--dry-run'),
  limit: (() => {
    const limitArg = args.find(a => a.startsWith('--limit='));
    return limitArg ? parseInt(limitArg.split('=')[1]) : 0;
  })(),
  shows: (() => {
    const showsArg = args.find(a => a.startsWith('--shows='));
    return showsArg ? showsArg.split('=')[1].split(',') : [];
  })(),
  verbose: args.includes('--verbose') || args.includes('-v'),
};

// Statistics
const stats = {
  found: 0,
  fetched: 0,
  failed: 0,
  skipped: 0,
  apiErrors: 0,
};

/**
 * Extract article ID from Guardian URL
 * Guardian URLs follow pattern: https://www.theguardian.com/section/YYYY/MMM/DD/article-slug
 * API needs the path after theguardian.com
 */
function extractArticleId(url) {
  try {
    const urlObj = new URL(url);
    // Remove leading slash
    return urlObj.pathname.replace(/^\//, '');
  } catch (e) {
    return null;
  }
}

/**
 * Fetch article content from Guardian API
 * Uses the single item endpoint: /articleId?show-fields=body,bodyText
 */
async function fetchArticleFromAPI(articleId) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      'api-key': CONFIG.apiKey,
      'show-fields': 'body,bodyText,headline,byline,standfirst',
    });

    const url = `${CONFIG.baseUrl}/${articleId}?${params}`;

    if (CLI.verbose) {
      console.log(`    API URL: ${url.replace(CONFIG.apiKey, 'API_KEY')}`);
    }

    https.get(url, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (json.response?.status === 'ok' && json.response?.content) {
            const content = json.response.content;
            const fields = content.fields || {};

            // Prefer bodyText (plain text) over body (HTML)
            let text = fields.bodyText || '';

            // If no bodyText, extract from body HTML
            if (!text && fields.body) {
              text = stripHtml(fields.body);
            }

            resolve({
              success: true,
              text: text,
              headline: fields.headline || content.webTitle,
              byline: fields.byline,
              standfirst: fields.standfirst,
              webUrl: content.webUrl,
              apiUrl: content.apiUrl,
            });
          } else if (json.response?.status === 'error') {
            resolve({
              success: false,
              error: json.response.message || 'API error',
            });
          } else {
            resolve({
              success: false,
              error: 'Unexpected response format',
            });
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on('error', (e) => {
      reject(new Error(`HTTP error: ${e.message}`));
    });
  });
}

/**
 * Strip HTML tags and decode entities
 */
function stripHtml(html) {
  if (!html) return '';

  return html
    // Remove script and style tags with content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove all HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
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
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find Guardian reviews that need fullText
 */
function findGuardianReviews() {
  const reviews = [];

  if (!fs.existsSync(CONFIG.reviewTextsDir)) {
    console.error(`Review texts directory not found: ${CONFIG.reviewTextsDir}`);
    return reviews;
  }

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => fs.statSync(path.join(CONFIG.reviewTextsDir, f)).isDirectory());

  for (const showId of shows) {
    // Filter by shows if specified
    if (CLI.shows.length > 0 && !CLI.shows.includes(showId)) {
      continue;
    }

    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir)
      .filter(f => f.startsWith('guardian') && f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has fullText
        if (data.fullText && data.fullText.length > CONFIG.minTextLength) {
          stats.skipped++;
          continue;
        }

        // Skip if no URL
        if (!data.url) {
          continue;
        }

        // Extract article ID from URL
        const articleId = extractArticleId(data.url);
        if (!articleId) {
          console.log(`  Could not extract article ID from: ${data.url}`);
          continue;
        }

        reviews.push({
          filePath,
          showId,
          file,
          url: data.url,
          articleId,
          outlet: data.outlet || 'The Guardian',
          critic: data.criticName || 'Unknown',
          existingData: data,
        });
      } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
      }
    }
  }

  return reviews;
}

/**
 * Update review JSON with fetched content
 */
function updateReviewFile(review, apiResult) {
  const data = review.existingData;

  data.fullText = apiResult.text;
  data.isFullReview = apiResult.text.length > 1500;
  data.textWordCount = apiResult.text.split(/\s+/).filter(w => w.length > 0).length;
  data.textFetchedAt = new Date().toISOString();
  data.fetchMethod = 'guardian-api';
  data.fetchTier = 0; // API is tier 0 (most reliable)
  data.textQuality = data.isFullReview ? 'full' : 'partial';
  data.textStatus = 'complete';
  data.sourceMethod = 'guardian-api';

  // Store API metadata
  data.guardianApi = {
    headline: apiResult.headline,
    byline: apiResult.byline,
    standfirst: apiResult.standfirst,
    webUrl: apiResult.webUrl,
    fetchedAt: new Date().toISOString(),
  };

  if (!CLI.dryRun) {
    fs.writeFileSync(review.filePath, JSON.stringify(data, null, 2));
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Guardian Reviews Fetcher via Open Platform API');
  console.log('='.repeat(60));

  // Check API key
  if (!CONFIG.apiKey) {
    console.error('\nError: GUARDIAN_API_KEY environment variable not set');
    console.error('Get a free API key at: https://open-platform.theguardian.com/access/');
    process.exit(1);
  }

  console.log(`\nAPI Key: ${CONFIG.apiKey.substring(0, 8)}...`);
  console.log(`Dry run: ${CLI.dryRun}`);
  if (CLI.shows.length > 0) {
    console.log(`Shows filter: ${CLI.shows.join(', ')}`);
  }
  if (CLI.limit > 0) {
    console.log(`Limit: ${CLI.limit}`);
  }

  // Find reviews to process
  const reviews = findGuardianReviews();
  stats.found = reviews.length;

  console.log(`\nFound ${reviews.length} Guardian reviews without fullText`);
  console.log(`Skipped ${stats.skipped} reviews that already have fullText`);

  if (reviews.length === 0) {
    console.log('\nNo reviews to process.');
    return;
  }

  // Apply limit
  const toProcess = CLI.limit > 0 ? reviews.slice(0, CLI.limit) : reviews;
  console.log(`\nProcessing ${toProcess.length} reviews...\n`);

  // Process each review
  for (let i = 0; i < toProcess.length; i++) {
    const review = toProcess[i];

    console.log(`[${i + 1}/${toProcess.length}] ${review.showId} - ${review.critic}`);
    console.log(`  URL: ${review.url}`);
    console.log(`  Article ID: ${review.articleId}`);

    try {
      const result = await fetchArticleFromAPI(review.articleId);

      if (result.success && result.text) {
        const wordCount = result.text.split(/\s+/).filter(w => w.length > 0).length;

        if (result.text.length >= CONFIG.minTextLength) {
          console.log(`  SUCCESS: ${result.text.length} chars, ${wordCount} words`);

          updateReviewFile(review, result);
          stats.fetched++;

          if (CLI.verbose) {
            console.log(`  Preview: ${result.text.substring(0, 200)}...`);
          }
        } else {
          console.log(`  WARNING: Text too short (${result.text.length} chars)`);
          stats.failed++;
        }
      } else {
        console.log(`  FAILED: ${result.error}`);
        stats.failed++;
        stats.apiErrors++;
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      stats.failed++;
      stats.apiErrors++;
    }

    // Rate limiting
    if (i < toProcess.length - 1) {
      await sleep(CONFIG.rateLimitDelay);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Found:     ${stats.found} reviews without fullText`);
  console.log(`Processed: ${toProcess.length}`);
  console.log(`Fetched:   ${stats.fetched}`);
  console.log(`Failed:    ${stats.failed}`);
  console.log(`API Errors: ${stats.apiErrors}`);

  if (CLI.dryRun) {
    console.log('\n(Dry run - no files were modified)');
  }

  // Exit with error if all failed
  if (stats.fetched === 0 && toProcess.length > 0) {
    console.error('\nNo reviews were successfully fetched.');
    process.exit(1);
  }
}

// Run
main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
