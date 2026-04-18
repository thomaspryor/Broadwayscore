#!/usr/bin/env node
/**
 * apply-audit-flags.js — Reads audit reports and applies flags to review-text source files.
 *
 * Closes the detection→action loop:
 *   detect-syndicated-duplicates.js → data/audit/syndicated-duplicates.json
 *   this script reads that JSON → applies fullTextWrongAuthor / isSyndicatedDuplicate flags
 *
 * Usage:
 *   node scripts/apply-audit-flags.js                    # apply high-confidence findings
 *   node scripts/apply-audit-flags.js --dry-run           # preview what would change
 *   node scripts/apply-audit-flags.js --confidence=all    # apply all confidence levels
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');

const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'syndicated-duplicates.json');
const REVIEW_TEXTS_BASE = path.join(__dirname, '..', 'data', 'review-texts');

// Known false positives from manual review — byline detector picks up non-critic names
const FALSE_POSITIVES = new Set([
  'frozen-2018/insidethemagic--cristina-sanza.json',     // "Theater Cristina" is not a byline
  'the-great-gatsby-2024/theater-scene--deirdre-donovan.json', // "Marc Bruni" is the director, not a critic
]);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const confidenceFilter = (args.find(a => a.startsWith('--confidence=')) || '--confidence=high').split('=')[1];

if (!fs.existsSync(AUDIT_PATH)) {
  console.log('No audit report found at', AUDIT_PATH);
  console.log('Run: node scripts/detect-syndicated-duplicates.js');
  process.exit(0);
}

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
let applied = 0;
let skipped = 0;
let alreadyFlagged = 0;

// --- Apply author mismatches as fullTextWrongAuthor ---
if (audit.authorMismatches && audit.authorMismatches.length > 0) {
  console.log(`\n=== Author Mismatches (${audit.authorMismatches.length} found) ===\n`);

  for (const m of audit.authorMismatches) {
    const filePath = path.join(REVIEW_TEXTS_BASE, m.showId, m.file);

    const fileKey = `${m.showId}/${m.file}`;
    if (FALSE_POSITIVES.has(fileKey)) {
      console.log(`  SKIP (known false positive): ${fileKey}`);
      skipped++;
      continue;
    }

    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP (file missing): ${m.showId}/${m.file}`);
      skipped++;
      continue;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Already flagged — don't double-flag
    if (data.fullTextWrongAuthor || data.wrongAttribution || data.duplicateOf) {
      alreadyFlagged++;
      continue;
    }

    // Check if file still has fullText (may have been cleared already)
    if (!data.fullText) {
      alreadyFlagged++;
      continue;
    }

    const hasExcerpt = !!(data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || data.nycTheatreExcerpt || data.lboRoundupExcerpt);
    const action = hasExcerpt ? 'fullTextWrongAuthor (has excerpts)' : 'fullTextWrongAuthor (stub)';

    console.log(`  ${dryRun ? 'WOULD APPLY' : 'APPLYING'}: ${m.showId}/${m.file}`);
    console.log(`    Detected: "${m.detectedAuthor}" in ${m.pattern}, expected: "${m.fileCritic}"`);
    console.log(`    Action: ${action}`);

    if (!dryRun) {
      data.fullTextWrongAuthor = true;
      data._authorMismatch = `Byline says ${m.detectedAuthor}, file says ${m.fileCritic}`;
      delete data.fullText;
      // Clear scores computed from wrong fullText
      delete data.assignedScore;
      delete data.ensembleData;
      delete data.scoringModel;
      delete data.scoringTimestamp;
      data.needsRescore = 'fullTextWrongAuthor-applied';
      data.contentTier = hasExcerpt ? 'excerpt' : 'stub';

      safeWriteReview(filePath, data, { force: true });
    }
    applied++;
  }
}

// --- Apply syndication pairs as isSyndicatedDuplicate ---
if (audit.flagged && audit.flagged.length > 0) {
  console.log(`\n=== Syndication Pairs (${audit.flagged.length} flagged) ===\n`);

  for (const pair of audit.flagged) {
    const filePath = path.join(REVIEW_TEXTS_BASE, pair.showId, pair.secondaryFile);

    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP (file missing): ${pair.showId}/${pair.secondaryFile}`);
      skipped++;
      continue;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (data.isSyndicatedDuplicate || data.duplicateOf) {
      alreadyFlagged++;
      continue;
    }

    console.log(`  ${dryRun ? 'WOULD APPLY' : 'APPLYING'}: ${pair.showId}/${pair.secondaryFile}`);
    console.log(`    Duplicate of: ${pair.primaryFile} (similarity: ${pair.similarity})`);

    if (!dryRun) {
      data.isSyndicatedDuplicate = true;
      data.duplicateOf = pair.primaryFile;
      data._syndicationNote = `Syndicated from ${pair.primaryOutlet} (detected by audit)`;

      safeWriteReview(filePath, data);
    }
    applied++;
  }
}

// --- Apply AP content detections ---
if (audit.apContentDetections && audit.apContentDetections.length > 0) {
  console.log(`\n=== AP Content Detections (${audit.apContentDetections.length} found) ===\n`);

  for (const det of audit.apContentDetections) {
    const filePath = path.join(REVIEW_TEXTS_BASE, det.showId, det.file);

    if (!fs.existsSync(filePath)) {
      skipped++;
      continue;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (data.isSyndicatedDuplicate || data.duplicateOf || data.fullTextWrongAuthor) {
      alreadyFlagged++;
      continue;
    }

    console.log(`  ${dryRun ? 'WOULD APPLY' : 'APPLYING'}: ${det.showId}/${det.file}`);
    console.log(`    AP signal: ${det.signal}`);

    if (!dryRun) {
      data.fullTextWrongAuthor = true;
      data._authorMismatch = `AP wire content detected in non-AP file: ${det.signal}`;
      data.needsRescore = 'ap-content-detected';

      safeWriteReview(filePath, data);
    }
    applied++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Applied: ${applied}${dryRun ? ' (dry run)' : ''}`);
console.log(`Already flagged: ${alreadyFlagged}`);
console.log(`Skipped (missing): ${skipped}`);

if (dryRun && applied > 0) {
  console.log(`\nRe-run without --dry-run to apply changes.`);
}
