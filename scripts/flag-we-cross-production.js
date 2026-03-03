#!/usr/bin/env node
/**
 * Flag US-only outlet reviews in West End directories as wrongProduction.
 * These are Broadway reviews that leaked in via aggregator scrapers before
 * market-aware guards existed.
 *
 * Safe to re-run: skips files already flagged.
 */
const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// US-only outlets that NEVER review West End shows
const US_ONLY_OUTLETS = new Set([
  'amny', 'nydailynews', 'newsday', 'nbcny', 'nypost',
  'backstage', 'curtainup', 'nysr', 'nyt-theater',
  'broadwaynews', 'theatermania',
  'dailybeast', 'thewrap', 'huffpost', 'observer',
  'wsj', 'ew', 'vulture', 'washpost', 'chicagotribune',
  'latimes', 'san-francisco-chronicle', 'usatoday', 'bostonglobe'
]);

// NYT London correspondents whose WE reviews are legitimate
const NYT_LONDON_CRITICS = new Set(['matt-wolf', 'houman-barekat']);

// Specific files verified as legitimate WE reviews (override the outlet check)
const LEGITIMATE_FILES = new Set([
  // Ben Brantley traveled to London for Hamilton WE opening
  'hamilton-west-end-2021/nytimes--ben-brantley.json',
  // UK Observer (observer.co.uk), not US Observer
  'paddington-the-musical-west-end-2025/observer--katherine-cowles.json',
  // BWW westend URL, misattributed outlet
  'paranormal-activity-west-end-2025/dailybeast--franco-milazzo.json',
]);

const dryRun = process.argv.includes('--dry-run');
let flagged = 0;
let skippedAlready = 0;
let skippedLegit = 0;

const dirs = fs.readdirSync(REVIEW_TEXTS_DIR)
  .filter(d => d.includes('west-end') && fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory());

for (const dir of dirs) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, dir);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const outletId = file.split('--')[0];
    const criticId = file.replace('.json', '').split('--')[1] || '';
    const relPath = dir + '/' + file;

    // Skip non-US outlets
    if (!US_ONLY_OUTLETS.has(outletId) && outletId !== 'nytimes') continue;

    // NYT London critics are legitimate
    if (outletId === 'nytimes' && NYT_LONDON_CRITICS.has(criticId)) continue;

    // NYT without London critic — check URL for London indicators
    if (outletId === 'nytimes') {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
        const url = (data.url || '').toLowerCase();
        if (url.includes('london') || url.includes('west-end') || url.includes('drury') || url.includes('olivier') || url.includes('donmar')) {
          skippedLegit++;
          continue;
        }
      } catch (e) { /* proceed to flag */ }
    }

    // Verified legitimate files
    if (LEGITIMATE_FILES.has(relPath)) {
      skippedLegit++;
      continue;
    }

    const filePath = path.join(dirPath, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip already-excluded files
      if (data.wrongProduction || data.wrongShow || data.duplicateOf || data.rejectionReason) {
        skippedAlready++;
        continue;
      }

      // Flag it
      data.wrongProduction = true;
      data.wrongProductionNote = 'US-only outlet review filed in West End directory — Broadway production review';

      if (!dryRun) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      const hasScore = data.assignedScore || data.llmScore || data.humanReviewScore;
      console.log(`${dryRun ? '[DRY] ' : ''}FLAGGED${hasScore ? ' [SCORED]' : ''}: ${relPath}`);
      flagged++;
    } catch (e) {
      console.error(`ERROR reading ${relPath}: ${e.message}`);
    }
  }
}

console.log(`\n--- Summary ---`);
console.log(`Flagged: ${flagged}`);
console.log(`Already excluded: ${skippedAlready}`);
console.log(`Legitimate WE reviews preserved: ${skippedLegit}`);
if (dryRun) console.log('(DRY RUN — no files modified)');
