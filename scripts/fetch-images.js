#!/usr/bin/env node
/**
 * Broadway Metascore Image Fetcher
 *
 * Usage:
 *   node scripts/fetch-images.js           # Fetch all and auto-update shows.json
 *   node scripts/fetch-images.js --list    # Just list TodayTix URLs
 *   node scripts/fetch-images.js --dry-run # Fetch but don't update shows.json
 *
 * Uses TodayTix API for reliable image fetching with HTML fallback.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

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

function fetchJson(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
    };

    const req = https.request(options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetchJson(response.headers.location, retries).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      response.on('error', reject);
    });

    req.on('error', async (err) => {
      if (retries > 0) {
        await sleep(RETRY_DELAY);
        fetchJson(url, retries - 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

function fetchPage(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
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
        await sleep(RETRY_DELAY);
        fetchPage(url, retries - 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function extractImageFromApi(data) {
  // Try different paths in the API response
  try {
    // Path 1: data.show.images
    if (data?.data?.show?.images?.length > 0) {
      const img = data.data.show.images.find(i => i.type === 'HERO' || i.type === 'POSTER') || data.data.show.images[0];
      if (img?.file?.url) return img.file.url;
    }

    // Path 2: data.show.heroImageUrl
    if (data?.data?.show?.heroImageUrl) {
      return data.data.show.heroImageUrl;
    }

    // Path 3: data.images array directly
    if (data?.images?.length > 0) {
      const img = data.images.find(i => i.type === 'HERO' || i.type === 'POSTER') || data.images[0];
      if (img?.file?.url) return img.file.url;
      if (img?.url) return img.url;
    }

    // Path 4: data.heroImageUrl
    if (data?.heroImageUrl) return data.heroImageUrl;

    // Path 5: data.posterImageUrl
    if (data?.posterImageUrl) return data.posterImageUrl;

    // Path 6: Look for any ctfassets URL in the response
    const jsonStr = JSON.stringify(data);
    const ctfMatch = jsonStr.match(/https:\/\/images\.ctfassets\.net\/[^"\\]+/);
    if (ctfMatch) return ctfMatch[0];

  } catch (e) {
    // Ignore parsing errors
  }
  return null;
}

function extractImageFromHtml(html) {
  // Pattern 1: og:image meta tag
  const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogMatch && ogMatch[1].includes('ctfassets.net')) return ogMatch[1];

  // Pattern 2: twitter:image
  const twitterMatch = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (twitterMatch && twitterMatch[1].includes('ctfassets.net')) return twitterMatch[1];

  // Pattern 3: Any Contentful image URL in the page
  const ctfMatches = html.match(/https:\/\/images\.ctfassets\.net\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi);
  if (ctfMatches && ctfMatches.length > 0) {
    const sorted = ctfMatches.sort((a, b) => b.length - a.length);
    return sorted[0];
  }

  // Pattern 4: Look for __NEXT_DATA__ JSON with image URLs
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/i);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const imageUrl = extractImageFromApi(nextData?.props?.pageProps);
      if (imageUrl) return imageUrl;
    } catch (e) {
      // Ignore JSON parse errors
    }
  }

  // Pattern 5: Any og:image
  if (ogMatch) return ogMatch[1];

  return null;
}

function formatImageUrls(baseUrl) {
  if (!baseUrl) return null;

  // Clean up URL
  const cleanUrl = baseUrl.split('?')[0];

  if (cleanUrl.includes('ctfassets.net')) {
    return {
      hero: `${cleanUrl}?w=1920&h=1080&fit=fill&q=90`,
      thumbnail: `${cleanUrl}?w=400&h=400&fit=fill&q=80`,
      poster: `${cleanUrl}?w=600&h=900&fit=fill&q=85`,
    };
  }

  return { hero: baseUrl, thumbnail: baseUrl, poster: baseUrl };
}

async function fetchShowImage(showSlug, showInfo) {
  console.log(`\n📽️  ${showSlug}`);

  // Method 1: Try TodayTix API
  const apiUrl = `https://api.todaytix.com/api/v2/shows/${showInfo.id}`;
  console.log(`   API: ${apiUrl}`);

  try {
    const apiData = await fetchJson(apiUrl);
    const imageUrl = extractImageFromApi(apiData);
    if (imageUrl) {
      console.log(`   ✓ Found via API: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ API failed: ${err.message}`);
  }

  // Method 2: Try HTML scraping
  const pageUrl = `https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`;
  console.log(`   HTML: ${pageUrl}`);

  try {
    const html = await fetchPage(pageUrl);
    const imageUrl = extractImageFromHtml(html);
    if (imageUrl) {
      console.log(`   ✓ Found via HTML: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ HTML failed: ${err.message}`);
  }

  // Method 3: Try alternate API endpoint
  const altApiUrl = `https://content-service.todaytix.com/content/shows/${showInfo.id}`;
  console.log(`   Alt API: ${altApiUrl}`);

  try {
    const altData = await fetchJson(altApiUrl);
    const imageUrl = extractImageFromApi(altData);
    if (imageUrl) {
      console.log(`   ✓ Found via Alt API: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ Alt API failed: ${err.message}`);
  }

  console.log(`   ✗ No image found`);
  return null;
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
    await sleep(500);
  }

  console.log('\n\n================================');
  console.log('Summary');
  console.log('================================');
  console.log(`✓ Success: ${Object.keys(results).length} shows`);
  console.log(`✗ Failed: ${failed.length} shows`);

  if (failed.length > 0) {
    console.log(`  Failed shows: ${failed.join(', ')}`);
  }

  const outputPath = path.join(__dirname, 'image-urls.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nRaw results saved to: ${outputPath}`);

  if (!isDryRun && Object.keys(results).length > 0) {
    const updatedCount = updateShowsJson(results);
    console.log(`\n✓ Updated ${updatedCount} shows in shows.json`);
  }

  if (failed.length > 0) {
    console.log('\n⚠️  Some shows failed. Re-running may help.');
    process.exit(1);
  }
}

function listShowUrls() {
  console.log('TodayTix Show URLs:');
  console.log('==================\n');
  for (const [showSlug, showInfo] of Object.entries(TODAYTIX_SHOWS)) {
    console.log(`${showSlug}:`);
    console.log(`  Web: https://www.todaytix.com/nyc/shows/${showInfo.id}-${showInfo.slug}`);
    console.log(`  API: https://api.todaytix.com/api/v2/shows/${showInfo.id}`);
  }
}

if (process.argv.includes('--list')) {
  listShowUrls();
} else {
  main().catch(console.error);
}
