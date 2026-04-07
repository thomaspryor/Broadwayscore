#!/usr/bin/env node
/**
 * cleanup-fake-publish-dates.js
 *
 * Nulls publishDate on review-text files where:
 *   1. publishDate exactly equals the show's openingDate
 *   2. The file's source is from a high-fake-rate aggregator that doesn't provide real dates
 *   3. The file is not already flagged wrongProduction/wrongShow
 *
 * These dates were set by createReviewFile()'s now-removed fallback that stamped
 * reviews with the show's opening date when no real publish date was available.
 * The fake dates mask wrong-production reviews and defeat date-based guards.
 *
 * Usage:
 *   node scripts/cleanup-fake-publish-dates.js [--dry-run] [--threshold=65]
 *
 * --dry-run:     Report what would change without modifying files (default)
 * --write:       Actually modify the files
 * --threshold=N: Only target sources with N%+ fake rate (default: 65)
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const dryRun = !process.argv.includes('--write');
const thresholdArg = process.argv.find(a => a.startsWith('--threshold='));
const threshold = thresholdArg ? parseInt(thresholdArg.split('=')[1]) : 65;

// Sources and their fake-date rates (from analysis of 34,403 review files)
// "Fake rate" = % of files where publishDate == show openingDate out of all files with dates
const SOURCE_FAKE_RATES = {
  'showscore-roundup': 86,
  'reviews-json-stub': 81,
  'theatre-reviews': 73,
  'thestage-roundup': 67,
  'site-search': 57,
  'serp-discovery': 50,
};

const targetSources = new Set(
  Object.entries(SOURCE_FAKE_RATES)
    .filter(([, rate]) => rate >= threshold)
    .map(([src]) => src)
);

console.log(`Threshold: ${threshold}%`);
console.log(`Target sources: ${[...targetSources].join(', ')}`);
console.log(`Mode: ${dryRun ? 'DRY RUN (use --write to modify files)' : 'WRITING CHANGES'}\n`);

// Build show opening date map
const showsJSON = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showDateMap = {};
for (const s of showsJSON.shows) {
  if (s.openingDate) showDateMap[s.id] = s.openingDate;
}

let nulled = 0;
let skipped = 0;
let total = 0;
const bySource = {};

for (const sid of fs.readdirSync(REVIEW_TEXTS_DIR)) {
  const sdir = path.join(REVIEW_TEXTS_DIR, sid);
  if (!fs.statSync(sdir).isDirectory()) continue;

  const showOpening = showDateMap[sid];
  if (!showOpening) continue;

  for (const f of fs.readdirSync(sdir).filter(x => x.endsWith('.json') && x !== 'failed-fetches.json')) {
    try {
      const filePath = path.join(sdir, f);
      const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip already-flagged files
      if (d.wrongProduction || d.wrongShow) continue;

      // Only target files where publishDate == opening date
      if (d.publishDate !== showOpening) continue;

      total++;
      const src = d.source || 'unknown';

      if (!targetSources.has(src)) {
        skipped++;
        continue;
      }

      bySource[src] = (bySource[src] || 0) + 1;

      if (!dryRun) {
        d.publishDate = null;
        d.publishDateNulledReason = `Fake fallback date (source=${src}, was ${showOpening})`;
        fs.writeFileSync(filePath, JSON.stringify(d, null, 2) + '\n');
      }

      nulled++;
    } catch {}
  }
}

console.log(`Total files with publishDate == openingDate: ${total}`);
console.log(`Nulled: ${nulled}`);
console.log(`Skipped (below threshold): ${skipped}`);
console.log(`\nBy source:`);
Object.entries(bySource).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k}: ${v}`);
});

if (dryRun && nulled > 0) {
  console.log(`\nRun with --write to apply changes.`);
}

process.exit(0);
