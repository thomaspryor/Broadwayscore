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
 *   --min-confidence=LEVEL  Only apply entries with this confidence or higher (high, medium, all)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeSources } = require('./lib/commercial-sources');

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
const MIN_CONFIDENCE = flags['min-confidence'] || 'all';

const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };

function meetsConfidenceThreshold(entry) {
  if (MIN_CONFIDENCE === 'all') return true;
  const entryLevel = CONFIDENCE_ORDER[entry.confidence] || 0;
  const threshold = CONFIDENCE_ORDER[MIN_CONFIDENCE] || 0;
  return entryLevel >= threshold;
}

function hasRecoupedClaim(entry) {
  return entry.recouped === true || entry._recoupedClaim === true;
}

function main() {
  if (!fs.existsSync(PENDING_PATH)) {
    console.log('No pending file found at', PENDING_PATH);
    process.exit(1);
  }

  // Fail loudly on malformed JSON (don't silently produce empty results)
  let pending, commercial;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  } catch (e) {
    console.error(`FATAL: Malformed pending JSON: ${e.message}`);
    process.exit(1);
  }
  try {
    commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
  } catch (e) {
    console.error(`FATAL: Malformed commercial.json: ${e.message}`);
    process.exit(1);
  }

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

    // Confidence filter
    if (!meetsConfidenceThreshold(entry)) {
      console.log(`  ⏭️  "${showId}" — confidence ${entry.confidence || 'unknown'} below threshold ${MIN_CONFIDENCE}`);
      skipped++;
      continue;
    }

    // Safety: never auto-apply recouped:true without human review
    if (hasRecoupedClaim(entry) && !SINGLE_SHOW) {
      console.log(`  🛡️  "${showId}" — has recouped claim, requires manual review (use --show=${showId})`);
      skipped++;
      continue;
    }

    // If already exists, update rather than skip (merge new findings)
    const existing = commercial.shows[showId];
    if (existing && existing.designation && existing.designation !== 'TBD' && !SINGLE_SHOW) {
      console.log(`  "${showId}" already has designation "${existing.designation}" — skipping`);
      skipped++;
      continue;
    }

    // Build clean commercial entry, preserving research metadata from existing
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
    if (entry.sources && entry.sources.length > 0) {
      // Normalize: coerce unknown type values (e.g. "other") to validator-allowed
      // types and preserve null dates (validator tolerates null, not bad format).
      const normalized = normalizeSources(entry.sources);
      if (normalized.length > 0) commercialEntry.sources = normalized;
    }

    commercialEntry.lastUpdated = new Date().toISOString();
    commercialEntry.firstAdded = existing?.firstAdded || new Date().toISOString();

    // Preserve research tracking metadata from existing entry
    if (existing) {
      if (existing.researchAttempts != null) commercialEntry.researchAttempts = existing.researchAttempts;
      if (existing.lastResearchedAt != null) commercialEntry.lastResearchedAt = existing.lastResearchedAt;
      if (existing.researchTrigger != null) commercialEntry.researchTrigger = existing.researchTrigger;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would apply "${showId}" → ${JSON.stringify(commercialEntry, null, 2).slice(0, 200)}...`);
    } else {
      commercial.shows[showId] = commercialEntry;
      console.log(`  ✅ Applied "${showId}" → ${commercialEntry.designation || 'TBD'}`);
    }
    applied++;
  }

  if (!DRY_RUN && applied > 0) {
    // Bump top-level freshness field. health-check.js line 221 reads
    // commercial.json's _meta.lastUpdated to decide whether to flag staleness
    // in the daily digest; without this bump it stayed frozen at the last
    // full-catchup date even though shows were merging cleanly each run.
    commercial._meta = commercial._meta || {};
    commercial._meta.lastUpdated = new Date().toISOString().slice(0, 10);
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
