#!/usr/bin/env node
/**
 * fetch-show-images-auto.js
 *
 * Automatically discovers and fetches images for ALL shows:
 * 1. Searches TodayTix for the show
 * 2. Extracts TodayTix ID and images
 * 3. Saves square (thumbnail), portrait (poster), landscape (hero)
 *
 * No hardcoded IDs - works for any show!
 *
 * Usage: node scripts/fetch-show-images-auto.js [--show=show-id]
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

// Extract all image formats from TodayTix show page
function extractAllImageFormats(html) {
  // Extract all Contentful image URLs
  const imageMatches = html.match(/https:\/\/images\.ctfassets\.net\/[^"'< ]+\.(jpg|jpeg|png|webp)/gi);

  if (!imageMatches) return null;

  const uniqueImages = [...new Set(imageMatches)];
  const result = { square: null, portrait: null, landscape: null, all: [] };

  for (const url of uniqueImages) {
    const cleanUrl = url.split('?')[0];
    const filename = cleanUrl.split('/').pop().toLowerCase();
    result.all.push(cleanUrl);

    // Match by dimensions in filename or URL patterns
    if (filename.match(/1080x1080|1000x1000|500x500|square/i) || cleanUrl.includes('1080/1080')) {
      result.square = cleanUrl;
    } else if (filename.match(/480x720|600x900|400x600|poster|portrait/i) || cleanUrl.includes('480/720')) {
      result.portrait = cleanUrl;
    } else if (filename.match(/1440x580|1920x1080|1920x768|hero|banner|landscape/i) || cleanUrl.includes('1920')) {
      result.landscape = cleanUrl;
    }
  }

  // If we didn't find specific formats, try to infer from any image
  if (!result.square && !result.portrait && !result.landscape && result.all.length > 0) {
    // Use the first image as a fallback
    const firstImage = result.all[0];
    result.portrait = firstImage; // Assume it's usable as poster
  }

  return result;
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
      console.log(`   ✓ Found images:`);
      if (images.square) console.log(`     - Square (thumbnail): ✓`);
      if (images.portrait) console.log(`     - Portrait (poster): ✓`);
      if (images.landscape) console.log(`     - Landscape (hero): ✓`);

      // Format for shows.json
      const fallback = images.landscape || images.portrait || images.square;
      return {
        hero: images.landscape || fallback,
        thumbnail: images.square || fallback,
        poster: images.portrait || fallback,
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
