#!/usr/bin/env node
/**
 * Apply curated images from curated-images.json to shows.json
 * This allows manual curation of high-quality images for each show
 */

const fs = require('fs');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const CURATED_JSON_PATH = path.join(__dirname, '..', 'data', 'curated-images.json');

const USAGE = `apply-curated-images.js — Apply curated images from curated-images.json to shows.json.

Usage:
  node scripts/apply-curated-images.js [options]
  node scripts/apply-curated-images.js --help, -h    print this usage and exit
`;

function formatImageUrl(url, params) {
  if (!url) return null;
  const baseUrl = url.split('?')[0];
  return `${baseUrl}?${params}`;
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  // Load data
  const showsData = loadShows();
  const curatedData = JSON.parse(fs.readFileSync(CURATED_JSON_PATH, 'utf8'));

  let updatedCount = 0;

  // Apply curated images to each show
  for (const show of showsData.shows) {
    const curated = curatedData.images[show.slug];

    if (curated) {
      console.log(`✓ Applying curated images for: ${show.title}`);

      // Build images object with proper formatting
      show.images = {
        // Hero: landscape image for banners
        hero: curated.landscape
          ? formatImageUrl(curated.landscape, 'w=1920&h=1080&fit=pad&q=90&bg=rgb:1a1a1a')
          : show.images?.hero,

        // Thumbnail: square image for homepage cards
        thumbnail: curated.square
          ? formatImageUrl(curated.square, 'h=450&fm=webp&q=90')
          : show.images?.thumbnail,

        // Poster: portrait image for show detail pages
        poster: curated.portrait
          ? formatImageUrl(curated.portrait, 'h=450&f=faces&fit=fill&fm=webp&q=90')
          : show.images?.poster,
      };

      updatedCount++;
    }
  }

  // Save updated shows.json
  showsData._meta.lastUpdated = new Date().toISOString();
  saveShows(showsData);

  console.log(`\n✓ Updated ${updatedCount} shows in shows.json`);
  console.log(`\nTo add more shows, edit: data/curated-images.json`);
  console.log(`Then run: node scripts/apply-curated-images.js`);
}

main();
