#!/usr/bin/env node

/**
 * Merge Show Score excerpts into existing review files
 * Uses data/show-score.json as the source
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet } = require('./lib/review-normalization');

const showScoreData = JSON.parse(fs.readFileSync('data/show-score.json', 'utf8'));
const reviewTextsDir = 'data/review-texts';

let totalMatched = 0;
let totalAdded = 0;
let totalAlreadyHad = 0;
let totalNoMatch = 0;

for (const [showId, showData] of Object.entries(showScoreData.shows || {})) {
  const showDir = path.join(reviewTextsDir, showId);

  if (!fs.existsSync(showDir)) continue;
  if (!showData.criticReviews || showData.criticReviews.length === 0) continue;

  const reviewFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  let added = 0;

  for (const ssReview of showData.criticReviews) {
    if (!ssReview.outlet) continue;
    const ssOutletId = normalizeOutlet(ssReview.outlet);
    const excerpt = ssReview.excerpt;

    if (!excerpt || excerpt.length < 20) continue;

    // Find matching review file
    let matched = false;
    for (const reviewFile of reviewFiles) {
      const filePath = path.join(showDir, reviewFile);
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const fileOutletId = reviewFile.split('--')[0].toLowerCase();

      if (fileOutletId === ssOutletId ||
          fileOutletId.includes(ssOutletId) ||
          ssOutletId.includes(fileOutletId)) {
        totalMatched++;
        matched = true;

        if (!review.showScoreExcerpt || review.showScoreExcerpt.length < 20) {
          review.showScoreExcerpt = excerpt;
          if (!review.url && ssReview.url) review.url = ssReview.url;

          fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          added++;
          totalAdded++;
        } else {
          totalAlreadyHad++;
        }
        break;
      }
    }

    if (!matched) totalNoMatch++;
  }

  if (added > 0) {
    console.log(`${showId}: Added ${added} Show Score excerpts`);
  }
}

console.log('\n=== Summary ===');
console.log('Show Score reviews matched:', totalMatched);
console.log('Excerpts added:', totalAdded);
console.log('Already had excerpt:', totalAlreadyHad);
console.log('No matching file:', totalNoMatch);
