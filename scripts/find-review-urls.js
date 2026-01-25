#!/usr/bin/env node

/**
 * Find updated URLs for reviews with broken/missing links
 * Uses Google search via ScrapingBee to find current review URLs
 *
 * Usage:
 *   node scripts/find-review-urls.js [--dry-run] [--limit=N] [--show=showId] [--errors-only]
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const errorLogFile = path.join(__dirname, '../data/fetch-errors.json');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const errorsOnly = args.includes('--errors-only');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Load error log if exists
let errorLog = {};
if (fs.existsSync(errorLogFile)) {
  errorLog = JSON.parse(fs.readFileSync(errorLogFile, 'utf8'));
}

// Find reviews that need URL updates
function findReviewsNeedingUrls() {
  const reviews = [];

  const shows = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const show of shows) {
    if (showFilter && show !== showFilter) continue;

    const showDir = path.join(reviewTextsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const key = `${show}/${file}`;

      try {
        const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has full text
        if (review.fullText && review.fullText.length > 100 && !review.needsFullText) {
          continue;
        }

        // If errors-only mode, only include reviews that had fetch errors
        if (errorsOnly) {
          const error = errorLog[key];
          if (!error || error.status === 'success') continue;
        }

        reviews.push({
          show,
          file,
          path: filePath,
          key,
          outlet: review.outlet,
          criticName: review.criticName,
          url: review.url,
          error: errorLog[key]?.error
        });
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }

  return reviews;
}

// Generate search query for a review
function generateSearchQuery(review) {
  const showName = review.show
    .replace(/-\d{4}$/, '')  // Remove year
    .replace(/-/g, ' ')      // Replace dashes with spaces
    .replace(/\b\w/g, c => c.toUpperCase());  // Title case

  const outlet = review.outlet || 'review';
  const critic = review.criticName || '';

  // Build search query
  let query = `"${showName}" Broadway review ${outlet}`;
  if (critic && critic !== 'unknown') {
    query += ` ${critic}`;
  }

  return query;
}

// Output reviews that need URL search
function main() {
  const reviews = findReviewsNeedingUrls();

  console.log(`Found ${reviews.length} reviews that need URL updates\n`);

  if (limit < Infinity) {
    console.log(`Limiting to ${limit}\n`);
  }

  // Group by error type
  const byError = {};
  for (const review of reviews) {
    const errorType = review.error || 'no-url';
    if (!byError[errorType]) byError[errorType] = [];
    byError[errorType].push(review);
  }

  console.log('By error type:');
  for (const [error, items] of Object.entries(byError)) {
    console.log(`  ${error}: ${items.length}`);
  }
  console.log('');

  // Output search queries
  const toSearch = reviews.slice(0, limit);

  console.log('Search queries to run:');
  console.log('======================\n');

  for (const review of toSearch) {
    const query = generateSearchQuery(review);
    console.log(`${review.key}:`);
    console.log(`  Query: ${query}`);
    console.log(`  Current URL: ${review.url || 'none'}`);
    console.log('');
  }

  // Write to file for batch processing
  const outputFile = path.join(__dirname, '../data/url-search-queue.json');
  const searchQueue = toSearch.map(r => ({
    key: r.key,
    path: r.path,
    query: generateSearchQuery(r),
    currentUrl: r.url,
    outlet: r.outlet,
    criticName: r.criticName,
    error: r.error
  }));

  if (!dryRun) {
    fs.writeFileSync(outputFile, JSON.stringify(searchQueue, null, 2));
    console.log(`\nWrote ${searchQueue.length} search queries to ${outputFile}`);
  }
}

main();
