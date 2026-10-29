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
const { buildShowsWithScores, isTourIndexableSlim } = require('./lib/search-shows-scores');
const { isCategoryEnabled } = require('./lib/markets');
const { isLocalOnlyShow } = require('./lib/local-market');
const { castNamesForSearch } = require('./lib/show-search-match');
const { versionedImagePath } = require('./lib/versioned-image-path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Load data files
const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));
const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf-8'));

const shows = require('./lib/show-row-guard').partitionShowRows(showsData.shows).valid;
const reviews = reviewsData.reviews;

// Build set of show IDs that have at least one scored review — unioned with
// ids whose public/data/shows/{id}.json already carries a real rendered
// Critic Score, since reviews.json alone can miss score sources folded in
// later in the pipeline (BRO-339). See scripts/lib/search-shows-scores.js.
// The slim files are already fresh here: generate-mobile-show-details.js
// always runs immediately before this script in prebuild.sh.
const showsWithScores = buildShowsWithScores(reviews, shows, path.join(outputDir, 'shows'));

// Flag-gated categories (regional, tour) are hidden from the search index until their
// feature flag is enabled — mirrors data-core regionalSlugAllowed() so search, detail
// page, sitemap, and OG all light up together (never an orphaned indexed page).

// Filter out unscored closed shows (historical shows without reviews)
// These are hidden in HeaderSearch anyway — no point shipping them to every user
// A tour with no score yet is indexed while it is live with a stop still ahead; a closed
// or unscheduled unscored one is noindexed, so it stays out of search too
// (isTourIndexableSlim mirrors src/lib/tour-listing.ts isTourIndexable, BRO-4931).
const tourSchedules = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'tour-schedules.json'), 'utf-8')).tours || {}; } catch { return {}; }
})();
const todayISO = new Date().toISOString().slice(0, 10);
const readSlim = (id) => { try { return JSON.parse(fs.readFileSync(path.join(outputDir, 'shows', `${id}.json`), 'utf-8')); } catch { return null; } };
const visibleShows = shows.filter(show =>
  isCategoryEnabled(show.category) &&
  !isLocalOnlyShow(show) && // BRO-6518: local-only shows are not in global search
  (showsWithScores.has(show.id) || show.status !== 'closed') &&
  (show.category !== 'tour' || isTourIndexableSlim(readSlim(show.id), show.status, (tourSchedules[show.id]?.stops ?? []).some(st => st.end >= todayISO)))
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

  if (Array.isArray(show.akaTitles) && show.akaTitles.length) entry.akaTitles = show.akaTitles;

  if (show.images && show.images.thumbnail) {
    entry.images = { thumbnail: versionedImagePath(show.images.thumbnail) };
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

  // Run dates for date-aware import matching: a Mezzanine/Show Score diary
  // entry with a 2025 date must not match a production that closed in 2006
  // (my-shows import mismatches, 2026-07-14).
  if (show.openingDate) entry.od = show.openingDate;
  if (show.closingDate) entry.cd = show.closingDate;

  return entry;
});

// Write compact JSON (no pretty-print to minimize file size)
const outputPath = path.join(outputDir, 'search-shows.json');
fs.writeFileSync(outputPath, JSON.stringify(searchShows));

// HeaderSearch-only extras, kept out of search-shows.json so its other
// consumers (my-shows import, list builders, admin forms) don't download them:
//  - cast: top-billed names per indexed show, so performer searches find
//    their show (BRO-4225).
//  - archive: unscored closed shows. They have live, indexable /show pages,
//    but leaving them out of search made "fleabag" and "alice in wonderland"
//    dead ends (BRO-3628); HeaderSearch ranks them last. Same category flags
//    as above; tours are excluded (an unscored closed tour is noindexed, see
//    isTourIndexableSlim).
const visibleIds = new Set(visibleShows.map(s => s.id));
const cast = {};
for (const show of visibleShows) {
  const names = castNamesForSearch(show.cast);
  if (names) cast[show.id] = names;
}
const archive = shows
  .filter(show => !visibleIds.has(show.id) && show.status === 'closed'
    && show.category !== 'tour' && isCategoryEnabled(show.category) && !isLocalOnlyShow(show))
  .map(show => {
    const entry = { id: show.id, title: show.title, slug: show.slug, status: show.status, archived: true };
    if (show.category && show.category !== 'broadway') entry.category = show.category;
    if (Array.isArray(show.akaTitles) && show.akaTitles.length) entry.akaTitles = show.akaTitles;
    const year = show.openingDate ? show.openingDate.slice(0, 4) : (show.id.match(/(\d{4})$/) || [])[1];
    if (year) entry.year = year;
    return entry;
  });
const extraPath = path.join(outputDir, 'header-search-extra.json');
fs.writeFileSync(extraPath, JSON.stringify({ cast, archive }));
console.log(`Generated ${extraPath} (${(fs.statSync(extraPath).size / 1024).toFixed(0)}KB, cast for ${Object.keys(cast).length} shows, ${archive.length} archived)`);

const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
const excluded = shows.length - visibleShows.length;
console.log(`Generated ${outputPath} (${sizeKB}KB, ${searchShows.length} shows, ${showsWithScores.size} with scores, ${excluded} unscored closed excluded)`);
