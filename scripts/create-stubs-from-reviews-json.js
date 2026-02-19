#!/usr/bin/env node
/**
 * Create stub review-text files for reviews that exist in reviews.json
 * but have no corresponding file in data/review-texts/.
 *
 * This enables the URL rediscovery pipeline to find URLs for these reviews
 * and the wayback recovery pipeline to fetch their content.
 *
 * Usage:
 *   node scripts/create-stubs-from-reviews-json.js [options]
 *
 * Environment variables:
 *   OUTLET_FILTER=x,y     Only process specific outlets (comma-separated outletIds)
 *   DRY_RUN=true          Show what would be created, don't write
 *   MAX_STUBS=100         Limit number of stubs to create
 */

const fs = require('fs');
const path = require('path');
const { generateReviewFilename } = require('./lib/review-normalization');

const CONFIG = {
  reviewsJsonPath: path.join(__dirname, '..', 'data', 'reviews.json'),
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  outletFilter: process.env.OUTLET_FILTER ? process.env.OUTLET_FILTER.split(',').map(s => s.trim().toLowerCase()) : [],
  dryRun: process.env.DRY_RUN === 'true',
  maxStubs: parseInt(process.env.MAX_STUBS || '0') || Infinity,
};

function main() {
  console.log('Creating stub review-text files from reviews.json...\n');

  const reviewsData = JSON.parse(fs.readFileSync(CONFIG.reviewsJsonPath, 'utf8'));
  const reviews = reviewsData.reviews || [];
  console.log(`  Total reviews in reviews.json: ${reviews.length}`);

  if (CONFIG.outletFilter.length > 0) {
    console.log(`  Outlet filter: ${CONFIG.outletFilter.join(', ')}`);
  }

  let created = 0, skippedExists = 0, skippedFiltered = 0;
  const byOutlet = {};

  for (const review of reviews) {
    if (!review.showId) continue;

    // Apply outlet filter
    const outletId = (review.outletId || '').toLowerCase();
    const outlet = (review.outlet || '').toLowerCase();
    if (CONFIG.outletFilter.length > 0) {
      const matches = CONFIG.outletFilter.some(f =>
        outletId.includes(f) || outlet.includes(f)
      );
      if (!matches) { skippedFiltered++; continue; }
    }

    // Generate file path
    const filename = generateReviewFilename(review.outlet || review.outletId, review.criticName);
    const showDir = path.join(CONFIG.reviewTextsDir, review.showId);
    const filePath = path.join(showDir, filename);

    // Skip if file already exists
    if (fs.existsSync(filePath)) { skippedExists++; continue; }

    // Check limit
    if (created >= CONFIG.maxStubs) break;

    // Determine incomplete reason
    let incompleteReason = 'no_text';
    if (!review.url) incompleteReason = 'no_url';

    const stub = {
      showId: review.showId,
      outlet: review.outlet || null,
      outletId: review.outletId || null,
      criticName: review.criticName || null,
      url: review.url || null,
      publishDate: review.publishDate || null,
      source: 'stub-from-reviews-json',
      incompleteReason,
      fullText: '',
      contentTier: 'stub',
      createdAt: new Date().toISOString(),
    };

    if (CONFIG.dryRun) {
      console.log(`  [DRY] Would create: ${review.showId}/${filename}`);
    } else {
      if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(stub, null, 2) + '\n');
    }

    created++;
    const key = review.outlet || review.outletId || 'unknown';
    byOutlet[key] = (byOutlet[key] || 0) + 1;
  }

  console.log(`\n  Created: ${created} stub files`);
  console.log(`  Skipped (exists): ${skippedExists}`);
  console.log(`  Skipped (filtered): ${skippedFiltered}`);
  console.log('\n  By outlet:');
  Object.entries(byOutlet).sort((a, b) => b[1] - a[1]).forEach(([o, c]) => {
    console.log(`    ${o}: ${c}`);
  });

  if (CONFIG.dryRun) console.log('\n  *** DRY RUN — no files written ***');
}

main();
