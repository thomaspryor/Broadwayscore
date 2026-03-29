#!/usr/bin/env node
/**
 * One-time migration: Relabel Show Score star ratings from 'explicit-rating' to 'show-score-stars'
 *
 * Show Score assigns its own star ratings to ALL reviews, but these were being labeled
 * scoreSource: 'explicit-rating' — same as genuine outlet star ratings. This gave them
 * P0.5 priority when they should be P3b (WE) or clearly marked as aggregator-assigned.
 *
 * This script finds all review files sourced from Show Score with scoreSource: 'explicit-rating'
 * and relabels them to 'show-score-stars'.
 *
 * Usage:
 *   node scripts/migrate-ss-score-labels.js --dry-run   # Report only
 *   node scripts/migrate-ss-score-labels.js              # Apply changes
 *
 * Safe to run multiple times (idempotent).
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const REVIEW_DIR = path.join(__dirname, '../data/review-texts');

if (!fs.existsSync(REVIEW_DIR)) {
  console.error('review-texts directory not found at', REVIEW_DIR);
  process.exit(1);
}

const shows = fs.readdirSync(REVIEW_DIR).filter(d => {
  try { return fs.statSync(path.join(REVIEW_DIR, d)).isDirectory(); } catch { return false; }
});

let fixed = 0;
let skipped = 0;

for (const showId of shows) {
  const showDir = path.join(REVIEW_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const isShowScore = data.source === 'show-score' ||
                          data.source === 'show-score-playwright' ||
                          data.source === 'showscore-roundup';

      if (isShowScore && data.scoreSource === 'explicit-rating' && data.originalScore) {
        if (DRY_RUN) {
          console.log(`  [DRY] ${showId}/${file}: ${data.originalScore} (${data.outlet || data.outletId})`);
        } else {
          data.scoreSource = 'show-score-stars';
          if (data.originalScoreSource === 'explicit-rating') {
            data.originalScoreSource = 'show-score-stars';
          }
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        fixed++;
      } else {
        skipped++;
      }
    } catch {}
  }
}

console.log(`\n${DRY_RUN ? '[DRY RUN] Would relabel' : 'Relabeled'} ${fixed} files`);
console.log(`Skipped ${skipped} files (not SS explicit-rating)`);

if (fixed === 0) {
  console.log('\nNo files to migrate — already done or no SS explicit-rating files found.');
}
