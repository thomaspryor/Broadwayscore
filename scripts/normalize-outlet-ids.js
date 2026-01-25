#!/usr/bin/env node
/**
 * Normalize outlet IDs in reviews.json to uppercase standard form
 */
const fs = require('fs');
const path = require('path');

const reviewsPath = path.join(__dirname, '../data/reviews.json');
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));

// Map lowercase outlet IDs to standard uppercase form
const outletIdMap = {
  'timeout-ny': 'TIMEOUTNY',
  'washington-post': 'WASHPOST',
  'nypost': 'NYP',
  'thewrap': 'WRAP',
  'usa-today': 'USATODAY',
  'rolling-stone': 'ROLLSTONE',
  'the-new-york-daily-news': 'NYDN',
  'daily-beast': 'TDB',
  'nj-com': 'NJCOM',
  'new-york-theatre-guide': 'NYTG',
  'ny-stage-review': 'NYSR',
  'broadwayworld': 'BWW',
  'ew': 'EW',
};

let updated = 0;
reviewsData.reviews.forEach(r => {
  if (r.showId === 'moulin-rouge-2019') {
    const newId = outletIdMap[r.outletId];
    if (newId) {
      console.log(`${r.outletId} -> ${newId}`);
      r.outletId = newId;
      updated++;
    }
  }
});

fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
console.log(`\nUpdated ${updated} outlet IDs`);
