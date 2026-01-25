#!/usr/bin/env node

/**
 * Merge BWW Review Roundup excerpts into existing review files
 *
 * This script:
 * 1. Runs extract-bww-reviews.js to get BWW data
 * 2. Matches BWW reviews to existing review files by outlet/critic
 * 3. Adds bwwExcerpt field to matching files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');

// Normalize outlet names for matching
function normalizeOutlet(outlet) {
  if (!outlet) return '';
  return outlet
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// Normalize critic names for matching
function normalizeCritic(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Get all review files for a show
function getReviewFiles(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return [];

  return fs.readdirSync(showDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      filename: f,
      filepath: path.join(showDir, f),
      data: JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'))
    }));
}

// Match BWW review to existing review file
function findMatchingReviewFile(bwwReview, reviewFiles) {
  const bwwOutlet = normalizeOutlet(bwwReview.outlet);
  const bwwCritic = normalizeCritic(bwwReview.criticName);

  for (const file of reviewFiles) {
    const fileOutlet = normalizeOutlet(file.data.outlet);
    const fileCritic = normalizeCritic(file.data.criticName);

    // Match by outlet (fuzzy)
    const outletMatch = bwwOutlet.includes(fileOutlet) || fileOutlet.includes(bwwOutlet) ||
                        bwwReview.outletId === file.data.outletId;

    if (!outletMatch) continue;

    // If critic names available, check they match
    if (bwwCritic && fileCritic) {
      if (bwwCritic.includes(fileCritic) || fileCritic.includes(bwwCritic)) {
        return file;
      }
    } else if (outletMatch) {
      // No critic to match, use outlet match
      return file;
    }
  }

  return null;
}

// Main
function main() {
  console.log('Extracting BWW reviews...');

  // Run extract script and capture output
  let bwwReviews;
  try {
    const output = execSync('node scripts/extract-bww-reviews.js 2>/dev/null', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    bwwReviews = JSON.parse(output);
  } catch (e) {
    console.error('Failed to extract BWW reviews:', e.message);
    process.exit(1);
  }

  console.log(`Extracted ${bwwReviews.length} BWW reviews\n`);

  const stats = {
    matched: 0,
    added: 0,
    skipped: 0,
    noMatch: 0
  };

  // Group by show
  const byShow = {};
  for (const review of bwwReviews) {
    if (!byShow[review.showId]) byShow[review.showId] = [];
    byShow[review.showId].push(review);
  }

  for (const showId of Object.keys(byShow).sort()) {
    const showReviews = byShow[showId];
    const existingFiles = getReviewFiles(showId);

    if (existingFiles.length === 0) {
      console.log(`${showId}: No existing review files`);
      stats.noMatch += showReviews.length;
      continue;
    }

    let showAdded = 0;

    for (const bwwReview of showReviews) {
      const match = findMatchingReviewFile(bwwReview, existingFiles);

      if (match) {
        stats.matched++;

        // Check if bwwExcerpt already exists
        if (match.data.bwwExcerpt) {
          stats.skipped++;
          continue;
        }

        // Add bwwExcerpt from pullQuote
        const excerpt = bwwReview.pullQuote || bwwReview.fullText;
        if (excerpt) {
          match.data.bwwExcerpt = excerpt;
          fs.writeFileSync(match.filepath, JSON.stringify(match.data, null, 2) + '\n');
          stats.added++;
          showAdded++;
        }
      } else {
        stats.noMatch++;
      }
    }

    if (showAdded > 0) {
      console.log(`${showId}: Added ${showAdded} BWW excerpts`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`BWW reviews matched: ${stats.matched}`);
  console.log(`Excerpts added: ${stats.added}`);
  console.log(`Already had excerpt: ${stats.skipped}`);
  console.log(`No matching file: ${stats.noMatch}`);
}

main();
