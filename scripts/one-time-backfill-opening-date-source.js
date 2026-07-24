#!/usr/bin/env node
/**
 * One-time backfill: Add openingDateSource to all shows in shows.json
 *
 * Rules:
 *   - Broadway/OB shows with openingDate → "ibdb" (IBDB is the authoritative source)
 *   - WE/OWE shows where openingDate === previewsStartDate → "todaytix" (known bad path)
 *   - WE/OWE shows with distinct dates → "theatremonkey" (enrichment set them)
 *   - WE/OWE shows with openingDate but no previewsStartDate → "unknown" (legacy data)
 *   - Shows with no openingDate → null (no source to track)
 *
 * Usage:
 *   node scripts/one-time-backfill-opening-date-source.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const dryRun = process.argv.includes('--dry-run');

const data = loadShows();
const shows = data.shows;

let tagged = { ibdb: 0, todaytix: 0, theatremonkey: 0, unknown: 0, none: 0 };

for (const show of shows) {
  if (show.openingDateSource) continue; // Already tagged

  const cat = show.category || 'broadway';
  const isWE = cat === 'west-end' || cat === 'off-west-end';
  const isBW = cat === 'broadway' || cat === 'off-broadway';

  if (!show.openingDate) {
    // No opening date — nothing to source-track
    tagged.none++;
    continue;
  }

  if (isBW) {
    show.openingDateSource = 'ibdb';
    tagged.ibdb++;
  } else if (isWE) {
    if (show.previewsStartDate && show.openingDate === show.previewsStartDate) {
      // Same date = TodayTix startDate was incorrectly stored as both
      show.openingDateSource = 'todaytix';
      tagged.todaytix++;
    } else if (show.previewsStartDate && show.openingDate !== show.previewsStartDate) {
      // Distinct dates = enrichment script set the press night correctly
      show.openingDateSource = 'theatremonkey';
      tagged.theatremonkey++;
    } else {
      // Has openingDate but no previewsStartDate — legacy or ambiguous
      show.openingDateSource = 'unknown';
      tagged.unknown++;
    }
  }
}

console.log('Backfill results:');
console.log(`  ibdb (Broadway/OB): ${tagged.ibdb}`);
console.log(`  todaytix (WE same-date): ${tagged.todaytix}`);
console.log(`  theatremonkey (WE distinct dates): ${tagged.theatremonkey}`);
console.log(`  unknown (WE legacy): ${tagged.unknown}`);
console.log(`  no openingDate (skipped): ${tagged.none}`);
console.log(`  total tagged: ${tagged.ibdb + tagged.todaytix + tagged.theatremonkey + tagged.unknown}`);

if (!dryRun) {
  saveShows(data);
  console.log('\nWrote shows.json');
} else {
  console.log('\n(dry run — no changes written)');
}
