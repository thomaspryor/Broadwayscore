#!/usr/bin/env node
/**
 * Fix contaminated review files where aggregator star ratings leaked into originalScore.
 * Moves originalScore → aggregatorStars for any file where scoreSource is an aggregator source.
 * 
 * Usage: node scripts/fix-contaminated-reviews.js [--dry-run] [--market=west-end]
 */

const fs = require('fs');
const path = require('path');

const { AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');

const DRY_RUN = process.argv.includes('--dry-run');
const MARKET_ARG = process.argv.find(a => a.startsWith('--market='));
const MARKET_FILTER = MARKET_ARG ? MARKET_ARG.split('=')[1] : null;

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');

if (!fs.existsSync(REVIEW_DIR)) {
  console.error('review-texts directory not found (private repo not checked out)');
  process.exit(1);
}

let fixed = 0;
let skipped = 0;
const examples = [];

const showDirs = fs.readdirSync(REVIEW_DIR).filter(d => {
  try { 
    if (!fs.statSync(path.join(REVIEW_DIR, d)).isDirectory()) return false;
    if (d.startsWith('.') || d === 'aggregator-archive') return false;
    if (MARKET_FILTER && !d.includes(MARKET_FILTER)) return false;
    return true;
  } catch { return false; }
});

for (const showDir of showDirs) {
  const showPath = path.join(REVIEW_DIR, showDir);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  
  for (const f of files) {
    const filePath = path.join(showPath, f);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (data.scoreSource && AGGREGATOR_SCORE_SOURCES.has(data.scoreSource) && data.originalScore != null) {
        if (examples.length < 5) examples.push(`${showDir}/${f}`);
        
        if (!DRY_RUN) {
          // Move originalScore → aggregatorStars, clear originalScore
          if (!data.aggregatorStars) {
            data.aggregatorStars = data.originalScore;
          }
          delete data.originalScore;
          delete data.originalScoreNormalized;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        fixed++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn(`  ⚠️  Skipping ${showDir}/${f}: ${err.message}`);
    }
  }
}

console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Fixed: ${fixed} contaminated files`);
console.log(`Skipped (clean): ${skipped} files`);
if (examples.length > 0) {
  console.log(`Examples: ${examples.join(', ')}`);
}
