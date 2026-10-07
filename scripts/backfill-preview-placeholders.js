#!/usr/bin/env node
/**
 * One-shot backfill: mark existing review files as isPreviewPlaceholder:true
 * for shows currently in the preview window (status='previews' or openingDate
 * still in the future).
 *
 * Criteria for marking a file:
 *   - Show is in previews (status === 'previews' or openingDate > today)
 *   - File has no fullText (stub — never fully fetched)
 *   - File is not already marked isPreviewPlaceholder:true
 *
 * Usage:
 *   node scripts/backfill-preview-placeholders.js --dry-run   # print counts only
 *   node scripts/backfill-preview-placeholders.js             # write files
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const isDryRun = process.argv.includes('--dry-run');

function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const today = new Date();

  const previewShows = showsData.shows.filter(s =>
    s.status === 'previews' ||
    (s.openingDate && new Date(s.openingDate) > today)
  );

  console.log(`Found ${previewShows.length} shows in preview window`);
  if (isDryRun) console.log('DRY RUN — no files will be written\n');

  let totalFiles = 0;
  let markedCount = 0;
  let alreadyMarked = 0;
  let hasFullText = 0;

  for (const show of previewShows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    if (!fs.existsSync(showDir)) continue;

    const files = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    for (const file of files) {
      totalFiles++;
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        console.warn(`  ⚠ Could not parse ${show.id}/${file}: ${e.message}`);
        continue;
      }

      if (data.isPreviewPlaceholder) {
        alreadyMarked++;
        continue;
      }

      if (data.fullText) {
        hasFullText++;
        continue;
      }

      // Stub with no fullText in a preview-window show → mark as placeholder
      markedCount++;
      if (!isDryRun) {
        data.isPreviewPlaceholder = true;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      } else {
        console.log(`  would mark: ${show.id}/${file}`);
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Preview-window shows:    ${previewShows.length}`);
  console.log(`  Total review files:      ${totalFiles}`);
  console.log(`  Already marked:          ${alreadyMarked}`);
  console.log(`  Has fullText (skip):     ${hasFullText}`);
  console.log(`  ${isDryRun ? 'Would mark' : 'Marked'}:              ${markedCount}`);
}

main();
