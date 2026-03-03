#!/usr/bin/env node
/**
 * Flag single-model scored reviews for ensemble rescoring.
 *
 * Finds review-text files that have `llmScore` but no `ensembleData`
 * (scored before the ensemble pipeline existed) and sets `needsRescore: true`.
 * Also clears stale `assignedScore`/`scoreSource` to force clean rescore.
 *
 * Usage:
 *   node scripts/flag-single-model-for-rescore.js          # dry-run (report only)
 *   node scripts/flag-single-model-for-rescore.js --apply   # write changes
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');

function main() {
  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory());

  let totalFiles = 0;
  let singleModelTotal = 0;
  let alreadyFlagged = 0;
  let newlyFlagged = 0;
  const byContentTier = {};
  const byShow = {};

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      totalFiles++;
      const filePath = path.join(showDir, file);

      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        continue;
      }

      // Skip files without llmScore or that already have ensemble data
      if (!data.llmScore || data.ensembleData) continue;

      singleModelTotal++;
      const tier = data.contentTier || 'unknown';
      byContentTier[tier] = (byContentTier[tier] || 0) + 1;

      if (data.needsRescore) {
        alreadyFlagged++;
        continue;
      }

      // Flag for rescoring
      newlyFlagged++;
      byShow[show] = (byShow[show] || 0) + 1;

      if (apply) {
        data.needsRescore = true;

        // Clear stale assignedScore that came from single-model scoring
        // to prevent it from resurfacing via the P4 fallback path
        if (data.scoreSource && data.scoreSource.includes('single-model')) {
          delete data.assignedScore;
          delete data.scoreSource;
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  console.log(`\n=== Single-Model Review Flag Report ===`);
  console.log(`Total review files scanned: ${totalFiles}`);
  console.log(`Single-model (llmScore, no ensembleData): ${singleModelTotal}`);
  console.log(`  Already flagged needsRescore: ${alreadyFlagged}`);
  console.log(`  Newly flagged: ${newlyFlagged}`);
  console.log(`\nBy content tier:`);
  for (const [tier, count] of Object.entries(byContentTier).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tier}: ${count}`);
  }

  if (newlyFlagged > 0) {
    const showEntries = Object.entries(byShow).sort((a, b) => b[1] - a[1]);
    console.log(`\nTop shows by newly flagged count:`);
    for (const [show, count] of showEntries.slice(0, 20)) {
      console.log(`  ${show}: ${count}`);
    }
    if (showEntries.length > 20) {
      console.log(`  ... and ${showEntries.length - 20} more shows`);
    }
  }

  if (!apply) {
    console.log(`\n[DRY RUN] No files modified. Run with --apply to write changes.`);
  } else {
    console.log(`\n[APPLIED] ${newlyFlagged} files updated with needsRescore: true`);
  }
}

main();
