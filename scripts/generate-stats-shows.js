#!/usr/bin/env node
/**
 * Generate public/data/stats-shows.json — the slim show catalog for the web
 * Stats view (critic score, review count, audience grade, status), so the
 * browser never downloads the 2.2MB app catalog for four numbers per show.
 * Projection logic and format: scripts/lib/stats-shows.js.
 *
 * Source: public/data/mobile-shows.json, so it MUST run after
 * generate-mobile-data.js. The output is gitignored and rebuilt by every
 * `npm run build` (scripts/prebuild.sh runs it on both the fast and the full
 * path), so no workflow has to stage it.
 *
 * Run: node scripts/generate-stats-shows.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { hasHelpFlag } = require('./lib/cli-help');
const { projectStatsShows } = require('./lib/stats-shows');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(
    'Usage: node scripts/generate-stats-shows.js\n\n' +
      'Writes public/data/stats-shows.json (web Stats catalog) from public/data/mobile-shows.json. Takes no arguments.',
  );
  process.exit(0);
}

const inputPath = path.join(__dirname, '../public/data/mobile-shows.json');
const outputPath = path.join(__dirname, '../public/data/stats-shows.json');
// The app feed carries ~2,600 shows; far fewer means a truncated input.
const MIN_EXPECTED_SHOWS = 1000;

function main() {
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(inputPath, 'utf-8')).shows || [];
  } catch (err) {
    // Cloud stubs / fresh checkouts without data: write an empty catalog so
    // the fetch never 404s (the Stats view degrades to "no critic scores").
    console.warn(`⚠ mobile-shows.json unreadable (${err.message}) — writing empty stats-shows.json`);
  }
  if (rows.length > 0 && rows.length < MIN_EXPECTED_SHOWS) {
    throw new Error(`only ${rows.length} shows in mobile-shows.json (expected ≥${MIN_EXPECTED_SHOWS}) — input looks truncated`);
  }
  const out = projectStatsShows(rows);
  const json = JSON.stringify(out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json + '\n');
  const rawKb = (json.length / 1024).toFixed(0);
  const gzKb = (zlib.gzipSync(json).length / 1024).toFixed(0);
  console.log(
    `✓ stats-shows.json: ${Object.keys(out.shows).length} shows (${Object.keys(out.meta).length} with meta) from ${rows.length} app-feed rows (${rawKb} KB raw / ${gzKb} KB gz)`,
  );
}

main();
