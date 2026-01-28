#!/usr/bin/env node
/**
 * Fix Wrong-Production Reviews
 *
 * Flags reviews that are from wrong productions (e.g., off-Broadway runs
 * incorrectly filed under Broadway show directories) with wrongProduction: true
 *
 * Usage:
 *   node scripts/fix-wrong-production-reviews.js --dry-run  # Preview changes
 *   node scripts/fix-wrong-production-reviews.js            # Apply changes
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const AUDIT_REPORT_PATH = path.join(__dirname, '..', 'data', 'audit', 'wrong-production-reviews.json');

const dryRun = process.argv.includes('--dry-run');

function main() {
  console.log('=== Fix Wrong-Production Reviews ===\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  // Load the audit report
  if (!fs.existsSync(AUDIT_REPORT_PATH)) {
    console.error('Error: Audit report not found. Run audit-wrong-production-reviews.js first.');
    process.exit(1);
  }

  const auditReport = JSON.parse(fs.readFileSync(AUDIT_REPORT_PATH, 'utf8'));
  const flaggedReviews = auditReport.flagged || [];

  console.log(`Found ${flaggedReviews.length} flagged reviews in audit report\n`);

  // Filter to only true positives (high/medium confidence, not comparison mentions)
  // We'll flag reviews that have:
  // - Date/URL year mismatch (HIGH confidence)
  // - Multiple wrong indicators without expected indicators
  const reviewsToFlag = flaggedReviews.filter(review => {
    // High confidence: date/URL mismatch
    if (review.isDateMismatch) return true;

    // Medium+ confidence: has wrong indicators and confidence is not "low"
    if (review.confidence !== 'low' && review.indicators_found && review.indicators_found.length > 0) {
      // Check if it also has expected indicators (suggests it's comparing, not wrong)
      const expectedCount = review.expected_found ? review.expected_found.length : 0;
      const wrongCount = review.indicators_found.length;

      // If more wrong indicators than expected, likely wrong production
      // If roughly equal, could be a comparison - be conservative
      if (wrongCount > expectedCount || expectedCount === 0) {
        return true;
      }
    }

    return false;
  });

  console.log(`Filtering to ${reviewsToFlag.length} reviews to flag (excluding likely comparisons)\n`);

  let flaggedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const changesByShow = {};

  for (const review of reviewsToFlag) {
    const filePath = path.join(REVIEW_TEXTS_DIR, review.showId, review.file);

    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP: File not found: ${review.showId}/${review.file}`);
      skippedCount++;
      continue;
    }

    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip if already flagged
      if (content.wrongProduction === true) {
        skippedCount++;
        continue;
      }

      // Add the flag and metadata
      content.wrongProduction = true;
      content.wrongProductionReason = review.indicators_found.join(', ');
      content.wrongProductionConfidence = review.confidence;
      if (review.isDateMismatch) {
        content.wrongProductionReason = 'Date/URL year mismatch: ' + content.wrongProductionReason;
      }

      if (dryRun) {
        console.log(`  WOULD FLAG: ${review.showId}/${review.file}`);
        console.log(`              Reason: ${content.wrongProductionReason}`);
      } else {
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
        console.log(`  FLAGGED: ${review.showId}/${review.file}`);
      }

      flaggedCount++;

      // Track by show
      if (!changesByShow[review.showId]) {
        changesByShow[review.showId] = 0;
      }
      changesByShow[review.showId]++;

    } catch (err) {
      console.error(`  ERROR: ${review.showId}/${review.file}: ${err.message}`);
      errorCount++;
    }
  }

  console.log('\n=== Summary ===\n');
  console.log(`Reviews flagged: ${flaggedCount}`);
  console.log(`Skipped (not found or already flagged): ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);

  console.log('\nChanges by show:');
  const sortedShows = Object.entries(changesByShow)
    .sort((a, b) => b[1] - a[1]);
  for (const [show, count] of sortedShows) {
    console.log(`  ${show}: ${count} reviews`);
  }

  if (dryRun) {
    console.log('\n--- DRY RUN COMPLETE ---');
    console.log('Run without --dry-run to apply changes.');
  } else {
    console.log('\n--- CHANGES APPLIED ---');
    console.log('Reviews now have wrongProduction: true');
    console.log('These reviews will be excluded from scoring.');
  }

  return errorCount === 0;
}

if (require.main === module) {
  const success = main();
  process.exit(success ? 0 : 1);
}

module.exports = { main };
