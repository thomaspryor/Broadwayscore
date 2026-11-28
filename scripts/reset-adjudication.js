#!/usr/bin/env node

/**
 * Reset mis-adjudicated reviews so they get re-evaluated by the adjudicator.
 * Clears humanReviewScore/humanReviewNote/humanReviewAt from source files,
 * allowing adjudicate-review-queue.js to process them again.
 *
 * Usage: node scripts/reset-adjudication.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const DRY_RUN = process.argv.includes('--dry-run');

// Reviews to reset — identified from audit of adjudicator outlet-awareness bug.
// The adjudicator trusted aggregator-invented star ratings for non-star outlets.
const REVIEWS_TO_RESET = [
  // lost-in-theatreland: adjudicator overrode explicit 2/5 stars calling them "errors"
  { showId: 'operation-mincemeat-west-end-2024', outletId: 'lost-in-theatreland', criticName: 'Amy Rye' },
  { showId: 'six-the-musical-west-end-2021', outletId: 'lost-in-theatreland', criticName: 'Amy Rye' },
  // west-sussex-gazette: non-star outlet got score 95
  { showId: 'oliver-west-end-2024', outletId: 'west-sussex-gazette', criticName: 'Gary Shipton' },
  // la-voce-di-new-york: possible wrongShow (review may be for Kyoto, not Art)
  { showId: 'art-2025', outletId: 'la-voce-di-new-york', criticName: 'JK Clarke' },
  // NOTE: back-to-the-future-west-end-2021/broadwayworld NOT reset — broadwayworld
  // IS a known star outlet (publishes its own ratings), so the 5/5 may be legitimate.
];

const FIELDS_TO_CLEAR = [
  // Old field name (pre-linter fix) and new field name — clear both for safety
  'humanReviewScore', 'humanReviewNote', 'humanReviewPreviousScore',
  'adjudicatedScore', 'adjudicationNote', 'adjudicationPreviousScore',
  'humanReviewAt', 'adjudicationAttempts', 'adjudicationHistory',
];

function findSourceFile(showId, outletId, criticName) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return null;

  const kebabCritic = criticName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const filename = `${outletId}--${kebabCritic}.json`;
  const filePath = path.join(showDir, filename);

  if (fs.existsSync(filePath)) return filePath;

  // Case-insensitive fallback
  const files = fs.readdirSync(showDir);
  const match = files.find(f => f.startsWith(outletId + '--') && f.toLowerCase().includes(kebabCritic));
  if (match) return path.join(showDir, match);

  return null;
}

console.log('🔄 Reset Mis-Adjudicated Reviews\n');
if (DRY_RUN) console.log('  DRY RUN — no files will be modified\n');

let resetCount = 0;
let missingCount = 0;
let skippedCount = 0;

for (const review of REVIEWS_TO_RESET) {
  const label = `${review.showId} / ${review.outletId}--${review.criticName}`;
  const filePath = findSourceFile(review.showId, review.outletId, review.criticName);

  if (!filePath) {
    console.log(`  ⚠️  ${label} — source file not found`);
    missingCount++;
    continue;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  const oldScore = data.humanReviewScore || data.adjudicatedScore;
  if (!oldScore) {
    console.log(`  ⏭️  ${label} — no adjudicated/human score to clear`);
    skippedCount++;
    continue;
  }

  console.log(`  🗑️  ${label} — clearing score: ${oldScore}`);

  if (!DRY_RUN) {
    for (const field of FIELDS_TO_CLEAR) {
      delete data[field];
    }
    // Mark that this was reset so we have an audit trail
    data.adjudicationReset = {
      resetAt: new Date().toISOString(),
      reason: 'outlet-awareness-bug: adjudicator trusted aggregator-invented star rating',
      previousScore: oldScore,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
  resetCount++;
}

console.log(`\n  Reset: ${resetCount} | Missing: ${missingCount} | Skipped: ${skippedCount}`);
if (DRY_RUN) console.log('  DRY RUN — no files were modified');
