#!/usr/bin/env node
/**
 * One-time cleanup: Audit all cast files for IBDB URL mismatches,
 * delete bad files, and clear bad ibdbUrls from shows.json.
 *
 * Uses the new titleMatchScore() to systematically detect mismatches
 * rather than hardcoding specific patterns like "24-hour-plays".
 *
 * Usage: node scripts/fix-bad-ibdb-cast.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');

const { extractTitleFromIBDBUrl, normalizeForTitleMatch, titleMatchScore } = require('./lib/ibdb-dates');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-bad-ibdb-cast.js — One-time cleanup: Audit all cast files for IBDB URL mismatches,.

Usage:
  node scripts/fix-bad-ibdb-cast.js [options]
  node scripts/fix-bad-ibdb-cast.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const dryRun = process.argv.includes('--dry-run');

// Load shows for title lookup
const showsData = loadShows();
const showTitles = {};
for (const show of showsData.shows) {
  showTitles[show.id] = show.title;
}

// Audit all cast files
const castFiles = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));
const badFiles = [];
const flagged = [];

for (const file of castFiles) {
  const filePath = path.join(CAST_DIR, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const showId = data.showId || file.replace('.json', '');
  const showTitle = showTitles[showId];

  if (!showTitle || !data.ibdbUrl) continue;

  const score = titleMatchScore(showTitle, data.ibdbUrl, '');
  const urlTitle = extractTitleFromIBDBUrl(data.ibdbUrl);

  if (score <= -10) {
    // Clear mismatch — delete
    badFiles.push({ showId, showTitle, urlTitle, ibdbUrl: data.ibdbUrl, score, file });
  } else if (score === 0) {
    // Weak match — flag for review but don't delete
    flagged.push({ showId, showTitle, urlTitle, score });
  }
}

console.log(`Scanned ${castFiles.length} cast files`);
console.log(`\n=== BAD MATCHES (score <= -10, will delete) === ${badFiles.length} found`);
for (const b of badFiles) {
  console.log(`  ${b.showId} ("${b.showTitle}") → "${b.urlTitle}" [score ${b.score}]`);
}

if (flagged.length > 0) {
  console.log(`\n=== FLAGGED (score = 0, not deleting) === ${flagged.length} found`);
  for (const f of flagged) {
    console.log(`  ${f.showId} ("${f.showTitle}") → "${f.urlTitle}" [score ${f.score}]`);
  }
}

if (badFiles.length === 0) {
  console.log('\nNo bad cast files found. All clean!');
  process.exit(0);
}

if (dryRun) {
  console.log(`\n*** DRY RUN — would delete ${badFiles.length} files and clear ${badFiles.length} ibdbUrls ***`);
  process.exit(0);
}

// Delete bad cast files
let deleted = 0;
for (const b of badFiles) {
  const filePath = path.join(CAST_DIR, b.file);
  fs.unlinkSync(filePath);
  deleted++;
}
console.log(`\nDeleted ${deleted} bad cast file(s)`);

// Clear bad ibdbUrls from shows.json
let cleared = 0;
const badShowIds = new Set(badFiles.map(b => b.showId));
for (const show of showsData.shows) {
  if (badShowIds.has(show.id) && show.ibdbUrl) {
    show.ibdbUrl = null;
    cleared++;
  }
}

if (cleared > 0) {
  saveShows(showsData);
  console.log(`Cleared ${cleared} bad ibdbUrl(s) from shows.json`);
}

console.log('\nDone. Re-run backfill-cast.js to re-scrape these shows with corrected matching.');
