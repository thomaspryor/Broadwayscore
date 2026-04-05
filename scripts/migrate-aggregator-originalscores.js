#!/usr/bin/env node
/**
 * One-time migration: Move aggregator scores from originalScore to aggregatorStars
 *
 * Finds review-text files where originalScore has an aggregator scoreSource
 * (lbo-star-rating, lbo-css-stars, show-score-stars, theatre-reviews-star-rating, etc.)
 * and moves the value to aggregatorStars instead.
 *
 * Usage:
 *   node scripts/migrate-aggregator-originalscores.js --dry-run   # Report only
 *   node scripts/migrate-aggregator-originalscores.js              # Fix files
 */

const fs = require('fs');
const path = require('path');
const { AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');

const DRY_RUN = process.argv.includes('--dry-run');
const baseDir = path.join(__dirname, '..', 'data', 'review-texts');

const shows = fs.readdirSync(baseDir).filter(d => {
  try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
});

let fixed = 0;
let skipped = 0;
const bySource = {};

for (const show of shows) {
  const showDir = path.join(baseDir, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (data.originalScore != null && data.scoreSource && AGGREGATOR_SCORE_SOURCES.has(data.scoreSource)) {
        bySource[data.scoreSource] = (bySource[data.scoreSource] || 0) + 1;

        if (!DRY_RUN) {
          data.aggregatorStars = data.originalScore;
          data.originalScore = null;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        console.log(`${DRY_RUN ? '[DRY] ' : ''}${show}/${file}: ${data.scoreSource} → aggregatorStars`);
        fixed++;
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`${DRY_RUN ? 'Would fix' : 'Fixed'}: ${fixed} files`);
console.log('By source:', JSON.stringify(bySource, null, 2));
