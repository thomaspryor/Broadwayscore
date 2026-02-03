#!/usr/bin/env node

/**
 * Backfill originalScoreNormalized using corrected letter grade mapping.
 *
 * The score-extractors.js LETTER_GRADES map was misaligned with the canonical
 * scoring.ts LETTER_GRADE_MAP. This script re-extracts scores from originalScore
 * using the corrected mapping.
 *
 * Usage:
 *   node scripts/backfill-normalized-scores.js              # dry-run (show diff table)
 *   node scripts/backfill-normalized-scores.js --write       # write changes to files
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const WRITE = process.argv.includes('--write');

// Canonical mapping from src/config/scoring.ts
const LETTER_GRADES = {
  'A+': 97, 'A': 93, 'A-': 90,
  'B+': 87, 'B': 83, 'B-': 78,
  'C+': 72, 'C': 65, 'C-': 58,
  'D+': 40, 'D': 35, 'D-': 30,
  'F': 20
};

function starsToNumeric(filled, total = 5) {
  return Math.round((filled / total) * 100);
}

function normalizeScore(originalScore) {
  if (!originalScore) return null;
  const s = String(originalScore).trim();

  // Letter grade
  const upper = s.toUpperCase();
  if (LETTER_GRADES[upper] !== undefined) return LETTER_GRADES[upper];

  // Fraction patterns: "4/5", "3.5/5", "5/5 stars"
  const fractionMatch = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (fractionMatch) {
    return Math.round((parseFloat(fractionMatch[1]) / parseFloat(fractionMatch[2])) * 100);
  }

  // "X stars" or "X out of 5"
  const starMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:stars?|out\s+of\s+5)/i);
  if (starMatch) {
    return starsToNumeric(parseFloat(starMatch[1]));
  }

  // Numeric (only plain number, not fractions)
  const numMatch = s.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const num = parseFloat(numMatch[1]);
    if (num <= 10) return Math.round((num / 10) * 100);
    if (num <= 100) return Math.round(num);
  }

  return null;
}

// Find all files with originalScoreNormalized
const changes = [];
const noChange = [];
const errors = [];

const shows = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
  const fp = path.join(REVIEW_TEXTS_DIR, f);
  if (fs.lstatSync(fp).isSymbolicLink()) return false;
  return fs.statSync(fp).isDirectory();
});

for (const show of shows) {
  const dir = path.join(REVIEW_TEXTS_DIR, show);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.originalScoreNormalized == null) continue;

      const oldNorm = data.originalScoreNormalized;
      const origScore = data.originalScore;
      const newNorm = normalizeScore(origScore);
      const hasHuman = data.humanReviewScore != null;

      if (newNorm == null) {
        errors.push({ show, file, origScore, oldNorm, reason: 'Cannot re-normalize' });
        continue;
      }

      if (newNorm !== oldNorm) {
        changes.push({
          show,
          file,
          origScore,
          oldNorm,
          newNorm,
          delta: newNorm - oldNorm,
          hasHumanReview: hasHuman,
          humanScore: hasHuman ? data.humanReviewScore : null,
          filePath
        });
      } else {
        noChange.push({ show, file, origScore, oldNorm });
      }
    } catch (e) {
      errors.push({ show, file, reason: e.message });
    }
  }
}

// Print diff table
console.log(`\n${'='.repeat(100)}`);
console.log(`BACKFILL NORMALIZED SCORES - ${WRITE ? 'WRITING' : 'DRY RUN'}`);
console.log(`${'='.repeat(100)}\n`);

console.log(`Files scanned: ${changes.length + noChange.length + errors.length}`);
console.log(`  Changed: ${changes.length}`);
console.log(`  Unchanged: ${noChange.length}`);
console.log(`  Errors: ${errors.length}\n`);

if (changes.length > 0) {
  console.log('--- Changes ---');
  console.log(`${'Show'.padEnd(30)} ${'File'.padEnd(40)} ${'Orig'.padEnd(6)} ${'Old'.padEnd(5)} ${'New'.padEnd(5)} ${'Δ'.padEnd(5)} Human?`);
  console.log('-'.repeat(100));

  for (const c of changes.sort((a, b) => a.delta - b.delta)) {
    const humanCol = c.hasHumanReview ? `YES (${c.humanScore})` : '';
    console.log(
      `${c.show.padEnd(30)} ${c.file.padEnd(40)} ${String(c.origScore).padEnd(6)} ${String(c.oldNorm).padEnd(5)} ${String(c.newNorm).padEnd(5)} ${(c.delta >= 0 ? '+' : '') + c.delta} ${humanCol}`.padEnd(5)
    );
  }
}

// Bucket migration summary
const buckets = { Rave: [85, 100], Positive: [70, 84], Mixed: [55, 69], Negative: [35, 54], Pan: [0, 34] };
function toBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

const migrations = {};
for (const c of changes) {
  const oldB = toBucket(c.oldNorm);
  const newB = toBucket(c.newNorm);
  if (oldB !== newB) {
    const key = `${oldB} → ${newB}`;
    migrations[key] = (migrations[key] || 0) + 1;
  }
}

if (Object.keys(migrations).length > 0) {
  console.log('\n--- Bucket Migrations ---');
  for (const [key, count] of Object.entries(migrations).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count} reviews`);
  }
}

if (errors.length > 0) {
  console.log('\n--- Errors ---');
  for (const e of errors) {
    console.log(`  ${e.show}/${e.file}: ${e.reason} (origScore=${e.origScore}, oldNorm=${e.oldNorm})`);
  }
}

// Write if requested
if (WRITE && changes.length > 0) {
  let written = 0;
  for (const c of changes) {
    const data = JSON.parse(fs.readFileSync(c.filePath, 'utf-8'));
    data.originalScoreNormalized = c.newNorm;
    fs.writeFileSync(c.filePath, JSON.stringify(data, null, 2) + '\n');
    written++;
  }
  console.log(`\nWrote ${written} files.`);
} else if (!WRITE && changes.length > 0) {
  console.log(`\nDry run - no files written. Use --write to apply changes.`);
}
