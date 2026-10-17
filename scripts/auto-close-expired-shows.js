#!/usr/bin/env node
/**
 * Auto-close shows whose closingDate has passed.
 *
 * Runs as part of scheduled maintenance or before any rebuild.
 * Prevents stale "open" statuses from failing data validation.
 *
 * Usage:
 *   node scripts/auto-close-expired-shows.js [--dry-run]
 */

const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `auto-close-expired-shows.js — Auto-close shows whose closingDate has passed.

Usage:
  node scripts/auto-close-expired-shows.js [options]
  node scripts/auto-close-expired-shows.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

const { closeExpiredShows } = require('./lib/auto-close-expired');

const data = loadShows();
const closedList = closeExpiredShows(data.shows, { apply: !dryRun });
const closed = closedList.length;

if (closed === 0) {
  console.log('No expired shows to close.');
  process.exit(0);
}

if (dryRun) {
  console.log(`[DRY RUN] Would close ${closed} show(s):`);
} else {
  saveShows(data);
  console.log(`Closed ${closed} expired show(s):`);
}

for (const s of closedList) {
  console.log(`  ${s.id} (closed ${s.closingDate}, ${s.market})`);
}
