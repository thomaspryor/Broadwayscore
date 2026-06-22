#!/usr/bin/env node
/**
 * Generate search shows JSON for client-side HeaderSearch
 *
 * Extracts minimal show data needed for search into a static JSON file,
 * removing ~342KB of duplicated data from every page's RSC payload.
 *
 * Generates: public/data/search-shows.json (~150KB)
 * Run: node scripts/generate-search-shows.js
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

// Load data files
const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));
const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf-8'));

const shows = showsData.shows;
const reviews = reviewsData.reviews;

// Build set of show IDs that have at least one scored review
const showsWithScores = new Set();
for (const review of reviews) {
  if (review.assignedScore != null) {
    showsWithScores.add(review.showId);
  }
}

// Regional (non-NYC US) shows are hidden from the search index until the `regional`
// feature flag is enabled — mirrors data-core regionalSlugAllowed() so search,
// detail page, sitemap, and OG all light up together (never an orphaned indexed page).
const regionalEnabled = (process.env.NEXT_PUBLIC_FEATURES || '')
  .split(',').map(s => s.trim()).includes('regional');

// Filter out unscored closed shows (historical shows without reviews)
// These are hidden in HeaderSearch anyway — no point shipping them to every user
const visibleShows = shows.filter(show =>
  (regionalEnabled || show.category !== 'regional') &&
  (showsWithScores.has(show.id) || show.status !== 'closed')
);

// Map shows to search-friendly format (matching HeaderSearch's Show interface)
const searchShows = visibleShows.map(show => {
  const entry = {
    id: show.id,
    title: show.title,
    slug: show.slug,
    status: show.status,
  };

  if (show.venue) entry.venue = show.venue;

  const creativeTeamNames = show.creativeTeam
    ? show.creativeTeam.map(m => m.name).join(', ')
    : '';
  if (creativeTeamNames) entry.creativeTeamNames = creativeTeamNames;

  if (show.images && show.images.thumbnail) {
    entry.images = { thumbnail: show.images.thumbnail };
  }

  // Don't mark pre-2005 closed shows as having scores (reviews hidden)
  const openingYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 9999;
  const hideReviews = openingYear < 2005 && show.status === 'closed';
  if (showsWithScores.has(show.id) && !hideReviews) {
    entry.hasScore = true;
  }

  if (show.category && show.category !== 'broadway') {
    entry.category = show.category;
  }

  // Extract year from opening date or show ID for disambiguation
  if (show.openingDate) {
    entry.year = show.openingDate.slice(0, 4);
  } else {
    const idYear = show.id.match(/(\d{4})$/);
    if (idYear) entry.year = idYear[1];
  }

  return entry;
});

// Write compact JSON (no pretty-print to minimize file size)
const outputPath = path.join(outputDir, 'search-shows.json');
fs.writeFileSync(outputPath, JSON.stringify(searchShows));

const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
const excluded = shows.length - visibleShows.length;
console.log(`Generated ${outputPath} (${sizeKB}KB, ${searchShows.length} shows, ${showsWithScores.size} with scores, ${excluded} unscored closed excluded)`);
