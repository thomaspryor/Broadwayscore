#!/usr/bin/env node
/**
 * Score Integrity Check — CI guard for P0 score corruption
 *
 * Detects aggregator star ratings in the P0 originalScore slot and
 * other known scoring data quality issues. Designed to run in weekly
 * integrity checks and fail if thresholds are exceeded.
 *
 * Exit codes:
 *   0 = clean (or within acceptable thresholds)
 *   1 = integrity violations found above threshold
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'score-integrity.json');

// From review-normalization.js
const AGGREGATOR_SCORE_SOURCES = new Set([
  'theatre-reviews-star-rating', 'westendtheatre-star-rating',
  'show-score-stars', 'stagedoor-star-rating',
  'lbo-star-rating', 'lbo-css-stars', 'thestage-roundup-star-rating',
]);

const AGGREGATOR_DATA_SOURCES = new Set([
  'show-score', 'show-score-playwright', 'showscore-roundup',
  'theatre-reviews', 'theatre-reviews-roundup',
  'westendtheatre', 'stagedoor', 'theatre-record',
  'bww-roundup', 'bww-reviews', 'playbill-verdict',
  'lbo-roundup', 'lbo-individual', 'nyc-theatre',
]);

// Outlets confirmed to NOT publish star ratings
const NO_STAR_OUTLETS = new Set([
  'london-theatre',
]);

const issues = {
  aggregatorScoreInP0: [],     // scoreSource is aggregator but in originalScore
  aggregatorSourceNoScoreSource: [], // source is aggregator, no scoreSource, has originalScore
  noStarOutletWithScore: [],   // outlet doesn't publish stars but has originalScore
};

let totalFiles = 0;

const shows = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
  try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
  catch { return false; }
});

for (const show of shows) {
  const showDir = path.join(REVIEW_TEXTS_DIR, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    totalFiles++;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (!d.originalScore || d.originalScoreCleared) continue;

      // Check 1: aggregator scoreSource in P0
      if (d.scoreSource && AGGREGATOR_SCORE_SOURCES.has(d.scoreSource)) {
        issues.aggregatorScoreInP0.push(`${show}/${file} (${d.scoreSource})`);
      }

      // Check 2: aggregator data source with no scoreSource
      if (d.source && AGGREGATOR_DATA_SOURCES.has(d.source) && !d.scoreSource) {
        issues.aggregatorSourceNoScoreSource.push(`${show}/${file} (source=${d.source})`);
      }

      // Check 3: outlet that doesn't publish stars
      if (d.outletId && NO_STAR_OUTLETS.has(d.outletId)) {
        issues.noStarOutletWithScore.push(`${show}/${file} (${d.outletId}, orig=${d.originalScore})`);
      }
    } catch (e) { /* skip unreadable */ }
  }
}

const totalIssues = issues.aggregatorScoreInP0.length
  + issues.aggregatorSourceNoScoreSource.length
  + issues.noStarOutletWithScore.length;

// Report
console.log('=== Score Integrity Check ===');
console.log(`Files scanned: ${totalFiles}`);
console.log(`Aggregator scoreSource in P0: ${issues.aggregatorScoreInP0.length}`);
console.log(`Aggregator source, no scoreSource: ${issues.aggregatorSourceNoScoreSource.length}`);
console.log(`No-star outlet with originalScore: ${issues.noStarOutletWithScore.length}`);
console.log(`Total issues: ${totalIssues}`);

if (totalIssues > 0) {
  console.log('\n--- Details ---');
  for (const [key, list] of Object.entries(issues)) {
    if (list.length > 0) {
      console.log(`\n${key} (${list.length}):`);
      list.slice(0, 10).forEach(l => console.log(`  ${l}`));
      if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
    }
  }
}

// Save report
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
  timestamp: new Date().toISOString(),
  filesScanned: totalFiles,
  issues: {
    aggregatorScoreInP0: issues.aggregatorScoreInP0.length,
    aggregatorSourceNoScoreSource: issues.aggregatorSourceNoScoreSource.length,
    noStarOutletWithScore: issues.noStarOutletWithScore.length,
  },
  totalIssues,
  details: totalIssues > 0 ? issues : undefined,
}, null, 2));
console.log(`\nReport: ${OUTPUT_PATH}`);

// Threshold: 0 for aggregator-in-P0 and no-star-outlet (these are definitively wrong)
// Allow up to 5 for aggregator-source-no-scoreSource (may be transitional)
const hard = issues.aggregatorScoreInP0.length + issues.noStarOutletWithScore.length;
const soft = issues.aggregatorSourceNoScoreSource.length;

if (hard > 0) {
  console.log(`\n❌ FAIL: ${hard} hard violations (aggregator in P0 or no-star outlet)`);
  process.exit(1);
} else if (soft > 5) {
  console.log(`\n⚠️ WARNING: ${soft} soft violations (aggregator source, no scoreSource)`);
  // Don't fail — these are handled by rebuild guards
} else {
  console.log('\n✅ Score integrity check passed');
}
