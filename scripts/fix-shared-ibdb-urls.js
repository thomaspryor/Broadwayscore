#!/usr/bin/env node
'use strict';

/**
 * Null stale shared ibdbUrls in data/shows.json (self-heal for the
 * validate-data.js "Shared ibdbUrl" hard error). The earliest production
 * keeps the URL; later entries are cleared. See scripts/lib/fix-shared-ibdb-urls.js
 * for the decision logic and incident history.
 *
 * Usage:
 *   node scripts/fix-shared-ibdb-urls.js [--dry-run]
 */

const path = require('path');
const { planSharedIbdbUrlFixes } = require('./lib/fix-shared-ibdb-urls');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const DRY_RUN = process.argv.includes('--dry-run');
const SHOWS_PATH = process.env.SHOWS_JSON_PATH || path.join(__dirname, '../data/shows.json');

const data = require(SHOWS_PATH);
const fixes = planSharedIbdbUrlFixes(data.shows);

if (fixes.length === 0) {
  console.log('No shared ibdbUrls found — nothing to fix.');
  process.exit(0);
}

for (const fix of fixes) {
  console.log(`${DRY_RUN ? '[dry-run] would null' : 'Nulling'} ibdbUrl on ${fix.id} (kept on ${fix.keptOn}): ${fix.ibdbUrl}`);
  if (!DRY_RUN) {
    const show = data.shows.find(s => s.id === fix.id);
    show.ibdbUrl = null;
  }
}

if (!DRY_RUN) {
  saveShows(data);
  console.log(`\nCleared ${fixes.length} stale ibdbUrl(s). shows.json written.`);
} else {
  console.log(`\n[dry-run] ${fixes.length} stale ibdbUrl(s) would be cleared.`);
}
