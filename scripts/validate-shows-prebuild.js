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
const { checkForDuplicate, slugify, normalizeTitle } = require('./lib/deduplication');
const { getMarketPool } = require('./lib/venue-classification');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const shows = data.shows || data;

const duplicates = [];

// Fast O(n) duplicate detection using hash indexes.
// Covers exact title, slug, ID-base, and normalized-title matches.
// Fuzzy matching (Levenshtein) runs at ingestion time in discover-new-shows.js,
// so the build gate only needs to catch exact duplicates that slipped through.
const titleIndex = new Map();  // lowercase title → [shows]
const slugIndex = new Map();   // slug → [shows]
const idBaseIndex = new Map(); // id base (no year/market suffix) → [shows]
const normIndex = new Map();   // normalized title → [shows]

const stripIdSuffix = (s) => s.replace(/-(?:west-end|off-broadway)(?:-\d{4})?$/, '').replace(/-\d{4}$/, '');

const addToIndex = (index, key, show) => {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(show);
};

for (const show of shows) {
  const titleLower = show.title.toLowerCase().trim();
  const slug = show.slug || slugify(show.title);
  const idBase = stripIdSuffix(slug);
  const norm = normalizeTitle(show.title);
  const market = getMarketPool(show.category);

  // Check each index for same-market collisions
  for (const [key, index] of [
    [titleLower, titleIndex],
    [slug, slugIndex],
    [idBase, idBaseIndex],
    [norm.length >= 3 ? norm : null, normIndex],
  ]) {
    if (!key) continue;
    const candidates = index.get(key);
    if (candidates) {
      const sameMarket = candidates.filter(c => getMarketPool(c.category) === market);
      if (sameMarket.length > 0) {
        // Use full checkForDuplicate for multi-production/cross-market logic
        const check = checkForDuplicate(show, sameMarket);
        if (check.isDuplicate) {
          duplicates.push(
            `"${show.title}" (${show.id}) duplicates "${check.existingShow.title}" (${check.existingShow.id}) — ${check.reason}`
          );
          break; // One duplicate finding per show is enough
        }
      }
    }
  }

  // Add to all indexes
  addToIndex(titleIndex, titleLower, show);
  addToIndex(slugIndex, slug, show);
  addToIndex(idBaseIndex, idBase, show);
  if (norm.length >= 3) addToIndex(normIndex, norm, show);
}

if (duplicates.length > 0) {
  console.error('\n\x1b[31mBUILD BLOCKED: Duplicate shows detected in shows.json\x1b[0m\n');
  duplicates.forEach(d => console.error(`  - ${d}`));
  console.error('\nRemove duplicates before deploying.\n');
  process.exit(1);
}

console.log(`Prebuild check: ${shows.length} shows, no duplicates.`);
