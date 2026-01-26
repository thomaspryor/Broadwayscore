#!/usr/bin/env node
/**
 * fetch-show-images-auto.js
 *
 * Automatically discovers and fetches images for ALL shows:
 * 1. Searches TodayTix for the show to get its TodayTix ID
 * 2. Fetches the show page and finds Contentful image URLs
 * 3. Uses Contentful's Image Transformation API to generate:
 *    - Square 1080x1080 (thumbnail for cards)
 *    - Portrait 720x1080 (poster for show pages)
 *    - Landscape 1920x800 (hero banner)
 *
 * KEY INSIGHT: TodayTix uses Contentful CDN which can transform ANY image
 * on the fly. We find the best source images (poster key art + production
 * photos) and request them in whatever dimensions we need via URL params.
 *
 * No hardcoded IDs - works for any show!
 *
 * Usage: node scripts/fetch-show-images-auto.js [--show=show-id] [--missing]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const TODAYTIX_IDS_PATH = path.join(__dirname, '..', 'data', 'todaytix-ids.json');
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchViaScrapingBee(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY not set'));
      return;
    }

    const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;

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

// Load or create TodayTix ID cache
function loadTodayTixIds() {
  try {
    return JSON.parse(fs.readFileSync(TODAYTIX_IDS_PATH, 'utf8'));
  } catch {
    return { shows: {}, lastUpdated: null };
  }
}

function saveTodayTixIds(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(TODAYTIX_IDS_PATH, JSON.stringify(data, null, 2) + '\n');
}

// Search TodayTix for a show and extract its ID
async function discoverTodayTixId(showTitle) {
  console.log(`   Searching TodayTix for "${showTitle}"...`);

  const searchUrl = `https://www.todaytix.com/nyc/shows?q=${encodeURIComponent(showTitle)}`;

  try {
    const html = await fetchViaScrapingBee(searchUrl);

    // Look for show links in format: /nyc/shows/{id}-{slug}
    const showLinkMatch = html.match(/\/nyc\/shows\/(\d+)-([a-z0-9-]+)/i);

    if (showLinkMatch) {
      const id = parseInt(showLinkMatch[1]);
      const slug = showLinkMatch[2];
      console.log(`   ✓ Found TodayTix ID: ${id} (${slug})`);
      return { id, slug };
    }

    // Try alternative pattern - JSON in page
    const jsonMatch = html.match(/"showId":\s*(\d+)/);
    if (jsonMatch) {
      const id = parseInt(jsonMatch[1]);
      console.log(`   ✓ Found TodayTix ID from JSON: ${id}`);
      return { id, slug: null };
    }

    console.log(`   ✗ Could not find TodayTix ID`);
    return null;
  } catch (err) {
    console.log(`   ✗ Search error: ${err.message}`);
    return null;
  }
}

// Contentful URL transformation parameters for different formats
// Contentful's Image API allows requesting any size/crop on the fly
const CONTENTFUL_TRANSFORMS = {
  // Square thumbnail (1:1) - good for grid cards
  square: '?w=1080&h=1080&fit=fill&f=face&fm=webp&q=90',
  // Portrait poster (2:3) - standard theatrical poster ratio
  portrait: '?w=720&h=1080&fit=fill&f=face&fm=webp&q=90',
  // Landscape hero (roughly 2.4:1) - good for hero banners
  landscape: '?w=1920&h=800&fit=fill&f=center&fm=webp&q=90'
};

// Extract the best source images from TodayTix page
// Then generate all formats using Contentful's transformation API
function extractAllImageFormats(html) {
  // Extract all Contentful image URLs
  const imageMatches = html.match(/https:\/\/images\.ctfassets\.net\/[^"'<\s]+\.(jpg|jpeg|png)/gi);

  if (!imageMatches) return null;

  // Clean URLs (remove query params) and deduplicate
  const uniqueImages = [...new Set(imageMatches.map(url => url.split('?')[0]))];

  // Find the best source images
  let posterSource = null;  // Best for portrait + square (key art)
  let heroSource = null;    // Best for landscape (production photo)

  for (const baseUrl of uniqueImages) {
    const filename = baseUrl.split('/').pop().toLowerCase();

    // Priority 1: Look for official poster/key art (best for portrait and square)
    if (filename.includes('poster') || filename.includes('key_art') || filename.includes('keyart') ||
        filename.match(/480x720|600x900|portrait/)) {
      posterSource = baseUrl;
    }

    // Priority 2: Look for production photos (best for landscape hero)
    // These are typically wider aspect ratio photos
    if (!heroSource && (filename.includes('production') || filename.includes('company') ||
        filename.includes('ensemble') || filename.match(/\d\.png$/) || filename.match(/\d\.jpg$/))) {
      heroSource = baseUrl;
    }
  }

  // Fallback: use first non-headshot image
  if (!posterSource && uniqueImages.length > 0) {
    // Avoid headshots (usually small square images of cast)
    posterSource = uniqueImages.find(url => {
      const filename = url.split('/').pop().toLowerCase();
      return !filename.match(/^[a-z]+\.(png|jpg)$/) && // Avoid single-name files like "brad.png"
             filename.length > 10; // Poster files usually have longer names
    }) || uniqueImages[0];
  }

  if (!heroSource) {
    heroSource = posterSource; // Use poster as fallback for hero
  }

  if (!posterSource) {
    return null;
  }

  // Generate all formats using Contentful transforms
  return {
    square: posterSource + CONTENTFUL_TRANSFORMS.square,
    portrait: posterSource + CONTENTFUL_TRANSFORMS.portrait,
    landscape: heroSource + CONTENTFUL_TRANSFORMS.landscape,
    // Keep raw sources for debugging
    _sources: { poster: posterSource, hero: heroSource }
  };
}

async function fetchShowImages(show, todayTixInfo) {
  console.log(`\n📽️  ${show.title}`);

  if (!todayTixInfo || !todayTixInfo.id) {
    console.log(`   ✗ No TodayTix ID available`);
    return null;
  }

  const slug = todayTixInfo.slug || show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url = `https://www.todaytix.com/nyc/shows/${todayTixInfo.id}-${slug}`;
  console.log(`   Fetching: ${url}`);

  try {
    const html = await fetchViaScrapingBee(url);
    const images = extractAllImageFormats(html);

    if (images && (images.square || images.portrait || images.landscape)) {
      console.log(`   ✓ Found source images:`);
      if (images._sources?.poster) {
        const posterFile = images._sources.poster.split('/').pop();
        console.log(`     - Poster source: ${posterFile}`);
      }
      if (images._sources?.hero && images._sources.hero !== images._sources?.poster) {
        const heroFile = images._sources.hero.split('/').pop();
        console.log(`     - Hero source: ${heroFile}`);
      }
      console.log(`   ✓ Generated formats via Contentful transforms:`);
      console.log(`     - Square 1080x1080 (thumbnail): ✓`);
      console.log(`     - Portrait 720x1080 (poster): ✓`);
      console.log(`     - Landscape 1920x800 (hero): ✓`);

      // Format for shows.json
      return {
        hero: images.landscape,
        thumbnail: images.square,
        poster: images.portrait,
      };
    }

    console.log(`   ✗ No images found in page`);
    return null;
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
  const onlyMissing = args.includes('--missing');

  if (!SCRAPINGBEE_API_KEY) {
    console.error('ERROR: Set SCRAPINGBEE_API_KEY environment variable');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('AUTO-FETCH SHOW IMAGES');
  console.log('='.repeat(60));

  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf8'));
  const todayTixIds = loadTodayTixIds();

  // Filter shows
  let shows = showsData.shows.filter(s => s.status === 'open' || s.status === 'previews');

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    console.log(`Filtering to show: ${showFilter}`);
  }

  if (onlyMissing) {
    shows = shows.filter(s => !s.images?.poster || !s.images?.thumbnail);
    console.log(`Processing only shows with missing images: ${shows.length}`);
  }

  console.log(`\nProcessing ${shows.length} shows...\n`);

  const results = { success: [], failed: [], skipped: [] };

  for (const show of shows) {
    // Check if we have TodayTix ID cached
    let todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];

    // If not cached, try to discover it
    if (!todayTixInfo) {
      todayTixInfo = await discoverTodayTixId(show.title);
      if (todayTixInfo) {
        todayTixIds.shows[show.id] = todayTixInfo;
        saveTodayTixIds(todayTixIds);
      }
      await sleep(2000); // Rate limit
    }

    // Fetch images
    const images = await fetchShowImages(show, todayTixInfo);

    if (images) {
      show.images = images;
      results.success.push(show.title);
    } else {
      results.failed.push(show.title);
    }

    await sleep(2000); // Rate limit between shows
  }

  // Save updated shows
  if (results.success.length > 0) {
    showsData._meta = showsData._meta || {};
    showsData._meta.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(SHOWS_JSON_PATH, JSON.stringify(showsData, null, 2) + '\n');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`✓ Success: ${results.success.length}`);
  console.log(`✗ Failed: ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log(`\nFailed shows:`);
    results.failed.forEach(s => console.log(`  - ${s}`));
  }

  // GitHub Actions output
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `images_fetched=${results.success.length}\n`);
    fs.appendFileSync(outputFile, `images_failed=${results.failed.length}\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
