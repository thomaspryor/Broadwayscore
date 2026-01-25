#!/usr/bin/env node

/**
 * Apply designations from data/designations.json to review files
 * Updates the 'designation' field in each matching review
 *
 * Usage:
 *   node scripts/apply-designations.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const reviewsDir = path.join(__dirname, '../data/review-texts');
const designationsFile = path.join(__dirname, '../data/designations.json');

const dryRun = process.argv.includes('--dry-run');

// Load designations
const designations = JSON.parse(fs.readFileSync(designationsFile, 'utf8'));

// Map outlet to designation source
const outletDesignationMap = {
  'nytimes': 'nyt_critics_pick',
  'timeout-ny': 'timeout_critics_choice',
  'guardian': 'guardian_picks',
};

// Also store star ratings when available
function updateReviewWithDesignation(review, showDesignation) {
  review.designation = showDesignation.designation;
  if (showDesignation.stars !== undefined && showDesignation.stars !== null) {
    review.originalScore = `${showDesignation.stars}/5`;
  }
  return review;
}

function main() {
  const shows = fs.readdirSync(reviewsDir).filter(f =>
    fs.statSync(path.join(reviewsDir, f)).isDirectory()
  );

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  console.log('Applying designations to review files...\n');
  if (dryRun) console.log('DRY RUN - no files will be modified\n');

  for (const show of shows) {
    const showDir = path.join(reviewsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const outletId = review.outletId;

      // Check if this outlet has a designation source
      const designationSource = outletDesignationMap[outletId];
      if (!designationSource) {
        continue; // This outlet doesn't have designation tracking
      }

      // Check if we have designation data for this show
      const sourceData = designations[designationSource];
      if (!sourceData || !sourceData[show]) {
        notFound++;
        continue;
      }

      const showDesignation = sourceData[show];

      // Skip if already has same designation
      if (review.designation === showDesignation.designation) {
        skipped++;
        continue;
      }

      // Apply designation
      review.designation = showDesignation.designation;

      if (!dryRun) {
        fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
      }

      const status = showDesignation.designation || 'none';
      console.log(`  ${show}/${file}: ${status}`);
      updated++;
    }
  }

  console.log('\n========================================');
  console.log(`Updated: ${updated}`);
  console.log(`Skipped (already set): ${skipped}`);
  console.log(`No designation data: ${notFound}`);
}

main();
