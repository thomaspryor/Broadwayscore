#!/usr/bin/env node
/**
 * Generate diary show data files for client-side diary/watchlist features.
 *
 * Reads data/diary-shows.json (from private repo) and produces:
 *   - public/data/diary-search.json  — for diary search + Mezzanine import matching
 *   - public/data/diary-lookup.json  — for My Shows page display of diary-only shows
 *
 * These are lazy-loaded only when needed (not bundled with main search/lookup).
 *
 * Run: node scripts/generate-diary-data.js
 * Or via: npm run prebuild
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');
// Override lets the "diary-shows.json missing" e2e test point at a guaranteed-
// absent path instead of renaming the real symlinked data/diary-shows.json out
// of place (same class of risk as the validate-data sentinel test — see
// tests/e2e/diary-generate-script.spec.ts).
const diaryShowsPath = process.env.DIARY_SHOWS_JSON || path.join(dataDir, 'diary-shows.json');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Load diary shows — graceful fallback if missing or empty
let diaryShows = [];
try {
  const raw = JSON.parse(fs.readFileSync(diaryShowsPath, 'utf-8'));
  diaryShows = raw.shows || [];
} catch {
  // diary-shows.json doesn't exist yet — generate empty files
}

if (diaryShows.length === 0) {
  // Write empty files so fetches don't 404
  fs.writeFileSync(path.join(outputDir, 'diary-search.json'), '[]');
  fs.writeFileSync(path.join(outputDir, 'diary-lookup.json'), '[]');
  console.log('Generated empty diary data files (no diary shows yet)');
  process.exit(0);
}

// diary-search.json — minimal fields for Fuse.js fuzzy search
const searchEntries = diaryShows.map(show => {
  const entry = {
    id: show.id,
    title: show.title,
    slug: show.slug,
    status: show.status || 'closed',
    dy: true,
  };
  if (show.venue) entry.venue = show.venue;
  if (show.city) entry.city = show.city;
  if (show.openingDate) entry.od = show.openingDate;
  if (show.category && show.category !== 'broadway') entry.category = show.category;
  // Popularity signal for Add-show tiered ranking (Tier B sort: market → rc desc → od desc).
  if (show.audienceRatingsCount) entry.rc = show.audienceRatingsCount;
  return entry;
});

const searchPath = path.join(outputDir, 'diary-search.json');
fs.writeFileSync(searchPath, JSON.stringify(searchEntries));
const searchSizeKB = (fs.statSync(searchPath).size / 1024).toFixed(0);

// diary-lookup.json — compact format matching show-lookup.json structure
// Used by MyShowsClient to display diary-only shows in the user's diary/watchlist,
// the /diary-show/[id] lightweight page (poster, city, opening date), and the
// Show Stats view (rt + vk).
//
// Fields are ADDITIVE ONLY — MyShowsClient and /diary-show read this by key, so
// removing or renaming one breaks the signed-in diary. `rt` (runtime minutes)
// and `vk` (normalized venue match key) were added for Show Stats so the client
// never has to load the 1.3MB mobile-shows.json to compute hours-in-a-seat or
// theater completion. Both are omitted when unknown rather than defaulted —
// consumers apply the type-based runtime fallback themselves.
const { statsFieldsFor } = require('./lib/diary-lookup-entry');

const lookupEntries = diaryShows.map(show => {
  const entry = { id: show.id, t: show.title, s: show.slug, v: show.venue || '', dy: 1 };
  if (show.category) entry.c = show.category;
  if (show.openingDate) entry.od = show.openingDate;
  if (show.city) entry.ci = show.city;
  if (show.country) entry.co = show.country;
  if (show.posterUrl) entry.p = show.posterUrl;
  Object.assign(entry, statsFieldsFor(show));
  return entry;
});

const lookupPath = path.join(outputDir, 'diary-lookup.json');
fs.writeFileSync(lookupPath, JSON.stringify(lookupEntries));
const lookupSizeKB = (fs.statSync(lookupPath).size / 1024).toFixed(0);

console.log(`Generated diary-search.json: ${searchEntries.length} shows (${searchSizeKB}KB)`);
console.log(`Generated diary-lookup.json: ${lookupEntries.length} shows (${lookupSizeKB}KB)`);
