#!/usr/bin/env node
/**
 * Cleanup Duplicate Reviews
 *
 * Scans all review-texts directories, identifies duplicates using normalized
 * outlet/critic names, merges their data, and consolidates to single files.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-reviews.js [--dry-run] [--show=show-id]
 *
 * Options:
 *   --dry-run   Show what would be done without making changes
 *   --show=X    Only process specific show
 *   --verbose   Show detailed output
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  generateReviewKey,
  mergeReviews,
  getOutletDisplayName,
} = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Parse command line args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Stats
const stats = {
  showsProcessed: 0,
  filesScanned: 0,
  duplicatesFound: 0,
  filesMerged: 0,
  filesDeleted: 0,
  filesRenamed: 0,
  errors: [],
};

/**
 * Process a single show directory
 */
function processShow(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);

  if (!fs.existsSync(showDir)) {
    console.log(`  ⚠ Show directory not found: ${showId}`);
    return;
  }

  const files = fs.readdirSync(showDir)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  if (files.length === 0) {
    return;
  }

  stats.filesScanned += files.length;

  // Group files by normalized key
  const reviewGroups = new Map();

  for (const file of files) {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const key = generateReviewKey(data.outlet, data.criticName);
      const canonicalFilename = generateReviewFilename(data.outlet, data.criticName);

      if (!reviewGroups.has(key)) {
        reviewGroups.set(key, {
          key,
          canonicalFilename,
          files: [],
          reviews: [],
        });
      }

      reviewGroups.get(key).files.push(file);
      reviewGroups.get(key).reviews.push(data);

    } catch (err) {
      stats.errors.push(`Error reading ${showId}/${file}: ${err.message}`);
    }
  }

  // Process each group
  let showDuplicates = 0;
  let showMerged = 0;
  let showDeleted = 0;
  let showRenamed = 0;

  for (const [key, group] of reviewGroups) {
    if (group.files.length > 1) {
      // Found duplicates!
      showDuplicates += group.files.length - 1;
      stats.duplicatesFound += group.files.length - 1;

      if (verbose) {
        console.log(`  Duplicates for ${key}:`);
        group.files.forEach(f => console.log(`    - ${f}`));
      }

      // Merge all reviews into one
      let mergedReview = group.reviews[0];
      for (let i = 1; i < group.reviews.length; i++) {
        mergedReview = mergeReviews(mergedReview, group.reviews[i]);
      }

      // Normalize the outlet and critic names in the merged review
      mergedReview.outletId = normalizeOutlet(mergedReview.outlet);
      mergedReview.outlet = getOutletDisplayName(mergedReview.outletId);

      const canonicalPath = path.join(showDir, group.canonicalFilename);

      if (!dryRun) {
        // Write merged review to canonical filename
        fs.writeFileSync(canonicalPath, JSON.stringify(mergedReview, null, 2));
        showMerged++;
        stats.filesMerged++;

        // Delete all other files
        for (const file of group.files) {
          const filePath = path.join(showDir, file);
          if (file !== group.canonicalFilename && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            showDeleted++;
            stats.filesDeleted++;
          }
        }
      }

    } else if (group.files.length === 1) {
      // Single file - check if it needs renaming
      const currentFile = group.files[0];
      const canonicalFilename = group.canonicalFilename;

      if (currentFile !== canonicalFilename) {
        if (verbose) {
          console.log(`  Rename: ${currentFile} → ${canonicalFilename}`);
        }

        if (!dryRun) {
          const currentPath = path.join(showDir, currentFile);
          const canonicalPath = path.join(showDir, canonicalFilename);

          // Update the review data with normalized names
          const data = group.reviews[0];
          data.outletId = normalizeOutlet(data.outlet);
          data.outlet = getOutletDisplayName(data.outletId);

          // Write to canonical filename
          fs.writeFileSync(canonicalPath, JSON.stringify(data, null, 2));

          // Delete old file if different
          if (currentFile !== canonicalFilename && fs.existsSync(currentPath)) {
            fs.unlinkSync(currentPath);
          }

          showRenamed++;
          stats.filesRenamed++;
        }
      }
    }
  }

  const uniqueReviews = reviewGroups.size;
  if (showDuplicates > 0 || verbose) {
    console.log(`  ${showId}: ${files.length} files → ${uniqueReviews} unique (${showDuplicates} duplicates merged)`);
  }

  stats.showsProcessed++;
}

/**
 * Main function
 */
function main() {
  console.log('=== CLEANUP DUPLICATE REVIEWS ===');
  console.log(dryRun ? '(DRY RUN - no changes will be made)\n' : '\n');

  // Get list of shows to process
  let shows;
  if (showFilter) {
    shows = [showFilter];
    console.log(`Processing single show: ${showFilter}\n`);
  } else {
    shows = fs.readdirSync(REVIEW_TEXTS_DIR)
      .filter(f => {
        const fullPath = path.join(REVIEW_TEXTS_DIR, f);
        return fs.statSync(fullPath).isDirectory();
      });
    console.log(`Processing ${shows.length} shows...\n`);
  }

  // Process each show
  for (const show of shows) {
    processShow(show);
  }

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Shows processed: ${stats.showsProcessed}`);
  console.log(`Files scanned: ${stats.filesScanned}`);
  console.log(`Duplicates found: ${stats.duplicatesFound}`);
  if (!dryRun) {
    console.log(`Files merged: ${stats.filesMerged}`);
    console.log(`Files deleted: ${stats.filesDeleted}`);
    console.log(`Files renamed: ${stats.filesRenamed}`);
  }

  if (stats.errors.length > 0) {
    console.log(`\nErrors (${stats.errors.length}):`);
    stats.errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
    if (stats.errors.length > 10) {
      console.log(`  ... and ${stats.errors.length - 10} more`);
    }
  }

  if (dryRun && stats.duplicatesFound > 0) {
    console.log('\nRun without --dry-run to apply changes.');
  }
}

main();
