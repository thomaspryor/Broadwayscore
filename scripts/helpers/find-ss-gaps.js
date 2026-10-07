#!/usr/bin/env node
/**
 * Find shows where we're missing Show Score reviews
 * Compares what Show Score reports vs what we collected
 *
 * Usage: node scripts/helpers/find-ss-gaps.js
 */

const fs = require('fs');
const path = require('path');

const archiveDir = 'data/aggregator-archive/show-score';
const reviewDir = 'data/review-texts';

const gaps = [];

fs.readdirSync(archiveDir)
  .filter(f => f.endsWith('.html'))
  .forEach(file => {
    const show = file.replace('.html', '');
    const archive = path.join(archiveDir, file);

    // Get SS reported count
    const html = fs.readFileSync(archive, 'utf8');
    const match = html.match(/Critic Reviews \((\d+)\)/);
    if (!match) return;
    const ssReports = parseInt(match[1]);

    // Count what we collected from SS source
    const dir = path.join(reviewDir, show);
    let weHave = 0;
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
        .forEach(f => {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f)));
          if (d.source && d.source.includes('show-score')) weHave++;
        });
    }

    const gap = ssReports - weHave;
    if (gap > 0) {
      gaps.push({ show, ssReports, weHave, gap });
    }
  });

// Sort by gap descending
gaps.sort((a, b) => b.gap - a.gap);

console.log('=== SHOWS WITH MISSING SHOW SCORE REVIEWS ===\n');

if (gaps.length === 0) {
  console.log('No gaps found! All Show Score reviews collected.');
} else {
  gaps.forEach(g => {
    console.log(`${g.show}: SS=${g.ssReports}, we have=${g.weHave}, MISSING ${g.gap}`);
  });
  console.log(`\nTotal shows with gaps: ${gaps.length}`);
  console.log(`Total missing reviews: ${gaps.reduce((sum, g) => sum + g.gap, 0)}`);
  console.log(`\nShows to re-run:\n${gaps.map(g => g.show).join('\n')}`);
}
