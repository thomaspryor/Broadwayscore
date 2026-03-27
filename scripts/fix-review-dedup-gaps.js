#!/usr/bin/env node
/**
 * Fix review duplicate gaps identified by audit-review-duplicates.js:
 * 1. Outlet-as-critic duplicates: add duplicateOf to loser files
 * 2. URL-domain mismatches with suggestion: update outletId/outlet in JSON (NOT rename files)
 *
 * Reads from: data/audit/duplicate-review-files.json
 * Modifies: data/review-texts/{showId}/*.json
 *
 * Usage:
 *   node scripts/fix-review-dedup-gaps.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { getOutletDisplayName } = require('./lib/review-normalization');

const DRY_RUN = process.argv.includes('--dry-run');
const auditPath = path.join(__dirname, '..', 'data', 'audit', 'duplicate-review-files.json');
const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

function main() {
  console.log(`=== Fix Review Dedup Gaps ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  if (!fs.existsSync(auditPath)) {
    console.error('ERROR: Run scripts/audit-review-duplicates.js first to generate audit data');
    process.exit(1);
  }

  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const stats = {
    outletAsCriticFixed: 0,
    domainMismatchFixed: 0,
    domainMismatchSkipped: 0,
    errors: 0,
  };

  // === Fix 1: Outlet-as-critic duplicates ===
  console.log(`── Fix 1: Outlet-as-critic duplicates (${audit.outlet_as_critic?.length || 0}) ──`);
  for (const dupe of (audit.outlet_as_critic || [])) {
    const loserPath = path.join(reviewTextsDir, dupe.showId, dupe.loserFile.split('/').pop());
    try {
      if (!fs.existsSync(loserPath)) {
        console.log(`  SKIP: ${loserPath} not found`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(loserPath, 'utf8'));
      if (data.duplicateOf) {
        console.log(`  SKIP: ${dupe.loserFile} already flagged`);
        continue;
      }

      const winnerFilename = dupe.winnerFile.split('/').pop();
      data.duplicateOf = winnerFilename;
      console.log(`  FLAG: ${dupe.loserFile} → duplicateOf: ${winnerFilename}`);

      if (!DRY_RUN) {
        fs.writeFileSync(loserPath, JSON.stringify(data, null, 2) + '\n');
      }
      stats.outletAsCriticFixed++;
    } catch (err) {
      console.error(`  ERROR: ${loserPath}: ${err.message}`);
      stats.errors++;
    }
  }

  // === Fix 2: URL-domain mismatches with suggestions ===
  const fixable = (audit.domain_mismatches || []).filter(m => m.suggestedOutletId);
  const unfixable = (audit.domain_mismatches || []).filter(m => !m.suggestedOutletId);

  console.log(`\n── Fix 2: URL-domain mismatches (${fixable.length} fixable, ${unfixable.length} need manual review) ──`);
  for (const mismatch of fixable) {
    const filePath = path.join(reviewTextsDir, mismatch.showId, mismatch.file.split('/').pop());
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`  SKIP: ${filePath} not found`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Don't fix if already flagged
      if (data.duplicateOf || data.wrongShow || data.wrongProduction) {
        console.log(`  SKIP: ${mismatch.file} already flagged`);
        stats.domainMismatchSkipped++;
        continue;
      }

      const newOutletId = mismatch.suggestedOutletId;
      const newDisplayName = mismatch.suggestedDisplayName || getOutletDisplayName(newOutletId) || newOutletId;

      console.log(`  FIX: ${mismatch.file}`);
      console.log(`    outletId: ${data.outletId} → ${newOutletId}`);
      console.log(`    outlet: ${data.outlet} → ${newDisplayName}`);

      // Preserve the original attribution for audit trail
      if (!data._originalOutletId) {
        data._originalOutletId = data.outletId;
        data._originalOutlet = data.outlet;
      }
      data.outletId = newOutletId;
      data.outlet = newDisplayName;

      if (!DRY_RUN) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      stats.domainMismatchFixed++;
    } catch (err) {
      console.error(`  ERROR: ${filePath}: ${err.message}`);
      stats.errors++;
    }
  }

  // Log unfixable mismatches
  if (unfixable.length > 0) {
    console.log(`\n── Unfixable domain mismatches (${unfixable.length}) — need manual review ──`);
    for (const m of unfixable.slice(0, 20)) {
      console.log(`  ${m.showId}/${m.file.split('/').pop()}: outlet=${m.currentOutletId}, url domain=${m.urlDomain}`);
    }
    if (unfixable.length > 20) {
      console.log(`  ... and ${unfixable.length - 20} more`);
    }
  }

  // Summary
  console.log(`\n=== SUMMARY ===`);
  console.log(`Outlet-as-critic fixed: ${stats.outletAsCriticFixed}`);
  console.log(`Domain mismatches fixed: ${stats.domainMismatchFixed}`);
  console.log(`Domain mismatches skipped: ${stats.domainMismatchSkipped}`);
  console.log(`Unfixable (manual review): ${unfixable.length}`);
  console.log(`Errors: ${stats.errors}`);
  if (DRY_RUN) console.log('\n(Dry run — no files modified)');
}

main();
