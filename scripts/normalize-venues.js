#!/usr/bin/env node
/**
 * Normalize venue names in shows.json to canonical forms
 */
const path = require('path');
const { getCanonicalVenueName, validateVenue } = require('./lib/broadway-theaters.js');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
// loadShows() (not a raw parse) — snapshots the object so saveShows() below
// can merge against concurrent writers instead of overwriting them.
const data = loadShows();

console.log('=== VENUE NORMALIZATION ===\n');

let changes = 0;
const normalized = [];

// Special cases where we want to keep the common name
const KEEP_COMMON_NAME = {
  'Harold and Miriam Steinberg Center for Theatre': 'Studio 54', // Everyone knows it as Studio 54
};

data.shows.forEach(show => {
  const validation = validateVenue(show.venue);

  if (validation.isValid && validation.canonical !== show.venue) {
    // Check if we should keep the common name instead
    const finalName = KEEP_COMMON_NAME[validation.canonical] || validation.canonical;

    if (finalName !== show.venue) {
      normalized.push({
        id: show.id,
        from: show.venue,
        to: finalName
      });
      show.venue = finalName;
      changes++;
    }
  }
});

if (changes > 0) {
  console.log(`Normalizing ${changes} venue(s):\n`);
  normalized.forEach(n => {
    console.log(`  ${n.id}:`);
    console.log(`    "${n.from}" → "${n.to}"`);
  });

  // Update lastUpdated
  data._meta.lastUpdated = new Date().toISOString();

  saveShows(data);
  console.log(`\n✅ Updated ${SHOWS_FILE}`);
} else {
  console.log('No venues need normalization.');
}
