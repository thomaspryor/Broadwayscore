#!/usr/bin/env node
/**
 * One-time backfill: stamp `classifiedAt` on all files that were already
 * processed by the initial non-review classification run.
 *
 * Reads data/audit/non-review-classification.json and stamps:
 * - nonReviews: already have isNonReview flag — just adds classifiedAt
 * - reviewsConfirmed: adds classifiedAt only (no other fields)
 *
 * After this runs, incremental mode will skip all ~8,900 already-classified files.
 *
 * Usage:
 *   node scripts/backfill-classified-at.js [--dry-run] [--verbose]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const REPORT_FILE = path.join(DATA_DIR, 'audit', 'non-review-classification.json');

if (!fs.existsSync(REPORT_FILE)) {
  console.error('Report not found:', REPORT_FILE);
  console.error('Run classify-non-reviews.js first to generate the report.');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const timestamp = report.meta?.generatedAt || new Date().toISOString();

console.log(`=== Backfill classifiedAt ===`);
console.log(`Report: ${REPORT_FILE}`);
console.log(`Timestamp: ${timestamp}`);
if (DRY_RUN) console.log('MODE: dry-run (no file writes)');

const nonReviews = report.nonReviews || [];
const reviewsConfirmed = report.reviewsConfirmed || [];

console.log(`Non-reviews to stamp: ${nonReviews.length}`);
console.log(`Confirmed reviews to stamp: ${reviewsConfirmed.length}`);
console.log(`Total: ${nonReviews.length + reviewsConfirmed.length}`);

let stamped = 0;
let skipped = 0;
let errors = 0;

// Stamp non-reviews
for (const nr of nonReviews) {
  const relPath = nr.file || nr;
  const fullPath = path.join(REVIEW_TEXTS_DIR, relPath);
  try {
    if (!fs.existsSync(fullPath)) {
      if (VERBOSE) console.log(`  SKIP (not found): ${relPath}`);
      skipped++;
      continue;
    }
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (data.classifiedAt) {
      if (VERBOSE) console.log(`  SKIP (already stamped): ${relPath}`);
      skipped++;
      continue;
    }
    if (!DRY_RUN) {
      data.classifiedAt = timestamp;
      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
    }
    stamped++;
    if (VERBOSE) console.log(`  STAMP (non-review): ${relPath}`);
  } catch (e) {
    errors++;
    console.log(`  ERROR: ${relPath}: ${e.message}`);
  }
}

// Stamp confirmed reviews
for (const relPath of reviewsConfirmed) {
  const fullPath = path.join(REVIEW_TEXTS_DIR, relPath);
  try {
    if (!fs.existsSync(fullPath)) {
      if (VERBOSE) console.log(`  SKIP (not found): ${relPath}`);
      skipped++;
      continue;
    }
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (data.classifiedAt) {
      if (VERBOSE) console.log(`  SKIP (already stamped): ${relPath}`);
      skipped++;
      continue;
    }
    if (!DRY_RUN) {
      data.classifiedAt = timestamp;
      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
    }
    stamped++;
    if (VERBOSE) console.log(`  STAMP (review): ${relPath}`);
  } catch (e) {
    errors++;
    console.log(`  ERROR: ${relPath}: ${e.message}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Stamped: ${stamped}`);
console.log(`Skipped: ${skipped}`);
console.log(`Errors: ${errors}`);
if (DRY_RUN) console.log('(dry-run — no files modified)');
