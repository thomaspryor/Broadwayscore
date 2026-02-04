#!/usr/bin/env node
/**
 * Apply Commercial Pending Data
 *
 * Merges data from commercial-pending-review.json into commercial.json
 * after human review. Runs validation after applying.
 *
 * Usage:
 *   node scripts/apply-commercial-pending.js [options]
 *
 * Options:
 *   --all              Apply all pending entries
 *   --show=SLUG        Apply a single show by slug/ID
 *   --dry-run          Preview without writing
 *   --exclude=SLUG,... Skip specific shows
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');

// CLI args
const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const APPLY_ALL = flags['all'] === true;
const SINGLE_SHOW = flags['show'] || null;
const EXCLUDES = flags['exclude'] ? flags['exclude'].split(',') : [];

function main() {
  if (!fs.existsSync(PENDING_PATH)) {
    console.log('❌ No pending file found at', PENDING_PATH);
    process.exit(1);
  }

  const pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  const commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));

  if (!pending.shows || Object.keys(pending.shows).length === 0) {
    console.log('No pending shows to apply.');
    return;
  }

  console.log(`📋 Pending file has ${Object.keys(pending.shows).length} shows`);
  console.log(`💰 Commercial.json has ${Object.keys(commercial.shows || {}).length} shows`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  // Filter to target shows
  let showIds;
  if (SINGLE_SHOW) {
    showIds = [SINGLE_SHOW].filter(id => pending.shows[id]);
    if (showIds.length === 0) {
      console.log(`❌ Show "${SINGLE_SHOW}" not found in pending file`);
      process.exit(1);
    }
  } else if (APPLY_ALL) {
    showIds = Object.keys(pending.shows).filter(id => !EXCLUDES.includes(id));
  } else {
    console.log('Specify --all to apply all, or --show=SLUG for a single show.');
    console.log('');
    console.log('Pending shows:');
    for (const [id, data] of Object.entries(pending.shows)) {
      const inCommercial = commercial.shows?.[id] ? ' (ALREADY IN commercial.json)' : '';
      console.log(`  ${id}: ${data.designation || 'TBD'} | Cap: ${data.capitalization ? '$' + (data.capitalization / 1e6).toFixed(1) + 'M' : '?'} | Conf: ${data.confidence || '?'}${inCommercial}`);
    }
    return;
  }

  let applied = 0;
  let skipped = 0;

  for (const showId of showIds) {
    const entry = pending.shows[showId];
    if (!entry) continue;

    if (commercial.shows[showId]) {
      console.log(`  ⏭️  "${showId}" already in commercial.json — skipping`);
      skipped++;
      continue;
    }

    // Build clean commercial entry
    const commercialEntry = {};
    if (entry.designation) commercialEntry.designation = entry.designation;
    if (entry.capitalization != null) commercialEntry.capitalization = entry.capitalization;
    if (entry.capitalizationSource) commercialEntry.capitalizationSource = entry.capitalizationSource;
    if (entry.weeklyRunningCost != null) commercialEntry.weeklyRunningCost = entry.weeklyRunningCost;
    if (entry.costMethodology) commercialEntry.costMethodology = entry.costMethodology;
    if (entry.recouped != null) commercialEntry.recouped = entry.recouped;
    if (entry.recoupedDate) commercialEntry.recoupedDate = entry.recoupedDate;
    if (entry.recoupedSource) commercialEntry.recoupedSource = entry.recoupedSource;
    if (entry.notes) commercialEntry.notes = entry.notes;
    if (entry.sources && entry.sources.length > 0) commercialEntry.sources = entry.sources;

    commercialEntry.lastUpdated = new Date().toISOString().split('T')[0];
    commercialEntry.firstAdded = new Date().toISOString().split('T')[0];

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would apply "${showId}" → ${JSON.stringify(commercialEntry, null, 2).slice(0, 200)}...`);
    } else {
      commercial.shows[showId] = commercialEntry;
      console.log(`  ✅ Applied "${showId}" → ${commercialEntry.designation || 'TBD'}`);
    }
    applied++;
  }

  if (!DRY_RUN && applied > 0) {
    fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2) + '\n');
    console.log(`\n✅ Applied ${applied} shows, ${skipped} skipped`);

    // Run validation
    console.log('\n🔍 Running validation...');
    try {
      execSync('node scripts/validate-data.js', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
      });
      console.log('✅ Validation passed');
    } catch {
      console.error('❌ Validation FAILED — review commercial.json for issues');
      process.exit(1);
    }

    // Remove applied shows from pending
    for (const showId of showIds) {
      if (!commercial.shows[showId]) continue; // wasn't applied
      delete pending.shows[showId];
    }
    if (Object.keys(pending.shows).length > 0) {
      fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
      console.log(`📋 ${Object.keys(pending.shows).length} shows remaining in pending file`);
    } else {
      fs.unlinkSync(PENDING_PATH);
      console.log('📋 Pending file cleared');
    }
  } else if (DRY_RUN) {
    console.log(`\n🏁 Dry run: would apply ${applied}, skip ${skipped}`);
  }
}

main();
