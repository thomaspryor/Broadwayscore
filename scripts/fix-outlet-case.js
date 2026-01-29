#!/usr/bin/env node
/**
 * Fix Outlet ID Case Sensitivity Issues
 *
 * This script:
 * 1. Finds all review files with uppercase outletId values
 * 2. Updates the outletId to lowercase using normalizeOutlet()
 * 3. Renames files if needed to match the lowercase outletId
 * 4. Merges duplicates if a lowercase version already exists
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, getOutletDisplayName, mergeReviews, slugify } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Track stats
let filesFixed = 0;
let filesMerged = 0;
let filesRenamed = 0;
let errors = 0;

function processReviewFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const review = JSON.parse(content);

    // Check if outletId has uppercase letters
    if (!review.outletId || review.outletId === review.outletId.toLowerCase()) {
      return false; // Already lowercase or no outletId
    }

    const oldOutletId = review.outletId;
    const newOutletId = normalizeOutlet(review.outlet || review.outletId);

    // Update the review data
    review.outletId = newOutletId;
    review.outlet = getOutletDisplayName(newOutletId);

    // Determine old and new filenames
    const dir = path.dirname(filepath);
    const oldFilename = path.basename(filepath);
    const criticSlug = slugify(review.criticName || 'unknown');
    const newFilename = `${newOutletId}--${criticSlug}.json`;
    const newFilepath = path.join(dir, newFilename);

    // Check if a file with the new (lowercase) name already exists
    if (oldFilename !== newFilename && fs.existsSync(newFilepath)) {
      // Merge with existing file
      const existingContent = fs.readFileSync(newFilepath, 'utf8');
      const existingReview = JSON.parse(existingContent);

      const merged = mergeReviews(existingReview, review);
      fs.writeFileSync(newFilepath, JSON.stringify(merged, null, 2));

      // Delete the old (uppercase) file
      fs.unlinkSync(filepath);

      console.log(`MERGED: ${oldFilename} -> ${newFilename} (${oldOutletId} -> ${newOutletId})`);
      filesMerged++;
      return true;
    }

    // Save updated review
    fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
    filesFixed++;

    // Rename file if needed
    if (oldFilename !== newFilename) {
      fs.renameSync(filepath, newFilepath);
      console.log(`RENAMED: ${oldFilename} -> ${newFilename} (${oldOutletId} -> ${newOutletId})`);
      filesRenamed++;
    } else {
      console.log(`FIXED: ${oldFilename} (${oldOutletId} -> ${newOutletId})`);
    }

    return true;
  } catch (err) {
    console.error(`ERROR processing ${filepath}: ${err.message}`);
    errors++;
    return false;
  }
}

function main() {
  console.log('=== Fix Outlet ID Case Sensitivity ===\n');

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  console.log(`Processing ${showDirs.length} show directories...\n`);

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const filepath = path.join(showPath, file);
      processReviewFile(filepath);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Files with outletId fixed: ${filesFixed}`);
  console.log(`Files renamed: ${filesRenamed}`);
  console.log(`Files merged (duplicates): ${filesMerged}`);
  console.log(`Errors: ${errors}`);

  if (filesFixed > 0 || filesMerged > 0) {
    console.log('\nNote: Run `node scripts/rebuild-all-reviews.js` to update reviews.json');
  }
}

main();
