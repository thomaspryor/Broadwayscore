#!/usr/bin/env node
/**
 * Quarantine Wrong Production Reviews
 *
 * Moves reviews flagged as "likely_wrong_production" (high confidence)
 * to a quarantine folder for manual review before deletion.
 *
 * These are typically:
 * - Off-Broadway reviews in Broadway show folders (Suffs 2022, Hadestown 2016)
 * - Wrong revival reviews (An Enemy 2012 in An Enemy 2024)
 * - Pre-Broadway tryout reviews
 */

const fs = require('fs');
const path = require('path');

const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'wrong-production-reviews.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const QUARANTINE_DIR = path.join(__dirname, '..', 'data', 'review-texts-quarantine');
const LOG_PATH = path.join(__dirname, '..', 'data', 'audit', 'quarantine-log.json');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allFlagged = args.includes('--all'); // Include medium confidence too
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

console.log('=== Quarantine Wrong Production Reviews ===\n');
if (dryRun) console.log('DRY RUN - no files will be moved\n');

// Load audit report
let report;
try {
  report = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
} catch (e) {
  console.error('ERROR: Cannot load audit report:', e.message);
  console.error('Run: node scripts/audit-wrong-production-reviews.js');
  process.exit(1);
}

// Filter to high confidence (likely_wrong_production) by default
let toQuarantine = report.flagged.filter(f => {
  if (allFlagged) return true;
  // Only quarantine high confidence OR classification is "likely_wrong_production"
  return f.confidence === 'high' || f.classification === 'likely_wrong_production';
});

// Apply show filter if specified
if (showFilter) {
  toQuarantine = toQuarantine.filter(f => f.showId === showFilter);
}

console.log(`Found ${toQuarantine.length} reviews to quarantine\n`);

if (toQuarantine.length === 0) {
  console.log('Nothing to quarantine.');
  process.exit(0);
}

// Group by show for summary
const byShow = {};
for (const f of toQuarantine) {
  byShow[f.showId] = byShow[f.showId] || [];
  byShow[f.showId].push(f);
}

console.log('Reviews to quarantine by show:');
for (const [showId, reviews] of Object.entries(byShow)) {
  console.log(`  ${showId}: ${reviews.length} reviews`);
  for (const r of reviews.slice(0, 3)) {
    console.log(`    - ${r.file} (${r.indicators_found[0]})`);
  }
  if (reviews.length > 3) {
    console.log(`    ... and ${reviews.length - 3} more`);
  }
}

if (dryRun) {
  console.log('\nDry run complete. Use without --dry-run to move files.');
  process.exit(0);
}

// Create quarantine directory
if (!fs.existsSync(QUARANTINE_DIR)) {
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
}

// Move files
const quarantineLog = {
  timestamp: new Date().toISOString(),
  reviewsMoved: [],
  errors: []
};

let moved = 0;
let errors = 0;

for (const flag of toQuarantine) {
  const sourcePath = path.join(REVIEW_TEXTS_DIR, flag.showId, flag.file);
  const quarantineShowDir = path.join(QUARANTINE_DIR, flag.showId);
  const destPath = path.join(quarantineShowDir, flag.file);

  try {
    // Check source exists
    if (!fs.existsSync(sourcePath)) {
      console.log(`  SKIP: ${flag.showId}/${flag.file} - file not found`);
      continue;
    }

    // Create show dir in quarantine
    if (!fs.existsSync(quarantineShowDir)) {
      fs.mkdirSync(quarantineShowDir, { recursive: true });
    }

    // Read, add quarantine metadata, write to quarantine
    const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    data._quarantine = {
      quarantinedAt: new Date().toISOString(),
      reason: flag.classification,
      confidence: flag.confidence,
      indicators: flag.indicators_found,
      originalPath: `review-texts/${flag.showId}/${flag.file}`
    };

    fs.writeFileSync(destPath, JSON.stringify(data, null, 2));

    // Remove from original location
    fs.unlinkSync(sourcePath);

    quarantineLog.reviewsMoved.push({
      showId: flag.showId,
      file: flag.file,
      reason: flag.indicators_found[0],
      confidence: flag.confidence
    });

    moved++;
    console.log(`  MOVED: ${flag.showId}/${flag.file}`);

  } catch (e) {
    errors++;
    quarantineLog.errors.push({
      showId: flag.showId,
      file: flag.file,
      error: e.message
    });
    console.error(`  ERROR: ${flag.showId}/${flag.file} - ${e.message}`);
  }
}

// Save log
fs.writeFileSync(LOG_PATH, JSON.stringify(quarantineLog, null, 2));

console.log(`\n=== Summary ===`);
console.log(`Moved: ${moved}`);
console.log(`Errors: ${errors}`);
console.log(`Log saved: ${LOG_PATH}`);
console.log(`\nQuarantined files are in: ${QUARANTINE_DIR}`);
console.log('Review and delete manually, or restore if false positives.');
