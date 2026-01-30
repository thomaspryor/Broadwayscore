#!/usr/bin/env node

/**
 * audit-data-quality.js
 *
 * Audits review data quality and outputs metrics as JSON.
 *
 * Usage:
 *   node scripts/audit-data-quality.js              # Output metrics to stdout
 *   node scripts/audit-data-quality.js --save-baseline  # Save current metrics as baseline
 *   node scripts/audit-data-quality.js --compare-to <file>  # Compare to baseline file
 *   node scripts/audit-data-quality.js --help       # Show help
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);

function showHelp() {
  console.log(`
audit-data-quality.js - Audit review data quality metrics

Usage:
  node scripts/audit-data-quality.js [options]

Options:
  --help              Show this help message
  --save-baseline     Save current metrics to data/audit/baseline.json
  --compare-to <file> Compare current metrics to a baseline file

Output:
  JSON object with the following metrics:
  - duplicates: Number of duplicate review files detected
  - nullCritics: Reviews with missing critic names
  - nullDates: Reviews with missing publish dates
  - unknownOutlets: Reviews with unrecognized outlet IDs
  - badDisplayNames: Reviews with malformed display names

Examples:
  node scripts/audit-data-quality.js
  node scripts/audit-data-quality.js --save-baseline
  node scripts/audit-data-quality.js --compare-to data/audit/baseline.json
`);
}

function collectMetrics() {
  const reviewsPath = path.join(__dirname, '..', 'data', 'reviews.json');

  // Initialize results
  const result = {
    timestamp: new Date().toISOString(),
    metrics: {
      duplicates: 0,
      nullCritics: 0,
      nullDates: 0,
      unknownOutlets: 0,
      badDisplayNames: 0
    },
    details: {
      duplicates: [],
      nullCritics: [],
      nullDates: [],
      unknownOutlets: [],
      badDisplayNames: []
    }
  };

  // Load reviews.json
  if (!fs.existsSync(reviewsPath)) {
    console.error('Warning: reviews.json not found at', reviewsPath);
    return result;
  }

  const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = reviewsData.reviews || [];

  // Count duplicates: reviews with same showId + outletId + criticName (case-insensitive)
  const seen = new Map(); // key -> first occurrence
  const duplicates = [];

  for (const review of reviews) {
    const showId = (review.showId || '').toLowerCase();
    const outletId = (review.outletId || '').toLowerCase();
    const criticName = (review.criticName || '').toLowerCase();

    const key = `${showId}|${outletId}|${criticName}`;

    if (seen.has(key)) {
      // This is a duplicate
      duplicates.push({
        showId: review.showId,
        outletId: review.outletId,
        criticName: review.criticName
      });
    } else {
      seen.set(key, {
        showId: review.showId,
        outletId: review.outletId,
        criticName: review.criticName
      });
    }
  }

  result.metrics.duplicates = duplicates.length;
  result.details.duplicates = duplicates;

  // Check for unknown outlets and bad display names in review-texts directory
  const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

  // Track bad display names grouped by outlet for easier analysis
  const badDisplayNamesByOutlet = {};

  if (fs.existsSync(reviewTextsDir)) {
    const showDirs = fs.readdirSync(reviewTextsDir)
      .filter(f => {
        const fullPath = path.join(reviewTextsDir, f);
        return fs.statSync(fullPath).isDirectory();
      });

    for (const showDir of showDirs) {
      const showPath = path.join(reviewTextsDir, showDir);
      const reviewFiles = fs.readdirSync(showPath)
        .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

      for (const reviewFile of reviewFiles) {
        const filePath = path.join(showPath, reviewFile);
        try {
          const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

          // Check for null, undefined, or empty critic names
          if (
            review.criticName === null ||
            review.criticName === undefined ||
            review.criticName === ''
          ) {
            result.metrics.nullCritics++;
            result.details.nullCritics.push({
              showId: showDir,
              outletId: review.outletId || 'unknown',
              file: reviewFile,
              filePath: `data/review-texts/${showDir}/${reviewFile}`
            });
          }

          // Check for unknown outlets (outletId is "unknown" OR outlet is "Unknown"/"unknown")
          const hasUnknownOutletId = review.outletId === 'unknown';
          const hasUnknownOutletName = review.outlet === 'Unknown' || review.outlet === 'unknown';

          if (hasUnknownOutletId || hasUnknownOutletName) {
            result.metrics.unknownOutlets++;
            result.details.unknownOutlets.push({
              file: `${showDir}/${reviewFile}`,
              outletId: review.outletId,
              outlet: review.outlet,
              criticName: review.criticName,
              url: review.url
            });
          }

          // Check for null/undefined publishDate
          // EXCLUDE reviews that have dateUnknown: true (intentionally unknown)
          if ((review.publishDate === null || review.publishDate === undefined) &&
              !review.dateUnknown) {
            result.metrics.nullDates++;
            result.details.nullDates.push({
              showId: showDir,
              file: reviewFile,
              outlet: review.outlet || review.outletId,
              critic: review.criticName
            });
          }

          // Check for bad display names (outlet equals outletId - display name not set properly)
          if (review.outlet && review.outletId && review.outlet === review.outletId) {
            result.metrics.badDisplayNames++;

            // Group by outlet for easier analysis
            if (!badDisplayNamesByOutlet[review.outletId]) {
              badDisplayNamesByOutlet[review.outletId] = {
                outlet: review.outletId,
                count: 0,
                reviews: []
              };
            }
            badDisplayNamesByOutlet[review.outletId].count++;
            badDisplayNamesByOutlet[review.outletId].reviews.push({
              show: showDir,
              file: reviewFile,
              critic: review.criticName || null
            });
          }
        } catch (err) {
          // Skip files that can't be parsed
        }
      }
    }
  }

  // Convert badDisplayNamesByOutlet to sorted array for details
  result.details.badDisplayNames = Object.values(badDisplayNamesByOutlet)
    .sort((a, b) => b.count - a.count);

  return result;
}

function saveBaseline(metrics) {
  const auditDir = path.join(__dirname, '..', 'data', 'audit');

  // Ensure audit directory exists
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  const baselinePath = path.join(auditDir, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify(metrics, null, 2));
  console.error(`Baseline saved to ${baselinePath}`);
}

function compareToBaseline(currentMetrics, baselineFile) {
  if (!fs.existsSync(baselineFile)) {
    console.error(`Error: Baseline file not found: ${baselineFile}`);
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));

  const comparison = {
    timestamp: currentMetrics.timestamp,
    baselineTimestamp: baseline.timestamp,
    current: currentMetrics.metrics,
    baseline: baseline.metrics,
    changes: {}
  };

  // Calculate changes
  for (const key of Object.keys(currentMetrics.metrics)) {
    const current = currentMetrics.metrics[key];
    const base = baseline.metrics[key] || 0;
    comparison.changes[key] = {
      current,
      baseline: base,
      delta: current - base,
      improved: current < base
    };
  }

  return comparison;
}

// Main execution
if (args.includes('--help') || args.includes('-h')) {
  showHelp();
  process.exit(0);
}

const metrics = collectMetrics();

if (args.includes('--save-baseline')) {
  saveBaseline(metrics);
  // Also output the metrics
  console.log(JSON.stringify(metrics, null, 2));
} else if (args.includes('--compare-to')) {
  const compareIndex = args.indexOf('--compare-to');
  const baselineFile = args[compareIndex + 1];

  if (!baselineFile) {
    console.error('Error: --compare-to requires a file path argument');
    process.exit(1);
  }

  const comparison = compareToBaseline(metrics, baselineFile);
  console.log(JSON.stringify(comparison, null, 2));
} else {
  // Default: output metrics to stdout
  console.log(JSON.stringify(metrics, null, 2));
}
