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

const { planSharedIbdbUrlFixes } = require('./lib/fix-shared-ibdb-urls');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-shared-ibdb-urls.js — Null stale shared ibdbUrls in data/shows.json (self-heal for the.

Usage:
  node scripts/fix-shared-ibdb-urls.js [options]
  node scripts/fix-shared-ibdb-urls.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const DRY_RUN = process.argv.includes('--dry-run');

// loadShows() (not require(SHOWS_PATH)) — require()'s module cache returns an
// object the guard never snapshotted, so saveShows() below would silently
// skip the concurrent-writer merge.
const data = loadShows();
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
