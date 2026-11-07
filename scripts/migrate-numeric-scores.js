#!/usr/bin/env node
/**
 * Phase 3a: Migrate numeric originalScore to human-readable string format.
 *
 * Finds files where originalScore is a bare number and originalRating exists,
 * then rewrites originalScore to the human-readable originalRating string.
 *
 * For files with numeric originalScore but NO originalRating, we reverse-engineer
 * the human-readable format from the known score value and source context.
 *
 * Usage:
 *   node scripts/migrate-numeric-scores.js --dry-run    # Preview changes
 *   node scripts/migrate-numeric-scores.js              # Apply changes
 */

const fs = require('fs');
const path = require('path');
const { LETTER_GRADES } = require('./lib/score-extractors');
const { setExtractedScore } = require('./lib/score-routing');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

// Reverse lookup: numeric → letter grade
const NUMERIC_TO_GRADE = {};
for (const [grade, num] of Object.entries(LETTER_GRADES)) {
  NUMERIC_TO_GRADE[num] = grade;
}

let migrated = 0;
let skippedAlreadyString = 0;
let skippedNoScore = 0;
let cannotMigrate = 0;

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

const allFiles = walkDir(reviewTextsDir);
console.log(`Scanning ${allFiles.length} review files...\n`);

for (const filePath of allFiles) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const os = data.originalScore;

    if (os === undefined || os === null) {
      skippedNoScore++;
      continue;
    }

    if (typeof os === 'string') {
      skippedAlreadyString++;
      continue;
    }

    // os is numeric — needs migration
    let newScore = null;

    // Case 1: originalRating exists — use it directly
    if (data.originalRating) {
      newScore = data.originalRating;
    }
    // Case 2: Known letter grade value — reverse map
    else if (NUMERIC_TO_GRADE[os]) {
      newScore = NUMERIC_TO_GRADE[os];
    }
    // Case 3: Value looks like a star rating normalization
    else {
      // Can't safely reverse-engineer without more context
      // Leave as-is for now — will be caught by backfill
      if (VERBOSE) {
        const rel = path.relative(reviewTextsDir, filePath);
        console.log(`  ? Cannot migrate ${rel}: originalScore=${os}, no originalRating`);
      }
      cannotMigrate++;
      continue;
    }

    const rel = path.relative(reviewTextsDir, filePath);
    if (VERBOSE || DRY_RUN) {
      console.log(`  ${DRY_RUN ? 'WOULD' : 'WILL'} migrate ${rel}: ${os} → "${newScore}"`);
    }

    if (!DRY_RUN) {
      setExtractedScore(data, {
        value: newScore,
        normalizedValue: data.originalScoreNormalized || os, // The old numeric value IS the normalized score
        source: data.scoreSource || 'migrated-numeric',
      });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
    migrated++;

  } catch (e) {
    console.error(`Error processing ${filePath}: ${e.message}`);
  }
}

console.log(`\n=== Migration ${DRY_RUN ? 'Preview' : 'Complete'} ===`);
console.log(`  Migrated: ${migrated}`);
console.log(`  Already string: ${skippedAlreadyString}`);
console.log(`  No originalScore: ${skippedNoScore}`);
console.log(`  Cannot migrate (no originalRating): ${cannotMigrate}`);
console.log(`  Total files: ${allFiles.length}`);
