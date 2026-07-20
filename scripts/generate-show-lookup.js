#!/usr/bin/env node
/**
 * Generate show lookup JSON for My Shows page
 *
 * Extracts minimal show data needed to resolve show_id → display info
 * for the user's diary and watchlist.
 *
 * Generates: public/data/show-lookup.json
 * Run: node scripts/generate-show-lookup.js
 * Or via: npm run prebuild
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Load data files — graceful fallback if missing
let shows = [];
try {
  const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));
  shows = showsData.shows || [];
} catch (err) {
  console.warn('⚠ shows.json not found or invalid — generating empty show-lookup.json');
}

// Only include shows that users might rate (not ancient closed shows without data)
const relevantShows = shows.filter(show =>
  show.status !== 'closed' || show.closingDate
);

// Build minimal lookup entries — strip null values for size
const lookup = relevantShows.map(show => {
  const entry = { id: show.id, t: show.title, s: show.slug, v: show.venue || '' };
  if (show.type === 'musical') entry.m = 1;
  if (show.status !== 'closed') entry.st = show.status;
  if (show.category) entry.c = show.category;
  if (show.openingDate) entry.od = show.openingDate;
  if (show.closingDate) entry.cd = show.closingDate;
  // Bookability signals for watchlist labels (owner, 2026-07-20): previews
  // start date + a tickets-on-sale bit for not-yet-open shows with links.
  if (show.previewsStartDate) entry.pd = show.previewsStartDate;
  if ((show.status === 'upcoming' || show.status === 'announced') && show.ticketLinks?.length) entry.tx = 1;
  if (show.images?.poster) entry.p = show.images.poster;
  else if (show.images?.thumbnail) entry.p = show.images.thumbnail;
  return entry;
});

// Write output
const outputPath = path.join(outputDir, 'show-lookup.json');
fs.writeFileSync(outputPath, JSON.stringify(lookup));

const sizeKB = (Buffer.byteLength(JSON.stringify(lookup)) / 1024).toFixed(1);
console.log(`✓ Generated show-lookup.json: ${lookup.length} shows (${sizeKB}KB)`);
