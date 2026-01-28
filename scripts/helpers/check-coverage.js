#!/usr/bin/env node
/**
 * Check review coverage stats
 *
 * Usage: node scripts/helpers/check-coverage.js
 */

const fs = require('fs');
const path = require('path');
const dir = 'data/review-texts';

let total = 0, withText = 0, withExcerptOnly = 0;
let ssSource = 0, dtliSource = 0, bwwSource = 0, otherSource = 0;

fs.readdirSync(dir).forEach(showDir => {
  const showPath = path.join(dir, showDir);
  if (!fs.statSync(showPath).isDirectory()) return;

  fs.readdirSync(showPath)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
    .forEach(f => {
      const d = JSON.parse(fs.readFileSync(path.join(showPath, f)));
      total++;

      // Source tracking
      const src = d.source || '';
      if (src.includes('show-score')) ssSource++;
      else if (src.includes('dtli')) dtliSource++;
      else if (src.includes('bww')) bwwSource++;
      else otherSource++;

      // Text coverage
      if (d.fullText && d.fullText.length > 100) withText++;
      else if (d.dtliExcerpt || d.bwwExcerpt || d.showScoreExcerpt) withExcerptOnly++;
    });
});

console.log('=== REVIEW COVERAGE ===\n');
console.log('Total reviews:', total);
console.log('');
console.log('By source:');
console.log('  Show Score:', ssSource, '(' + Math.round(100*ssSource/total) + '%)');
console.log('  DTLI:', dtliSource, '(' + Math.round(100*dtliSource/total) + '%)');
console.log('  BWW:', bwwSource, '(' + Math.round(100*bwwSource/total) + '%)');
console.log('  Other:', otherSource, '(' + Math.round(100*otherSource/total) + '%)');
console.log('');
console.log('Text coverage:');
console.log('  With fullText:', withText, '(' + Math.round(100*withText/total) + '%)');
console.log('  Excerpt only:', withExcerptOnly, '(' + Math.round(100*withExcerptOnly/total) + '%)');
console.log('  No text:', total - withText - withExcerptOnly);
