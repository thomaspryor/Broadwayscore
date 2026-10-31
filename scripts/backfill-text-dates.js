#!/usr/bin/env node
/**
 * Extract publishDate from the first 500 chars of fullText using regex.
 * Only extracts when exactly ONE date is found (avoids ambiguity).
 *
 * Patterns matched:
 *   - "March 31, 2016" / "March 31st, 2016"
 *   - "31 March 2016" / "31st March, 2016"
 *
 * Does NOT match abbreviated months (Jan, Feb, etc.) to avoid false
 * positives from casual mentions like "the Jan. 5 performance".
 *
 * Usage:
 *   node scripts/backfill-text-dates.js              # dry run
 *   node scripts/backfill-text-dates.js --apply      # write to files
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { extractSingleDate } = require('./lib/text-single-date');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = !process.argv.includes('--apply');

function run() {
  const showDirs = listShowDirs(REVIEW_TEXTS_DIR);

  let updated = 0, alreadyHasDate = 0, noText = 0, noMatch = 0, skipped = 0;

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (data.publishDate) { alreadyHasDate++; continue; }
      if (data.wrongProduction || data.wrongShow) { skipped++; continue; }
      if (!data.fullText || data.fullText.length < 100) { noText++; continue; }

      const extracted = extractSingleDate(data.fullText);
      if (!extracted) { noMatch++; continue; }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${showDir}/${file}: ${extracted}`);
      } else {
        data.publishDate = extracted;
        data.dateSource = 'text-regex';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      updated++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Already had date:  ${alreadyHasDate}`);
  console.log(`Excluded (flags):  ${skipped}`);
  console.log(`No fullText:       ${noText}`);
  console.log(`No single match:   ${noMatch}`);
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}:      ${updated}`);
  if (DRY_RUN && updated > 0) {
    console.log(`\nRun with --apply to write changes.`);
  }
}

run();
