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

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = data.shows;

let closed = 0;
const closedList = [];

for (const show of Object.values(shows)) {
  if (show.status === 'open' && show.closingDate && show.closingDate < today) {
    closedList.push({ id: show.id, closingDate: show.closingDate, market: show.market || 'broadway' });
    if (!dryRun) {
      show.status = 'closed';
    }
    closed++;
  }
}

if (closed === 0) {
  console.log('No expired shows to close.');
  process.exit(0);
}

if (dryRun) {
  console.log(`[DRY RUN] Would close ${closed} show(s):`);
} else {
  fs.writeFileSync(SHOWS_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`Closed ${closed} expired show(s):`);
}

for (const s of closedList) {
  console.log(`  ${s.id} (closed ${s.closingDate}, ${s.market})`);
}
