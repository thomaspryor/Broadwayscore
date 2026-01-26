#!/usr/bin/env node

/**
 * Merge Show Score excerpts into existing review files
 * Uses data/show-score.json as the source
 */

const fs = require('fs');
const path = require('path');

const showScoreData = JSON.parse(fs.readFileSync('data/show-score.json', 'utf8'));
const reviewTextsDir = 'data/review-texts';

// Outlet normalization
const outletNormalization = {
  'the new york times': 'nytimes',
  'new york times': 'nytimes',
  'new york magazine / vulture': 'vulture',
  'vulture': 'vulture',
  'variety': 'variety',
  'the hollywood reporter': 'hollywood-reporter',
  'hollywood reporter': 'hollywood-reporter',
  'theatermania': 'theatermania',
  'deadline': 'deadline',
  'deadline hollywood': 'deadline',
  'new york post': 'nypost',
  'ny post': 'nypost',
  'entertainment weekly': 'ew',
  'time out new york': 'timeout-ny',
  'time out': 'timeout-ny',
  'the guardian': 'guardian',
  'guardian': 'guardian',
  'daily beast': 'daily-beast',
  'the daily beast': 'daily-beast',
  'thewrap': 'thewrap',
  'the wrap': 'thewrap',
  'new yorker': 'new-yorker',
  'the new yorker': 'new-yorker',
  'new york daily news': 'nydn',
  'ny daily news': 'nydn',
  'associated press': 'ap',
  'ap': 'ap',
  'indiewire': 'indiewire',
  'broadway news': 'broadway-news',
  'broadwayworld': 'bww',
  'broadway world': 'bww',
  'ny stage review': 'ny-stage-review',
  'new york stage review': 'ny-stage-review',
  'new york theatre guide': 'ny-theatre-guide',
  'stage and cinema': 'stage-and-cinema',
  'theatrely': 'theatrely',
  'cititour': 'cititour',
  "the stage": 'the-stage',
  'curtain up': 'curtain-up',
  'chicago tribune': 'chicago-tribune',
  'los angeles times': 'la-times',
  'washington post': 'washpost',
  'the washington post': 'washpost',
};

function normalizeOutletId(outlet) {
  const lower = outlet.toLowerCase().trim();
  return outletNormalization[lower] || lower.replace(/[^a-z0-9]+/g, '-');
}

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
    const ssOutletId = normalizeOutletId(ssReview.outlet);
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
