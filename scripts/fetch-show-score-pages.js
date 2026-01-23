#!/usr/bin/env node
/**
 * Fetch Show Score pages and archive them
 * This script is designed to be run locally with Playwright
 *
 * Usage: node scripts/fetch-show-score-pages.js
 */

const fs = require('fs');
const path = require('path');

const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const archivePath = path.join(__dirname, '../data/aggregator-archive/show-score');

// Ensure archive directory exists
if (!fs.existsSync(archivePath)) {
  fs.mkdirSync(archivePath, { recursive: true });
}

// Load URL mapping
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const shows = urlData.shows;

// List shows that need to be fetched
const showIds = Object.keys(shows);
console.log(`Found ${showIds.length} shows to process:\n`);

showIds.forEach((showId, index) => {
  const url = shows[showId];
  const archiveFile = path.join(archivePath, `${showId}.html`);
  const exists = fs.existsSync(archiveFile);

  console.log(`${index + 1}. ${showId}`);
  console.log(`   URL: ${url}`);
  console.log(`   Archive: ${exists ? 'EXISTS' : 'MISSING'}`);
  console.log();
});

console.log('\n=== Summary ===');
const existing = showIds.filter(id => fs.existsSync(path.join(archivePath, `${id}.html`)));
const missing = showIds.filter(id => !fs.existsSync(path.join(archivePath, `${id}.html`)));
console.log(`Existing: ${existing.length}`);
console.log(`Missing: ${missing.length}`);

if (missing.length > 0) {
  console.log('\nMissing shows:');
  missing.forEach(id => console.log(`  - ${id}`));
}
