#!/usr/bin/env node
/**
 * Fetch ALL image formats (square, portrait, landscape) for all shows
 * Uses ScrapingBee to bypass TodayTix blocking
 *
 * Usage: node scripts/fetch-all-image-formats.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || 'YOUR_API_KEY';

const TODAYTIX_SHOWS = {
  'two-strangers': { id: 45002, slug: 'two-strangers-carry-a-cake-across-new-york' },
  'maybe-happy-ending': { id: 41018, slug: 'maybe-happy-ending-on-broadway' },
  'the-outsiders': { id: 34093, slug: 'the-outsiders' },
  'hells-kitchen': { id: 37579, slug: 'hells-kitchen-broadway' },
  'operation-mincemeat': { id: 42735, slug: 'operation-mincemeat-on-broadway' },
  'wicked': { id: 1, slug: 'wicked' },
  'chicago': { id: 22, slug: 'chicago' },
  'the-lion-king': { id: 42, slug: 'the-lion-king-on-broadway' },
  'six': { id: 20737, slug: 'six-on-broadway' },
  'hadestown': { id: 14748, slug: 'hadestown' },
  'moulin-rouge': { id: 15911, slug: 'moulin-rouge-the-musical' },
  'hamilton': { id: 384, slug: 'hamilton' },
  'the-great-gatsby': { id: 38749, slug: 'the-great-gatsby-on-broadway' },
  'oh-mary': { id: 37743, slug: 'oh-mary' },
  'stranger-things': { id: 41967, slug: 'stranger-things-the-first-shadow-on-broadway' },
  'mamma-mia': { id: 43887, slug: 'mamma-mia-on-broadway' },
  'aladdin': { id: 105, slug: 'aladdin-on-broadway' },
  'book-of-mormon': { id: 127, slug: 'the-book-of-mormon' },
  'mj': { id: 23379, slug: 'mj-the-musical-on-broadway' },
  'and-juliet': { id: 25598, slug: 'and-juliet-on-broadway' },
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchViaScrapingBee(url) {
  return new Promise((resolve, reject) => {
    const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=false`;

    https.get(scrapingBeeUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
      response.on('error', reject);
    }).on('error', reject);
  });
}

function extractAllImageFormats(html) {
  // Extract all Contentful image URLs
  const imageMatches = html.match(/https:\/\/images\.ctfassets\.net\/[^"'< ]+\.(jpg|jpeg|png|webp)/gi);

  if (!imageMatches) return null;

  const uniqueImages = [...new Set(imageMatches)];
  const result = { square: null, portrait: null, landscape: null };

  for (const url of uniqueImages) {
    const cleanUrl = url.split('?')[0];
    const filename = cleanUrl.split('/').pop();

    // Match by dimensions in filename
    if (filename.match(/1080x1080|1000x1000|square/i)) {
      result.square = cleanUrl;
    } else if (filename.match(/480x720|600x900|poster/i)) {
      result.portrait = cleanUrl;
    } else if (filename.match(/1440x580|1920x1080|hero|banner/i)) {
      result.landscape = cleanUrl;
    }
  }

  return result;
}

function formatImageUrls(images) {
  if (!images) return null;

  const { square, portrait, landscape } = images;

  // Use the best available image for each purpose
  const fallback = landscape || square || portrait;

  return {
    hero: landscape || fallback,
    thumbnail: square || fallback,
    poster: portrait || fallback,
  };
}

async function fetchShowImages(showSlug, showInfo) {
  console.log(`\n📽️  ${showSlug}`);

  const url = `https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`;
  console.log(`   Fetching via ScrapingBee: ${url}`);

  try {
    const html = await fetchViaScrapingBee(url);
    const images = extractAllImageFormats(html);

    if (images && (images.square || images.portrait || images.landscape)) {
      console.log(`   ✓ Found images:`);
      if (images.square) console.log(`     - Square: ${images.square.split('/').pop()}`);
      if (images.portrait) console.log(`     - Portrait: ${images.portrait.split('/').pop()}`);
      if (images.landscape) console.log(`     - Landscape: ${images.landscape.split('/').pop()}`);

      return formatImageUrls(images);
    }

    console.log(`   ✗ No images found`);
    return null;
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
    return null;
  }
}

function updateShowsJson(imageResults) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf8'));

  // Load curated images to preserve them
  const CURATED_JSON_PATH = path.join(__dirname, '..', 'data', 'curated-images.json');
  let curatedShows = [];
  try {
    const curatedData = JSON.parse(fs.readFileSync(CURATED_JSON_PATH, 'utf8'));
    curatedShows = Object.keys(curatedData.images || {});
  } catch (e) {
    // No curated images
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const show of showsData.shows) {
    // Skip curated shows
    if (curatedShows.includes(show.slug)) {
      skippedCount++;
      continue;
    }

    if (imageResults[show.slug]) {
      show.images = imageResults[show.slug];
      updatedCount++;
    }
  }

  showsData._meta.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(SHOWS_JSON_PATH, JSON.stringify(showsData, null, 2) + '\n');

  console.log(`\n✓ Updated ${updatedCount} shows`);
  if (skippedCount > 0) {
    console.log(`ℹ️  Skipped ${skippedCount} curated shows`);
  }

  return updatedCount;
}

async function main() {
  if (SCRAPINGBEE_API_KEY === 'YOUR_API_KEY') {
    console.error('ERROR: Set SCRAPINGBEE_API_KEY environment variable');
    process.exit(1);
  }

  console.log('Fetching ALL image formats for all shows');
  console.log('=========================================\n');

  const results = {};
  const failed = [];

  for (const [showSlug, showInfo] of Object.entries(TODAYTIX_SHOWS)) {
    const images = await fetchShowImages(showSlug, showInfo);
    if (images) {
      results[showSlug] = images;
    } else {
      failed.push(showSlug);
    }

    // Rate limiting - wait 2 seconds between requests
    await sleep(2000);
  }

  console.log('\n\n=========================================');
  console.log(`✓ Success: ${Object.keys(results).length} shows`);
  console.log(`✗ Failed: ${failed.length} shows`);

  if (failed.length > 0) {
    console.log(`  Failed: ${failed.join(', ')}`);
  }

  if (Object.keys(results).length > 0) {
    updateShowsJson(results);
  }
}

main().catch(console.error);
