#!/usr/bin/env node
/**
 * Generate Off-Broadway archive JSON for lazy-loading closed shows.
 *
 * Mirrors generate-homepage-archive.js: the /off-broadway page and the
 * homepage's OB shelf only pass active (open/previews) Off-Broadway shows as
 * React props, so closed OB shows were previously invisible to both pages'
 * on-page search/filter — even with Status: All selected (#1425). This
 * script generates a static JSON file with closed OB shows (5+ reviews) that
 * the client fetches on demand when the user filters to ALL/CLOSED or
 * searches.
 *
 * Output format matches the OffBroadwayShow interface from
 * OffBroadwayPageClient.tsx. Shared generation logic lives in
 * scripts/lib/generate-market-archive.js (also used by
 * generate-off-west-end-archive.js).
 *
 * Generates: public/data/off-broadway-archive.json
 * Run: node scripts/generate-off-broadway-archive.js
 * Or via: npm run prebuild
 */

const { generateMarketArchive } = require('./lib/generate-market-archive');

generateMarketArchive({
  outputFilename: 'off-broadway-archive.json',
  entryCategory: 'off-broadway',
  belongsToMarket: show => show.category === 'off-broadway',
  label: 'Off-Broadway',
});
