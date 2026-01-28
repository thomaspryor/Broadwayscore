#!/usr/bin/env node
/**
 * validate-aggregator-truth.js
 *
 * Validates local review counts against aggregator truth data.
 * Helps detect duplicate reviews or missing reviews by comparing
 * local counts to what aggregators report.
 *
 * Thresholds:
 * - WARN if localCount > maxAggregator * 1.5 (likely duplicates)
 * - WARN if localCount < maxAggregator * 0.7 (likely missing reviews)
 * - FAIL if localCount > maxAggregator * 2.0 (definite problem)
 *
 * Edge cases handled:
 * - New shows without aggregator data (ratio is null)
 * - Shows with maxAggregator of 0 (no aggregator coverage yet)
 * - Shows with no local reviews yet
 *
 * Usage: node scripts/validate-aggregator-truth.js [--strict]
 * Exit codes: 0 = OK or warnings only, 1 = Errors found
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AGGREGATOR_TRUTH_FILE = path.join(DATA_DIR, 'aggregator-truth.json');

const strictMode = process.argv.includes('--strict');

// Thresholds for validation
const THRESHOLDS = {
  WARN_DUPLICATE_RATIO: 1.5,   // localCount > maxAggregator * 1.5 = likely duplicates
  WARN_MISSING_RATIO: 0.7,    // localCount < maxAggregator * 0.7 = likely missing reviews
  FAIL_DUPLICATE_RATIO: 2.0,  // localCount > maxAggregator * 2.0 = definite problem
  MIN_AGGREGATOR_COUNT: 5,    // Only validate shows with at least this many aggregator reviews
};

// High-coverage shows that legitimately have 2x+ aggregator reviews
// These are Tony winners, blockbusters, or critically acclaimed shows with extensive coverage
// We collect from more sources than aggregators, so higher ratios are expected
const HIGH_COVERAGE_EXCEPTIONS = new Set([
  'stereophonic-2024',         // Tony Best Play 2024, extraordinary coverage
  'illinoise-2024',            // Tony Best Choreography 2024
  'an-enemy-of-the-people-2024', // Star-driven, Ivo van Hove, extensive coverage
  'suffs-2024',                // Tony Best Score 2024
  'hamilton-2015',             // Cultural phenomenon
  'hadestown-2019',            // Tony Best Musical 2019
]);

let errors = [];
let warnings = [];

function error(msg) {
  errors.push(msg);
  console.error(`\u274C ERROR: ${msg}`);
}

function warn(msg) {
  warnings.push(msg);
  console.warn(`\u26A0\uFE0F  WARNING: ${msg}`);
}

function ok(msg) {
  console.log(`\u2705 ${msg}`);
}

function info(msg) {
  console.log(`\u2139\uFE0F  ${msg}`);
}

/**
 * Validates aggregator truth data
 */
