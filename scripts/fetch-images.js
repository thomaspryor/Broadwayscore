#!/usr/bin/env node
/**
 * Broadway Metascore Image Fetcher
 *
 * Usage:
 *   node scripts/fetch-images.js           # Fetch all and auto-update shows.json
 *   node scripts/fetch-images.js --list    # Just list TodayTix URLs
 *   node scripts/fetch-images.js --dry-run # Fetch but don't update shows.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

// TodayTix show IDs for Broadway shows
const TODAYTIX_SHOWS = {
  'wicked': { id: 1, slug: 'wicked' },
  'chicago': { id: 22, slug: 'chicago' },
  'the-lion-king': { id: 42, slug: 'the-lion-king-on-broadway' },
  'aladdin': { id: 105, slug: 'aladdin-on-broadway' },
  'book-of-mormon': { id: 127, slug: 'the-book-of-mormon' },
  'hamilton': { id: 384, slug: 'hamilton' },
  'hadestown': { id: 14748, slug: 'hadestown' },
  'moulin-rouge': { id: 15911, slug: 'moulin-rouge-the-musical' },
  'six': { id: 20737, slug: 'six-on-broadway' },
  'mj': { id: 23379, slug: 'mj-the-musical-on-broadway' },
  'and-juliet': { id: 25598, slug: 'and-juliet-on-broadway' },
  'the-outsiders': { id: 34093, slug: 'the-outsiders' },
  'hells-kitchen': { id: 37579, slug: 'hells-kitchen-broadway' },
  'the-great-gatsby': { id: 38749, slug: 'the-great-gatsby-on-broadway' },
  'maybe-happy-ending': { id: 41018, slug: 'maybe-happy-ending-on-broadway' },
  'two-strangers': { id: 45002, slug: 'two-strangers-carry-a-cake-across-new-york' },
  'oh-mary': { id: 38371, slug: 'oh-mary' },
  'operation-mincemeat': { id: 42680, slug: 'operation-mincemeat' },
  'bug': { id: 44892, slug: 'bug' },
  'harry-potter': { id: 1377, slug: 'harry-potter-and-the-cursed-child' },
  'mamma-mia': { id: 42850, slug: 'mamma-mia' },
  'stranger-things': { id: 40958, slug: 'stranger-things-the-first-shadow' },
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchPage(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
      },
      timeout: 15000,
    };

    const req = https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location.startsWith('http')
          ? response.headers.location
          : `https://www.todaytix.com${response.headers.location}`;
        return fetchPage(redirectUrl, retries).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
      response.on('error', reject);
    });

    req.on('error', async (err) => {
      if (retries > 0) {
        console.log(`   ⟳ Retrying (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})...`);
        await sleep(RETRY_DELAY);
        fetchPage(url, retries - 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      if (retries > 0) {
        console.log(`   ⟳ Timeout, retrying (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})...`);
        sleep(RETRY_DELAY).then(() =>
          fetchPage(url, retries - 1).then(resolve).catch(reject)
        );
      } else {
        reject(new Error('Request timeout'));
      }
    });
  });
}

function extractImageUrl(html) {
  // Try multiple patterns to find the image

  // Pattern 1: og:image meta tag (most reliable)
  const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogMatch && ogMatch[1].includes('ctfassets.net')) return ogMatch[1];

  // Pattern 2: twitter:image
  const twitterMatch = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (twitterMatch && twitterMatch[1].includes('ctfassets.net')) return twitterMatch[1];

  // Pattern 3: Any Contentful image URL in the page
  const ctfMatches = html.match(/https:\/\/images\.ctfassets\.net\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi);
  if (ctfMatches && ctfMatches.length > 0) {
    // Prefer larger images (usually hero images have dimensions in URL)
    const sorted = ctfMatches.sort((a, b) => b.length - a.length);
    return sorted[0];
  }

  // Pattern 4: Any og:image (even non-Contentful)
  if (ogMatch) return ogMatch[1];

  return null;
}

async function fetchShowImage(showSlug, showInfo, retryCount = 0) {
  const url = `https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`;
  console.log(`\n📽️  ${showSlug}`);
  console.log(`   URL: ${url}`);

  try {
    const html = await fetchPage(url);
    const imageUrl = extractImageUrl(html);

    if (imageUrl) {
      console.log(`   ✓ Found image: ${imageUrl.substring(0, 70)}...`);

      // Generate different sizes using Contentful params if it's a ctfassets URL
      if (imageUrl.includes('ctfassets.net')) {
        const baseUrl = imageUrl.split('?')[0];
        return {
          hero: `${baseUrl}?w=1920&h=1080&fit=fill&q=90`,
          thumbnail: `${baseUrl}?w=400&h=400&fit=fill&q=80`,
          poster: `${baseUrl}?w=600&h=900&fit=fill&q=85`,
        };
      }

      return { hero: imageUrl, thumbnail: imageUrl, poster: imageUrl };
    } else {
      console.log(`   ✗ No image found in page`);

      // Retry with delay if no image found (page might have loaded incorrectly)
      if (retryCount < 2) {
        console.log(`   ⟳ Retrying fetch...`);
        await sleep(RETRY_DELAY * (retryCount + 1));
        return fetchShowImage(showSlug, showInfo, retryCount + 1);
      }
      return null;
    }
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);

    if (retryCount < 2) {
      console.log(`   ⟳ Retrying after error...`);
      await sleep(RETRY_DELAY * (retryCount + 1));
      return fetchShowImage(showSlug, showInfo, retryCount + 1);
    }
    return null;
  }
}

function updateShowsJson(imageResults) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf8'));
  let updatedCount = 0;

  for (const show of showsData.shows) {
    if (imageResults[show.slug]) {
      show.images = imageResults[show.slug];
      updatedCount++;
    }
  }

  // Update lastUpdated timestamp
  showsData._meta.lastUpdated = new Date().toISOString().split('T')[0];

  fs.writeFileSync(SHOWS_JSON_PATH, JSON.stringify(showsData, null, 2) + '\n');
  return updatedCount;
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('Broadway Metascore Image Fetcher');
  console.log('================================');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes)' : 'AUTO-UPDATE shows.json'}\n`);

  const results = {};
  const failed = [];

  for (const [showSlug, showInfo] of Object.entries(TODAYTIX_SHOWS)) {
    const images = await fetchShowImage(showSlug, showInfo);
    if (images) {
      results[showSlug] = images;
    } else {
      failed.push(showSlug);
    }

    // Rate limiting
    await sleep(800);
  }

  console.log('\n\n================================');
  console.log('Summary');
  console.log('================================');
  console.log(`✓ Success: ${Object.keys(results).length} shows`);
  console.log(`✗ Failed: ${failed.length} shows`);

  if (failed.length > 0) {
    console.log(`  Failed shows: ${failed.join(', ')}`);
  }

  // Save raw results
  const outputPath = path.join(__dirname, 'image-urls.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nRaw results saved to: ${outputPath}`);

  // Auto-update shows.json unless dry-run
  if (!isDryRun && Object.keys(results).length > 0) {
    const updatedCount = updateShowsJson(results);
    console.log(`\n✓ Updated ${updatedCount} shows in shows.json`);
  }

  // Exit with error code if any failed
  if (failed.length > 0) {
    console.log('\n⚠️  Some shows failed. You may want to re-run the script.');
    process.exit(1);
  }
}

function listShowUrls() {
  console.log('TodayTix Show URLs:');
  console.log('==================\n');

  for (const [showSlug, showInfo] of Object.entries(TODAYTIX_SHOWS)) {
    console.log(`${showSlug}: https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`);
  }
}

// Run
if (process.argv.includes('--list')) {
  listShowUrls();
} else {
  main().catch(console.error);
}
