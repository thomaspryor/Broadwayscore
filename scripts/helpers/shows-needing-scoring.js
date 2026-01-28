#!/usr/bin/env node
/**
 * List shows with reviews that need scoring
 *
 * Usage: node scripts/helpers/shows-needing-scoring.js
 */

const fs = require('fs');
const path = require('path');
const dir = 'data/review-texts';

const showCounts = {};

fs.readdirSync(dir).forEach(showDir => {
  const showPath = path.join(dir, showDir);
  if (!fs.statSync(showPath).isDirectory()) return;

  let count = 0;
  fs.readdirSync(showPath)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
    .forEach(f => {
      const d = JSON.parse(fs.readFileSync(path.join(showPath, f)));
      if (!d.assignedScore && (d.fullText || d.dtliExcerpt || d.bwwExcerpt || d.showScoreExcerpt)) {
        count++;
      }
    });

  if (count > 0) showCounts[showDir] = count;
});

// Sort by count descending
const sorted = Object.entries(showCounts).sort((a, b) => b[1] - a[1]);

if (sorted.length === 0) {
  console.log('All reviews are scored!');
} else {
  let total = 0;
  sorted.forEach(([show, count]) => {
    console.log(show);
    total += count;
  });
  console.error(`\n${sorted.length} shows with ${total} reviews needing scoring`);
}
