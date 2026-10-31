#!/usr/bin/env node

/**
 * Validate Archive Productions
 *
 * Checks that archived aggregator pages match the expected production year/venue.
 * This prevents issues where we accidentally archived a different revival or
 * tour production instead of the intended Broadway production.
 *
 * Checks:
 * 1. DTLI archives - looks for opening date, theater name in page
 * 2. BWW archives - looks for year references matching show ID
 * 3. Show Score archives - verifies broadway-shows URL (not off-broadway)
 *
 * Usage: node scripts/validate-archive-productions.js [--fix]
 */

const fs = require('fs');
const path = require('path');
// Pure decision logic lives in lib/archive-productions-validator.js (BRO-2507,
// unit-tested in tests/unit/validate-archive-productions.test.mjs). This file
// only does the I/O and the printing.
const {
  MISMATCH_THRESHOLD,
  validateDtliArchive,
  validateBwwArchive,
  validateShowScoreArchive,
  applyOutcome,
  exceedsMismatchThreshold,
} = require('./lib/archive-productions-validator');

const DATA_DIR = path.join(__dirname, '../data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive');

// Load shows data
const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const shows = showsData.shows || showsData;
const showsById = {};
shows.forEach(s => showsById[s.id] = s);

const results = {
  checked: 0,
  valid: 0,
  mismatches: [],
  warnings: [],
  errors: []
};

console.log('=== Validate Archive Productions ===\n');

function runArchiveDir(dir, validator) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  for (const file of files) {
    const showId = file.replace('.html', '');
    const htmlPath = path.join(dir, file);
    // Unknown shows are reported without reading the page (as before).
    const html = showsById[showId] ? fs.readFileSync(htmlPath, 'utf8') : '';
    applyOutcome(results, validator(showId, showsById[showId], html, path.basename(htmlPath)));
  }
}

// Process all archives
const dtliDir = path.join(ARCHIVE_DIR, 'dtli');
const bwwDir = path.join(ARCHIVE_DIR, 'bww-roundups');
const showScoreDir = path.join(ARCHIVE_DIR, 'show-score');

// DTLI archives
if (fs.existsSync(dtliDir)) {
  console.log('Checking DTLI archives...');
  runArchiveDir(dtliDir, validateDtliArchive);
}

// BWW archives
if (fs.existsSync(bwwDir)) {
  console.log('Checking BWW archives...');
  runArchiveDir(bwwDir, validateBwwArchive);
}

// Show Score archives
if (fs.existsSync(showScoreDir)) {
  console.log('Checking Show Score archives...');
  runArchiveDir(showScoreDir, validateShowScoreArchive);
}

// Report results
console.log('\n=== Results ===\n');
console.log(`Checked: ${results.checked}`);
console.log(`Valid: ${results.valid}`);
console.log(`Mismatches: ${results.mismatches.length}`);
console.log(`Warnings: ${results.warnings.length}`);

if (results.mismatches.length > 0) {
  console.log('\n❌ MISMATCHES (need refetch):');
  results.mismatches.forEach(m => {
    console.log(`\n  ${m.showId} (${m.source}):`);
    console.log(`    File: ${m.file}`);
    console.log(`    Issue: ${m.issue}`);
    console.log(`    Expected: ${JSON.stringify(m.expected)}`);
    console.log(`    Found: ${JSON.stringify(m.found)}`);
  });
}

if (results.warnings.length > 0) {
  console.log('\n⚠️  WARNINGS (review manually):');
  results.warnings.forEach(w => {
    console.log(`  ${w.showId} (${w.source}): ${w.issue}`);
  });
}

// Save report
const reportPath = path.join(DATA_DIR, 'audit', 'archive-production-validation.json');
const reportDir = path.dirname(reportPath);
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

fs.writeFileSync(reportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  summary: {
    checked: results.checked,
    valid: results.valid,
    mismatches: results.mismatches.length,
    warnings: results.warnings.length
  },
  mismatches: results.mismatches,
  warnings: results.warnings
}, null, 2));

console.log(`\n✅ Report saved to ${reportPath}`);

// Exit with error only if mismatches exceed threshold (stale archives accumulate naturally)
if (exceedsMismatchThreshold(results.mismatches.length)) {
  console.log(`\n❌ ${results.mismatches.length} mismatches exceed threshold of ${MISMATCH_THRESHOLD}`);
  console.log('\n🔧 To fix, run:');
  const showsToFix = [...new Set(results.mismatches.map(m => m.showId))];
  console.log(`   gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=${showsToFix.join(',')} --field force=true`);
  process.exit(1);
} else if (results.mismatches.length > 0) {
  console.log(`\n⚠️  ${results.mismatches.length} mismatches (within threshold of ${MISMATCH_THRESHOLD})`);
  console.log('\n🔧 To fix, run:');
  const showsToFix = [...new Set(results.mismatches.map(m => m.showId))];
  console.log(`   gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=${showsToFix.join(',')} --field force=true`);
}
