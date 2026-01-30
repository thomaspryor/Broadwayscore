#!/usr/bin/env node
/**
 * Audit text quality across all reviews
 * Used by CI to ensure data quality standards
 *
 * Exit codes:
 *   0 = Pass (all thresholds met)
 *   1 = Fail (thresholds not met)
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';

// Quality thresholds (can be adjusted)
const THRESHOLDS = {
  minFullPercent: 35,       // At least 35% should be "full" quality
  maxTruncatedPercent: 40,  // No more than 40% should be truncated
  maxUnknownPercent: 5,     // No more than 5% should have unknown quality
};

function auditTextQuality() {
  const stats = {
    total: 0,
    hasFullText: 0,
    byQuality: {},
    truncationSignals: {},
  };

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        stats.total++;

        if (data.fullText) {
          stats.hasFullText++;
          const quality = data.textQuality || 'unknown';
          stats.byQuality[quality] = (stats.byQuality[quality] || 0) + 1;

          if (data.truncationSignals) {
            for (const signal of data.truncationSignals) {
              stats.truncationSignals[signal] = (stats.truncationSignals[signal] || 0) + 1;
            }
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  // Calculate percentages
  const fullCount = stats.byQuality.full || 0;
  const truncatedCount = stats.byQuality.truncated || 0;
  const unknownCount = stats.byQuality.unknown || 0;
  const total = stats.hasFullText || 1;

  const fullPercent = (fullCount / total * 100).toFixed(1);
  const truncatedPercent = (truncatedCount / total * 100).toFixed(1);
  const unknownPercent = (unknownCount / total * 100).toFixed(1);

  // Output results
  console.log('=== TEXT QUALITY AUDIT ===\n');
  console.log(`Total reviews: ${stats.total}`);
  console.log(`Has fullText: ${stats.hasFullText}\n`);

  console.log('--- Quality Breakdown ---');
  Object.entries(stats.byQuality)
    .sort((a, b) => b[1] - a[1])
    .forEach(([quality, count]) => {
      const pct = (count / total * 100).toFixed(1);
      console.log(`  ${quality}: ${count} (${pct}%)`);
    });

  console.log('\n--- Truncation Signals ---');
  Object.entries(stats.truncationSignals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([signal, count]) => {
      console.log(`  ${signal}: ${count}`);
    });

  // Check thresholds
  console.log('\n--- Threshold Checks ---');
  const failures = [];

  if (parseFloat(fullPercent) < THRESHOLDS.minFullPercent) {
    failures.push(`Full reviews ${fullPercent}% < ${THRESHOLDS.minFullPercent}% threshold`);
    console.log(`  ❌ Full: ${fullPercent}% (min: ${THRESHOLDS.minFullPercent}%)`);
  } else {
    console.log(`  ✅ Full: ${fullPercent}% (min: ${THRESHOLDS.minFullPercent}%)`);
  }

  if (parseFloat(truncatedPercent) > THRESHOLDS.maxTruncatedPercent) {
    failures.push(`Truncated reviews ${truncatedPercent}% > ${THRESHOLDS.maxTruncatedPercent}% threshold`);
    console.log(`  ❌ Truncated: ${truncatedPercent}% (max: ${THRESHOLDS.maxTruncatedPercent}%)`);
  } else {
    console.log(`  ✅ Truncated: ${truncatedPercent}% (max: ${THRESHOLDS.maxTruncatedPercent}%)`);
  }

  if (parseFloat(unknownPercent) > THRESHOLDS.maxUnknownPercent) {
    failures.push(`Unknown quality ${unknownPercent}% > ${THRESHOLDS.maxUnknownPercent}% threshold`);
    console.log(`  ❌ Unknown: ${unknownPercent}% (max: ${THRESHOLDS.maxUnknownPercent}%)`);
  } else {
    console.log(`  ✅ Unknown: ${unknownPercent}% (max: ${THRESHOLDS.maxUnknownPercent}%)`);
  }

  // Exit with appropriate code
  if (failures.length > 0) {
    console.log('\n❌ AUDIT FAILED:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('\n✅ AUDIT PASSED');
    process.exit(0);
  }
}

auditTextQuality();
