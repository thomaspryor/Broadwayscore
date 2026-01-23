#!/usr/bin/env node

/**
 * Update review URLs by searching Google for current links
 * Processes reviews that have 404 errors or missing URLs
 *
 * This script outputs search queries that can be processed by the main agent
 * using ScrapingBee's Google search API
 *
 * Usage:
 *   node scripts/update-review-urls.js [--limit=N] [--show=showId]
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Parse args
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 50;
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Outlet domain mappings for better search results
const outletDomains = {
  'The New York Times': 'nytimes.com',
  'nytimes': 'nytimes.com',
  'Variety': 'variety.com',
  'The Hollywood Reporter': 'hollywoodreporter.com',
  'Vulture': 'vulture.com',
  'Time Out New York': 'timeout.com',
  'TimeOut': 'timeout.com',
  'Deadline': 'deadline.com',
  'The Wall Street Journal': 'wsj.com',
  'Entertainment Weekly': 'ew.com',
  'New York Post': 'nypost.com',
  'The Guardian': 'theguardian.com',
  'Chicago Tribune': 'chicagotribune.com',
  'The Washington Post': 'washingtonpost.com',
  'USA Today': 'usatoday.com',
  'Associated Press': 'apnews.com',
  'Rolling Stone': 'rollingstone.com',
  'The Daily Beast': 'thedailybeast.com',
  'Observer': 'observer.com',
  'The Wrap': 'thewrap.com',
  'New York Daily News': 'nydailynews.com',
  'Newsday': 'newsday.com',
  'TheaterMania': 'theatermania.com',
  'New York Theatre Guide': 'newyorktheatreguide.com',
  'New York Stage Review': 'nystagereview.com',
  'Theatrely': 'theatrely.com',
  'New York Theater': 'newyorktheater.me',
  'BroadwayWorld': 'broadwayworld.com',
  'Cititour': 'cititour.com',
  'amNewYork': 'amny.com',
};

// Find reviews needing URL updates
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

      try {
        const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if already has full text
        if (review.fullText && review.fullText.length > 100 && !review.needsFullText) {
          continue;
        }

        reviews.push({
          show,
          file,
          path: filePath,
          outlet: review.outlet,
          outletId: review.outletId,
          criticName: review.criticName,
          url: review.url,
          needsFullText: review.needsFullText
        });
      } catch (e) {
        // Skip
      }
    }
  }

  return reviews;
}

// Generate search query
function generateSearchQuery(review) {
  // Format show name
  const showName = review.show
    .replace(/-\d{4}$/, '')
    .replace(/-/g, ' ');

  const outlet = review.outlet || '';
  const critic = review.criticName && review.criticName !== 'unknown' ? review.criticName : '';

  // Get domain for site-specific search
  const domain = outletDomains[outlet] || outletDomains[review.outletId];

  let query = `"${showName}" Broadway review`;

  if (domain) {
    query += ` site:${domain}`;
  } else if (outlet) {
    query += ` "${outlet}"`;
  }

  if (critic) {
    query += ` ${critic}`;
  }

  return query;
}

// Main
function main() {
  const reviews = findReviewsNeedingUrls();

  console.log(`Found ${reviews.length} reviews needing URL updates`);
  console.log(`Processing first ${Math.min(limit, reviews.length)}\n`);

  const toProcess = reviews.slice(0, limit);

  // Output as JSON for batch processing
  const output = toProcess.map(r => ({
    key: `${r.show}/${r.file}`,
    path: r.path,
    query: generateSearchQuery(r),
    outlet: r.outlet,
    criticName: r.criticName,
    currentUrl: r.url
  }));

  // Write to file
  const outputFile = path.join(__dirname, '../data/url-search-batch.json');
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

  console.log(`Wrote ${output.length} search queries to data/url-search-batch.json`);
  console.log('\nSample queries:');

  for (const item of output.slice(0, 10)) {
    console.log(`  ${item.key}: ${item.query}`);
  }

  if (output.length > 10) {
    console.log(`  ... and ${output.length - 10} more`);
  }
}

main();
