#!/usr/bin/env node

/**
 * Sync review-texts directory with reviews.json
 * Identifies missing review files and optionally creates stubs
 *
 * Usage:
 *   node scripts/sync-review-texts.js [--create-stubs] [--show=showId]
 */

const fs = require('fs');
const path = require('path');

const reviewsFile = path.join(__dirname, '../data/reviews.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts');

const args = process.argv.slice(2);
const createStubs = args.includes('--create-stubs');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Load reviews.json
const reviewsData = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
const reviews = reviewsData.reviews || reviewsData;

// Build a map of existing review-text files
const existingFiles = new Set();
const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
  fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
);

for (const showDir of showDirs) {
  const files = fs.readdirSync(path.join(reviewTextsDir, showDir))
    .filter(f => f.endsWith('.json'));
  for (const file of files) {
    // Key format: showId/outletId--criticName
    existingFiles.add(`${showDir}/${file.replace('.json', '')}`);
  }
}

// Helper to create filename from review
function makeFilename(review) {
  const outletId = review.outletId || review.outlet.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const criticName = (review.criticName || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `${outletId}--${criticName}`;
}

// Find missing reviews
const missing = [];
const byShow = {};

for (const review of reviews) {
  if (showFilter && review.showId !== showFilter) continue;

  const filename = makeFilename(review);
  const key = `${review.showId}/${filename}`;

  if (!existingFiles.has(key)) {
    missing.push({ review, key, filename });

    if (!byShow[review.showId]) byShow[review.showId] = [];
    byShow[review.showId].push(review);
  }
}

// Report
console.log('Review-texts sync report\n');
console.log(`Total reviews in reviews.json: ${reviews.length}`);
console.log(`Total files in review-texts/: ${existingFiles.size}`);
console.log(`Missing review-text files: ${missing.length}\n`);

// Show breakdown by show
const showIds = Object.keys(byShow).sort();
console.log('Missing by show:');
for (const showId of showIds) {
  const count = byShow[showId].length;
  const outlets = byShow[showId].map(r => r.outlet).join(', ');
  console.log(`  ${showId}: ${count} missing`);
  console.log(`    Outlets: ${outlets}`);
}

// Create stubs if requested
if (createStubs && missing.length > 0) {
  console.log('\nCreating stub files...\n');

  let created = 0;
  for (const { review, filename } of missing) {
    const showDir = path.join(reviewTextsDir, review.showId);

    // Create show directory if needed
    if (!fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }

    const filePath = path.join(showDir, `${filename}.json`);

    // Create stub with data from reviews.json
    const stub = {
      showId: review.showId,
      outletId: review.outletId || review.outlet.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
      outlet: review.outlet,
      criticName: review.criticName || null,
      url: review.url || null,
      publishDate: review.publishDate || null,
      fullText: null, // To be filled in
      originalScore: review.originalScore || null,
      assignedScore: review.assignedScore || null,
      source: 'reviews-json-stub',
      needsFullText: true
    };

    fs.writeFileSync(filePath, JSON.stringify(stub, null, 2));
    console.log(`  Created: ${review.showId}/${filename}.json`);
    created++;
  }

  console.log(`\nCreated ${created} stub files.`);
}

if (!createStubs && missing.length > 0) {
  console.log('\nRun with --create-stubs to create stub files for missing reviews.');
}
