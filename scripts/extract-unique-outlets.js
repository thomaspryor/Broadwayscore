#!/usr/bin/env node
/**
 * Extract all unique outlet IDs and display names from review data
 * Outputs to data/audit/unique-outlets.json
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'audit');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'unique-outlets.json');

function main() {
  // Track outlets: outletId -> { displayNames: Set, count: number }
  const outlets = {};
  let totalReviews = 0;
  let reviewsWithBadDisplayName = 0;

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    });

  console.log(`Found ${showDirs.length} show directories`);

  // Process each show directory
  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const reviewFiles = fs.readdirSync(showPath)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const reviewFile of reviewFiles) {
      const filePath = path.join(showPath, reviewFile);
      try {
        const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        totalReviews++;

        const outletId = review.outletId;
        const displayName = review.outlet;

        if (!outletId) {
          console.warn(`Missing outletId in ${filePath}`);
          continue;
        }

        if (!outlets[outletId]) {
          outlets[outletId] = {
            displayNames: new Set(),
            count: 0
          };
        }

        outlets[outletId].count++;
        if (displayName) {
          outlets[outletId].displayNames.add(displayName);
        }

        // Track bad display names (where outlet === outletId)
        if (displayName === outletId) {
          reviewsWithBadDisplayName++;
        }
      } catch (err) {
        console.error(`Error reading ${filePath}: ${err.message}`);
      }
    }
  }

  // Convert Sets to arrays and add flags
  const outletsArray = Object.entries(outlets).map(([outletId, data]) => {
    const displayNames = Array.from(data.displayNames);
    const hasBadDisplayName = displayNames.includes(outletId) || displayNames.length === 0;

    return {
      outletId,
      displayNames,
      count: data.count,
      hasBadDisplayName
    };
  });

  // Sort by count (most reviews first)
  outletsArray.sort((a, b) => b.count - a.count);

  // Convert back to object format for output
  const outletsObj = {};
  for (const item of outletsArray) {
    outletsObj[item.outletId] = {
      displayNames: item.displayNames,
      count: item.count,
      hasBadDisplayName: item.hasBadDisplayName
    };
  }

  // Find flagged outlets
  const flaggedOutlets = outletsArray.filter(o => o.hasBadDisplayName);

  // Create output
  const output = {
    timestamp: new Date().toISOString(),
    totalReviews,
    totalOutlets: outletsArray.length,
    reviewsWithBadDisplayName,
    flaggedOutlets: flaggedOutlets.map(o => o.outletId),
    outlets: outletsObj
  };

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nResults written to ${OUTPUT_FILE}`);

  // Print summary
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total reviews processed: ${totalReviews}`);
  console.log(`Unique outlets: ${outletsArray.length}`);
  console.log(`Reviews with bad display name (outlet === outletId): ${reviewsWithBadDisplayName}`);

  if (flaggedOutlets.length > 0) {
    console.log(`\n=== FLAGGED OUTLETS (bad display name) ===`);
    for (const outlet of flaggedOutlets) {
      console.log(`  ${outlet.outletId}: ${outlet.count} reviews, displayNames: ${JSON.stringify(outlet.displayNames)}`);
    }
  }

  console.log(`\n=== TOP 20 OUTLETS BY REVIEW COUNT ===`);
  for (const outlet of outletsArray.slice(0, 20)) {
    console.log(`  ${outlet.outletId}: ${outlet.count} reviews`);
  }
}

main();
