#!/usr/bin/env node
/**
 * Apply curated images from curated-images.json to shows.json
 * This allows manual curation of high-quality images for each show
 */

const fs = require('fs');
const path = require('path');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const CURATED_JSON_PATH = path.join(__dirname, '..', 'data', 'curated-images.json');

function formatImageUrl(url, params) {
  if (!url) return null;
  const baseUrl = url.split('?')[0];
  return `${baseUrl}?${params}`;
}

function main() {
  // Load data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf8'));
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
  showsData._meta.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(SHOWS_JSON_PATH, JSON.stringify(showsData, null, 2) + '\n');

  console.log(`\n✓ Updated ${updatedCount} shows in shows.json`);
  console.log(`\nTo add more shows, edit: data/curated-images.json`);
  console.log(`Then run: node scripts/apply-curated-images.js`);
}

main();
