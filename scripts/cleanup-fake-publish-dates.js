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

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { listShowDirs } = require('./lib/list-show-dirs');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `cleanup-fake-publish-dates.js — Nulls publishDate on review-text files where:.

Usage:
  node scripts/cleanup-fake-publish-dates.js [options]
  node scripts/cleanup-fake-publish-dates.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
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

// When --all is passed, target ALL sources regardless of fake rate
const targetAll = process.argv.includes('--all');

const targetSources = targetAll ? null : new Set(
  Object.entries(SOURCE_FAKE_RATES)
    .filter(([, rate]) => rate >= threshold)
    .map(([src]) => src)
);

console.log(`Threshold: ${targetAll ? 'ALL sources' : threshold + '%'}`);
if (!targetAll) console.log(`Target sources: ${[...targetSources].join(', ')}`);
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

for (const sid of listShowDirs(REVIEW_TEXTS_DIR)) {
  const sdir = path.join(REVIEW_TEXTS_DIR, sid);
  if (!fs.statSync(sdir).isDirectory()) continue;

  const showOpening = showDateMap[sid];
  if (!showOpening) continue;

  for (const f of fs.readdirSync(sdir).filter(x => isReviewTextFile(x))) {
    try {
      const filePath = path.join(sdir, f);
      const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip already-flagged files
      if (d.wrongProduction || d.wrongShow) continue;

      // Only target files where publishDate == opening date
      if (d.publishDate !== showOpening) continue;

      total++;
      const src = d.source || 'unknown';

      if (!targetAll && !targetSources.has(src)) {
        skipped++;
        continue;
      }

      // No URL-date recovery before nulling: a URL date is never stored as publishDate
      // (BRO-5614, CLAUDE.md rule 3). The rebuild resolves a dateless file's date itself.

      bySource[src] = (bySource[src] || 0) + 1;

      if (!dryRun) {
        d.publishDate = null;
        d.publishDateNulledReason = `Fake fallback date (source=${src}, was ${showOpening})`;
        safeWriteReview(filePath, d);
      }

      nulled++;
    } catch {}
  }
}

console.log(`Total files with publishDate == openingDate: ${total}`);
console.log(`Nulled: ${nulled}`);
console.log(`Skipped (below threshold): ${skipped}`);


console.log(`\nNulled by source:`);
Object.entries(bySource).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k}: ${v}`);
});

if (dryRun && (nulled > 0)) {
  console.log(`\nRun with --write to apply changes.`);
}

process.exit(0);
