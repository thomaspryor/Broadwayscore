#!/usr/bin/env node
/**
 * validate-shows-prebuild.js
 *
 * Build-time gate: prevents Vercel deploys if shows.json contains duplicates.
 * Runs as part of the "prebuild" npm script before every build.
 *
 * Exit codes: 0 = clean, 1 = duplicates found (build fails)
 */

const fs = require('fs');
const path = require('path');
const { checkForDuplicate } = require('./lib/deduplication');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const shows = data.shows || data;

const duplicates = [];

for (let i = 1; i < shows.length; i++) {
  const check = checkForDuplicate(shows[i], shows.slice(0, i));
  if (check.isDuplicate) {
    duplicates.push(
      `"${shows[i].title}" (${shows[i].id}) duplicates "${check.existingShow.title}" (${check.existingShow.id}) — ${check.reason}`
    );
  }
}

if (duplicates.length > 0) {
  console.error('\n\x1b[31mBUILD BLOCKED: Duplicate shows detected in shows.json\x1b[0m\n');
  duplicates.forEach(d => console.error(`  - ${d}`));
  console.error('\nRemove duplicates before deploying.\n');
  process.exit(1);
}

console.log(`Prebuild check: ${shows.length} shows, no duplicates.`);
