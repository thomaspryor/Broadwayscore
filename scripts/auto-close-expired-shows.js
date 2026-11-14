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

// BRO-6725: move review-seeded UK regional opening dates to the earliest review, so new
// Guardian/census-seeded shows self-correct once their other reviews arrive.
let movedDates = [];
try {
  const reviewsPath = path.join(__dirname, '..', 'data', 'reviews.json');
  if (require('fs').existsSync(reviewsPath)) {
    const { applyMoves } = require('./reconcile-uk-regional-opening-dates');
    movedDates = applyMoves(data.shows, require(reviewsPath).reviews || []);
  }
} catch (e) { console.warn('opening-date reconcile skipped: ' + e.message); }

if (closed === 0 && movedDates.length === 0) {
  console.log('No expired shows to close.');
  process.exit(0);
}
if (movedDates.length) console.log(`${dryRun ? '[DRY RUN] Would move' : 'Moved'} ${movedDates.length} review-seeded opening date(s) to the earliest review`);
if (closed === 0) { if (!dryRun) saveShows(data); process.exit(0); }

if (dryRun) {
  console.log(`[DRY RUN] Would close ${closed} show(s):`);
} else {
  saveShows(data);
  console.log(`Closed ${closed} expired show(s):`);
}

for (const s of closedList) {
  console.log(`  ${s.id} (closed ${s.closingDate}, ${s.market})`);
}
