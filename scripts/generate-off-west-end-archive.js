#!/usr/bin/env node
/**
 * Generate Off-West End archive JSON for lazy-loading closed shows.
 *
 * Same bug as #1425/generate-off-broadway-archive.js: the /off-west-end page
 * only ever passes active (open/previews) shows as React props, so closed
 * Off-West End shows are invisible to that page's own search/filter box even
 * with Status: All/Closed selected (#1448). This script generates a static
 * JSON file with closed Off-West End shows (5+ reviews) that the client
 * fetches on demand when the user filters to ALL/CLOSED or searches.
 *
 * Market membership mirrors getOffWestEndShows()/belongsOnOffWestEndHub() in
 * src/lib/data-core.ts + src/lib/genre.ts: category 'off-west-end', plus any
 * West End-category show with a non-theatrical genre (dance/magic/comedy/
 * cabaret/concert/circus) routed here instead of the plays/musicals listing.
 *
 * Output format matches the OffWestEndShow interface from
 * OffWestEndPageClient.tsx. Shared generation logic lives in
 * scripts/lib/generate-market-archive.js (also used by
 * generate-off-broadway-archive.js).
 *
 * Generates: public/data/off-west-end-archive.json
 * Run: node scripts/generate-off-west-end-archive.js
 * Or via: npm run prebuild
 */

const { generateMarketArchive } = require('./lib/generate-market-archive');
const { isNonTheatricalGenre } = require('./lib/genre-classification');

function isLondonCategory(category) {
  return category === 'west-end' || category === 'off-west-end';
}

// Mirrors HIDDEN_LONDON_IDS in src/lib/data-core.ts — shows deliberately
// excluded from the West End / Off-West End hubs. Kept in sync manually;
// there is currently no cross-file parity test for this (unlike
// NON_THEATRICAL_GENRES, which genre-policy-parity.test.mjs enforces).
const HIDDEN_LONDON_IDS = new Set(['abba-voyage-off-west-end-2026']);

generateMarketArchive({
  outputFilename: 'off-west-end-archive.json',
  entryCategory: 'off-west-end',
  belongsToMarket: show => show.category === 'off-west-end' ||
    (isNonTheatricalGenre(show.genre) && isLondonCategory(show.category)),
  excludeIds: HIDDEN_LONDON_IDS,
  label: 'Off-West End',
});
