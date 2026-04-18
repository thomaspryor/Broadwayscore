#!/usr/bin/env node
/**
 * Archive and clean up previousLlmScore from review files
 *
 * This field was used to preserve old scores before rescoring, but is
 * now redundant — llmMetadata.previousScore stores this in modern files.
 *
 * Also cleans up orphaned rescoreReason/rescoreCompletedAt from files
 * where rescoring already completed (audit noise).
 *
 * Usage:
 *   node scripts/archive-previous-scores.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');

const dryRun = process.argv.includes('--dry-run');
const reviewDir = 'data/review-texts';

const shows = fs.readdirSync(reviewDir).filter(f => {
  const fullPath = path.join(reviewDir, f);
  if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
  return fs.statSync(fullPath).isDirectory();
});

const archived = [];
let cleanedPreviousScore = 0;
let cleanedOrphanedReason = 0;

for (const show of shows) {
  const showDir = path.join(reviewDir, show);
  const files = fs.readdirSync(showDir).filter(f =>
    f.endsWith('.json') && f !== 'failed-fetches.json'
  );

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      let modified = false;

      // Archive and remove previousLlmScore
      if (data.previousLlmScore !== undefined) {
        archived.push({
          show,
          outletCritic: file.replace('.json', ''),
          previousLlmScore: data.previousLlmScore,
          rescoreReason: data.rescoreReason || null,
          rescoreCompletedAt: data.rescoreCompletedAt || null
        });
        if (!dryRun) {
          delete data.previousLlmScore;
        }
        cleanedPreviousScore++;
        modified = true;
      }

      // Clean up orphaned rescoreReason + rescoreCompletedAt
      // (rescore already completed, these are audit noise)
      if (data.rescoreCompletedAt && !data.needsRescore) {
        if (data.rescoreReason) {
          if (!dryRun) delete data.rescoreReason;
          cleanedOrphanedReason++;
          modified = true;
        }
        if (data.rescoreCompletedAt) {
          if (!dryRun) delete data.rescoreCompletedAt;
          modified = true;
        }
      }

      if (modified && !dryRun) {
        safeWriteReview(filePath, data, { force: true });
      }
    } catch (e) {
      // Skip parse errors
    }
  }
}

console.log('='.repeat(60));
console.log('PREVIOUS SCORE ARCHIVE & CLEANUP');
console.log('='.repeat(60));
if (dryRun) console.log('\n*** DRY RUN — no files modified ***');
console.log(`\nFiles with previousLlmScore removed: ${cleanedPreviousScore}`);
console.log(`Files with orphaned rescoreReason cleaned: ${cleanedOrphanedReason}`);
console.log(`Total entries archived: ${archived.length}`);

// Save archive
if (!dryRun && archived.length > 0) {
  const auditDir = 'data/audit';
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const archivePath = path.join(auditDir, 'previous-scores-archive.json');
  fs.writeFileSync(archivePath, JSON.stringify({
    archivedAt: new Date().toISOString(),
    totalEntries: archived.length,
    entries: archived
  }, null, 2));
  console.log(`\nArchive saved to: ${archivePath}`);
} else if (dryRun) {
  console.log('\nDry run — no archive file written.');
}