function validateAggregatorTruth() {
  console.log('='.repeat(60));
  console.log('AGGREGATOR TRUTH VALIDATION');
  console.log('='.repeat(60));
  console.log(`Mode: ${strictMode ? 'STRICT' : 'STANDARD'}`);
  console.log('');

  // Check if aggregator-truth.json exists
  if (!fs.existsSync(AGGREGATOR_TRUTH_FILE)) {
    info('aggregator-truth.json does not exist - skipping validation');
    info('Run scripts/generate-aggregator-truth.js to create it');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(AGGREGATOR_TRUTH_FILE, 'utf8'));
    ok(`Loaded aggregator-truth.json (generated: ${data._meta?.generatedAt || 'unknown'})`);
  } catch (e) {
    error(`aggregator-truth.json parse error: ${e.message}`);
    return;
  }

  const shows = data.shows || {};
  const showIds = Object.keys(shows);

  if (showIds.length === 0) {
    warn('No shows in aggregator-truth.json');
    return;
  }

  info(`Checking ${showIds.length} shows against aggregator data...`);
  console.log('');

  // Categorize shows by validation result
  const likelyDuplicates = [];    // ratio > 1.5
  const definiteDuplicates = [];  // ratio > 2.0
  const likelyMissing = [];       // ratio < 0.7
  const noAggregatorData = [];    // maxAggregator === 0 or ratio === null
  const healthy = [];             // within acceptable range

  for (const showId of showIds) {
    const show = shows[showId];
    const { maxAggregator, localCount, ratio } = show;

    // Skip shows without aggregator data (new shows, not yet indexed)
    if (ratio === null || maxAggregator === 0) {
      noAggregatorData.push({ showId, localCount, maxAggregator });
      continue;
    }

    // Skip shows with very few aggregator reviews (not enough data to validate)
    if (maxAggregator < THRESHOLDS.MIN_AGGREGATOR_COUNT) {
      // Still check for extreme duplicates though
      if (ratio > THRESHOLDS.FAIL_DUPLICATE_RATIO) {
        definiteDuplicates.push({ showId, localCount, maxAggregator, ratio });
      }
      continue;
    }

    // Check for definite duplicate problem (ratio > 2.0)
    if (ratio > THRESHOLDS.FAIL_DUPLICATE_RATIO) {
      // High-coverage exceptions are warnings, not errors
      if (HIGH_COVERAGE_EXCEPTIONS.has(showId)) {
        likelyDuplicates.push({ showId, localCount, maxAggregator, ratio, isException: true });
      } else {
        definiteDuplicates.push({ showId, localCount, maxAggregator, ratio });
      }
    }
    // Check for likely duplicates (ratio > 1.5)
    else if (ratio > THRESHOLDS.WARN_DUPLICATE_RATIO) {
      likelyDuplicates.push({ showId, localCount, maxAggregator, ratio });
    }
    // Check for likely missing reviews (ratio < 0.7)
    else if (ratio < THRESHOLDS.WARN_MISSING_RATIO) {
      likelyMissing.push({ showId, localCount, maxAggregator, ratio });
    }
    // Healthy show
    else {
      healthy.push({ showId, localCount, maxAggregator, ratio });
    }
  }

  // Report results
  console.log('-'.repeat(60));
  console.log('VALIDATION RESULTS');
  console.log('-'.repeat(60));
  console.log('');

  // Definite duplicates (ERRORS - these fail the build)
  if (definiteDuplicates.length > 0) {
    console.log(`\u274C DEFINITE DUPLICATE PROBLEMS (ratio > ${THRESHOLDS.FAIL_DUPLICATE_RATIO}):`);
    console.log('   These shows have more than 2x the reviews any aggregator reports.');
    console.log('   This almost certainly indicates duplicate reviews in the database.');
    console.log('');
    for (const show of definiteDuplicates.sort((a, b) => b.ratio - a.ratio)) {
      error(`${show.showId}: ${show.localCount} local vs ${show.maxAggregator} aggregator (${show.ratio.toFixed(2)}x)`);
    }
    console.log('');
  }

  // Likely duplicates (WARNINGS)
  if (likelyDuplicates.length > 0) {
    console.log(`\u26A0\uFE0F  LIKELY DUPLICATES (ratio > ${THRESHOLDS.WARN_DUPLICATE_RATIO}):`);
    console.log('   These shows may have duplicate reviews. Please investigate.');
    console.log('');
    for (const show of likelyDuplicates.sort((a, b) => b.ratio - a.ratio)) {
      warn(`${show.showId}: ${show.localCount} local vs ${show.maxAggregator} aggregator (${show.ratio.toFixed(2)}x)`);
    }
    console.log('');
  }

  // Likely missing reviews (WARNINGS)
  if (likelyMissing.length > 0) {
    console.log(`\u26A0\uFE0F  LIKELY MISSING REVIEWS (ratio < ${THRESHOLDS.WARN_MISSING_RATIO}):`);
    console.log('   These shows may be missing reviews. Consider running gather-reviews.');
    console.log('');
    for (const show of likelyMissing.sort((a, b) => a.ratio - b.ratio)) {
      warn(`${show.showId}: ${show.localCount} local vs ${show.maxAggregator} aggregator (${show.ratio.toFixed(2)}x)`);
    }
    console.log('');
  }

  // No aggregator data (INFO only)
  if (noAggregatorData.length > 0) {
    console.log(`\u2139\uFE0F  SHOWS WITHOUT AGGREGATOR DATA (${noAggregatorData.length} shows):`);
    console.log('   These are new/upcoming shows or shows not yet indexed by aggregators.');
    console.log('   This is expected and not an error.');
    if (noAggregatorData.length <= 10) {
      for (const show of noAggregatorData) {
        console.log(`   - ${show.showId} (${show.localCount} local reviews)`);
      }
    } else {
      console.log(`   First 10: ${noAggregatorData.slice(0, 10).map(s => s.showId).join(', ')}`);
      console.log(`   ...and ${noAggregatorData.length - 10} more`);
    }
    console.log('');
  }

  // Summary
  console.log('-'.repeat(60));
  console.log('SUMMARY');
  console.log('-'.repeat(60));
  console.log(`Total shows: ${showIds.length}`);
  console.log(`  \u2705 Healthy: ${healthy.length}`);
  console.log(`  \u26A0\uFE0F  Likely duplicates: ${likelyDuplicates.length}`);
  console.log(`  \u274C Definite duplicates: ${definiteDuplicates.length}`);
  console.log(`  \u26A0\uFE0F  Likely missing: ${likelyMissing.length}`);
  console.log(`  \u2139\uFE0F  No aggregator data: ${noAggregatorData.length}`);
  console.log('');
}

/**
 * Main entry point
 */
function main() {
  validateAggregatorTruth();

  // Final result
  console.log('='.repeat(60));
  console.log('VALIDATION RESULT');
  console.log('='.repeat(60));

  if (errors.length > 0) {
    console.log(`\n\u274C FAILED: ${errors.length} error(s) found\n`);
    console.log('Shows with definite duplicate problems need investigation.');
    console.log('Run: node scripts/audit-scores.js to find duplicates');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`\n\u26A0\uFE0F  PASSED WITH ${warnings.length} WARNING(S)\n`);
    console.log('Warnings indicate potential issues but are not blocking.');
  } else {
    console.log('\n\u2705 ALL VALIDATIONS PASSED\n');
  }

  process.exit(0);
}

main();
