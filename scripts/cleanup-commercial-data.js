#!/usr/bin/env node
/**
 * cleanup-commercial-data.js
 *
 * One-time (rerunnable) cleanup of commercial.json data quality issues:
 * 1. Fix id-mismatch keys (rename to slug)
 * 2. Remove deprecated recoupedWeeks fields
 * 3. Auto-designate closed TBD shows as Fizzle
 * 4. Add empty sources arrays where missing
 * 5. Remove orphaned entries (no matching show in shows.json)
 *
 * INTENTIONALLY NOT SCHEDULED (audit #982): unlike dedupe-commercial-id-keys.js
 * (self-healed weekly in commercial-weekly.yml), this script has no size cap
 * on how much it deletes/auto-designates per run — step 5 silently drops
 * every orphaned entry and step 3 auto-designates every closed-TBD show as
 * Fizzle with no citation, no --force gate. Run by hand, review the dry-run
 * diff first: node scripts/cleanup-commercial-data.js --dry-run
 *
 * Usage: node scripts/cleanup-commercial-data.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { loadCommercial, saveCommercial } = require('./lib/commercial-write-guard');
const { conflictingFields } = require('./lib/commercial-key-duplicates');

const DRY_RUN = process.argv.includes('--dry-run');

const commercialPath = path.join(__dirname, '..', 'data', 'commercial.json');
const showsPath = path.join(__dirname, '..', 'data', 'shows.json');

const commercial = loadCommercial();
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const allShows = showsData.shows || [];

// Build lookups
const slugSet = new Set();
const idSet = new Set();
const idToShow = {};
const slugToShow = {};
for (const s of allShows) {
  if (s && typeof s === 'object') {
    slugSet.add(s.slug || '');
    idSet.add(s.id || '');
    idToShow[s.id] = s;
    slugToShow[s.slug] = s;
  }
}

const shows = commercial.shows || {};
const changes = { renamed: [], removedRecoupedWeeks: 0, designationFixed: [], sourcesAdded: 0, orphansRemoved: [] };

// 1. Fix id-mismatch keys (key matches show ID but not slug)
const keysToRename = [];
for (const key of Object.keys(shows)) {
  if (idSet.has(key) && !slugSet.has(key)) {
    const show = idToShow[key];
    if (show && show.slug) {
      keysToRename.push({ oldKey: key, newKey: show.slug, title: show.title });
    }
  }
}

for (const { oldKey, newKey, title } of keysToRename) {
  if (!shows[newKey]) {
    shows[newKey] = shows[oldKey];
    delete shows[oldKey];
    changes.renamed.push(`${oldKey} -> ${newKey} (${title})`);
  } else {
    // Duplicate key pair: the slug entry already exists. If the ID entry
    // holds nothing the slug entry lacks (shared conflictingFields predicate,
    // model-stamped fields ignored), deleting it is lossless — the exact
    // resurrection case behind the 2026-08-01 model-drift alert, which this
    // script previously just SKIPped and left double-counted forever.
    const conflicts = conflictingFields(shows[oldKey], shows[newKey]);
    if (conflicts.length === 0) {
      delete shows[oldKey];
      changes.renamed.push(`${oldKey} deleted (duplicate of existing ${newKey}, no unique data) (${title})`);
    } else {
      console.warn(`  SKIP rename ${oldKey} -> ${newKey}: target exists AND ID entry has unique fields (${conflicts.join(', ')}) — resolve with node scripts/dedupe-commercial-id-keys.js`);
    }
  }
}

// 2. Remove orphaned entries (no matching show)
const orphansToRemove = [];
for (const key of Object.keys(shows)) {
  if (!slugSet.has(key) && !idSet.has(key)) {
    orphansToRemove.push(key);
  }
}
for (const key of orphansToRemove) {
  const entry = shows[key];
  changes.orphansRemoved.push(`${key} (designation: ${entry.designation || 'none'})`);
  delete shows[key];
}

// 3. Remove deprecated recoupedWeeks fields
for (const [key, val] of Object.entries(shows)) {
  if (val && typeof val === 'object' && 'recoupedWeeks' in val) {
    delete val.recoupedWeeks;
    changes.removedRecoupedWeeks++;
  }
}

// 4. Auto-designate closed TBD shows as Fizzle
for (const [key, val] of Object.entries(shows)) {
  if (val && typeof val === 'object' && val.designation === 'TBD') {
    // Find the show
    const show = slugToShow[key] || idToShow[key];
    if (show && show.status === 'closed') {
      val.designation = 'Fizzle';
      if (!val.notes) val.notes = '';
      val.notes = val.notes
        ? val.notes + ' [Auto-designated Fizzle: closed without known recoupment data]'
        : '[Auto-designated Fizzle: closed without known recoupment data]';
      changes.designationFixed.push(`${key}: TBD -> Fizzle (${show.title})`);
    }
  }
}

// 5. Add empty sources arrays where missing
for (const [key, val] of Object.entries(shows)) {
  if (val && typeof val === 'object' && !val.sources) {
    val.sources = [];
    changes.sourcesAdded++;
  }
}

// Report
console.log('\n=== Commercial Data Cleanup ===\n');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

if (changes.renamed.length) {
  console.log(`Renamed ${changes.renamed.length} id-mismatch keys:`);
  for (const r of changes.renamed) console.log(`  ${r}`);
}

if (changes.orphansRemoved.length) {
  console.log(`\nRemoved ${changes.orphansRemoved.length} orphaned entries:`);
  for (const o of changes.orphansRemoved) console.log(`  ${o}`);
}

if (changes.removedRecoupedWeeks) {
  console.log(`\nRemoved recoupedWeeks from ${changes.removedRecoupedWeeks} entries`);
}

if (changes.designationFixed.length) {
  console.log(`\nFixed ${changes.designationFixed.length} closed TBD designations:`);
  for (const d of changes.designationFixed) console.log(`  ${d}`);
}

if (changes.sourcesAdded) {
  console.log(`\nAdded empty sources array to ${changes.sourcesAdded} entries`);
}

const totalChanges = changes.renamed.length + changes.orphansRemoved.length +
  changes.removedRecoupedWeeks + changes.designationFixed.length + changes.sourcesAdded;

console.log(`\nTotal changes: ${totalChanges}`);

if (!DRY_RUN && totalChanges > 0) {
  // Update meta
  if (!commercial._meta) commercial._meta = {};
  commercial._meta.lastUpdated = new Date().toISOString();
  // This script deliberately deletes orphaned entries (step 2) — allowShrink
  // avoids the guard's shrink-guard tripping on a legitimate prune.
  saveCommercial(commercial, { allowShrink: true });
  console.log(`\nWrote ${commercialPath}`);
} else if (DRY_RUN) {
  console.log('\nDry run — no files written.');
}

console.log(`\nFinal show count: ${Object.keys(shows).length}`);
