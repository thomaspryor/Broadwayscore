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

const DEBUG = process.argv.includes('--debug');

// TodayTix show IDs for Broadway shows
// Hardcoded fallback images - these will be populated when found
// Run with --debug to see raw API responses for troubleshooting
const FALLBACK_IMAGES = {
  'harry-potter': {
    hero: 'https://s1.ticketm.net/dam/a/f51/7134553e-a0a1-45ef-9e48-f66fdfb03f51_RETINA_PORTRAIT_3_2.jpg',
    thumbnail: 'https://s1.ticketm.net/dam/a/f51/7134553e-a0a1-45ef-9e48-f66fdfb03f51_RETINA_PORTRAIT_3_2.jpg',
    poster: 'https://images.ctfassets.net/6pezt69ih962/7DkPjyhwUJBllOdMPllkYT/253ff4da66b108f69fb1d26d64ce53bf/TT-109547-017703-TodayTix-480x720.jpg',
  },
};

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
  'oh-mary': { id: 37743, slug: 'oh-mary' },
  'operation-mincemeat': { id: 42735, slug: 'operation-mincemeat-on-broadway' },
  'bug': { id: 45086, slug: 'bug-on-broadway' },
  'harry-potter': { id: 13709, slug: 'harry-potter-and-the-cursed-child-on-broadway' },
  'mamma-mia': { id: 43887, slug: 'mamma-mia-on-broadway' },
  'stranger-things': { id: 41967, slug: 'stranger-things-the-first-shadow-on-broadway' },
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
  // Return an object with separate URLs for different image types when possible
  try {
    const result = { poster: null, hero: null, thumbnail: null };

    // Path 1: data.show.images array - extract POSTER and HERO separately
    if (data?.data?.show?.images?.length > 0) {
      const images = data.data.show.images;

      // Look for POSTER type (usually square or portrait)
      const posterImg = images.find(i => i.type === 'POSTER');
      if (posterImg?.file?.url) result.poster = posterImg.file.url;

      // Look for HERO type (usually landscape banner)
      const heroImg = images.find(i => i.type === 'HERO');
      if (heroImg?.file?.url) result.hero = heroImg.file.url;

      // Look for THUMBNAIL type
      const thumbImg = images.find(i => i.type === 'THUMBNAIL' || i.type === 'SQUARE');
      if (thumbImg?.file?.url) result.thumbnail = thumbImg.file.url;

      // If we found at least poster or hero, return the result
      if (result.poster || result.hero) {
        return result;
      }

      // Fallback: use first image for everything
      if (images[0]?.file?.url) {
        return images[0].file.url;
      }
    }

    // Path 2: Check for separate posterImageUrl and heroImageUrl
    if (data?.data?.show?.posterImageUrl || data?.data?.show?.heroImageUrl) {
      result.poster = data.data.show.posterImageUrl;
      result.hero = data.data.show.heroImageUrl;
      if (result.poster || result.hero) return result;
    }

    // Path 3: data.images array directly
    if (data?.images?.length > 0) {
      const images = data.images;

      const posterImg = images.find(i => i.type === 'POSTER');
      if (posterImg?.file?.url) result.poster = posterImg.file.url;
      if (posterImg?.url) result.poster = posterImg.url;

      const heroImg = images.find(i => i.type === 'HERO');
      if (heroImg?.file?.url) result.hero = heroImg.file.url;
      if (heroImg?.url) result.hero = heroImg.url;

      if (result.poster || result.hero) return result;

      // Fallback to first image
      if (images[0]?.file?.url) return images[0].file.url;
      if (images[0]?.url) return images[0].url;
    }

    // Path 4: Direct posterImageUrl / heroImageUrl
    if (data?.posterImageUrl || data?.heroImageUrl) {
      result.poster = data.posterImageUrl;
      result.hero = data.heroImageUrl;
      if (result.poster || result.hero) return result;
    }

    // Path 5: Look for any ctfassets URL in the response
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

  // Pattern 3: Any Contentful image URL in the page - PRIORITIZE POSTER IMAGES
  const ctfMatches = html.match(/https:\/\/images\.ctfassets\.net\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+\/[^"'\s<>]+\.(jpg|jpeg|png|webp)/gi);
  if (ctfMatches && ctfMatches.length > 0) {
    // Prioritize poster/square images over landscape banners
    // Look for images with poster dimensions in filename (480x720, 600x900, etc)
    const posterImages = ctfMatches.filter(url =>
      url.includes('480x720') || url.includes('600x900') || url.includes('TodayTix-480x720') ||
      url.includes('_Poster') || url.includes('-Poster') || url.includes('poster')
    );
    if (posterImages.length > 0) {
      return posterImages[0];
    }

    // Otherwise return longest URL (usually has most detail)
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

function formatImageUrls(imageData) {
  if (!imageData) return null;

  // If imageData is a string (single URL), convert to object
  if (typeof imageData === 'string') {
    imageData = { hero: imageData, poster: null, thumbnail: null };
  }

  // Extract URLs and clean them
  let heroUrl = imageData.hero ? imageData.hero.split('?')[0] : null;
  let posterUrl = imageData.poster ? imageData.poster.split('?')[0] : null;
  let thumbnailUrl = imageData.thumbnail ? imageData.thumbnail.split('?')[0] : null;

  // Fallback: if we only have one type, use it for all
  const fallbackUrl = heroUrl || posterUrl || thumbnailUrl;
  if (!fallbackUrl) return null;

  heroUrl = heroUrl || fallbackUrl;

  // Try to construct poster/thumbnail URLs by replacing dimensions in filename
  if (!posterUrl && fallbackUrl.includes('1440x580')) {
    posterUrl = fallbackUrl.replace('1440x580', '480x720');
  } else {
    posterUrl = posterUrl || fallbackUrl;
  }

  if (!thumbnailUrl && fallbackUrl.includes('1440x580')) {
    thumbnailUrl = fallbackUrl.replace('1440x580', '480x720');
  } else {
    thumbnailUrl = thumbnailUrl || fallbackUrl;
  }

  // Helper to add Contentful params
  const addParams = (url, width, height, fit = 'pad', quality = 90, focus = null) => {
    if (url.includes('ctfassets.net')) {
      let params = `w=${width}&h=${height}&fit=${fit}&q=${quality}`;
      if (focus && fit === 'fill') {
        params += `&f=${focus}`;
      }
      if (fit === 'pad') {
        params += '&bg=rgb:1a1a1a';
      }
      return `${url}?${params}`;
    }
    return url;
  };

  // Format each image type with appropriate dimensions and fit strategy
  return {
    hero: addParams(heroUrl, 1920, 1080, 'pad', 90),              // Landscape 16:9 - use pad to preserve full image
    thumbnail: addParams(thumbnailUrl, 400, 400, 'fill', 80, 'center'), // Square 1:1 - smart crop from center
    poster: addParams(posterUrl, 600, 900, 'fill', 85, 'center'),       // Portrait 2:3 - smart crop from center
  };
}

async function fetchShowImage(showSlug, showInfo) {
  console.log(`\n📽️  ${showSlug}`);

  // Method 1: Try TodayTix API v2
  const apiUrl = `https://api.todaytix.com/api/v2/shows/${showInfo.id}`;
  console.log(`   API v2: ${apiUrl}`);

  try {
    const apiData = await fetchJson(apiUrl);
    if (DEBUG) {
      console.log(`   DEBUG: API response keys: ${Object.keys(apiData || {}).join(', ')}`);
      const jsonStr = JSON.stringify(apiData);
      const ctfMatch = jsonStr.match(/ctfassets\.net[^"\\]*/);
      if (ctfMatch) console.log(`   DEBUG: Found ctfassets pattern: ${ctfMatch[0].substring(0, 80)}`);
    }
    const imageUrl = extractImageFromApi(apiData);
    if (imageUrl) {
      console.log(`   ✓ Found via API v2: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ API v2 failed: ${err.message}`);
  }

  // Method 1b: Try TodayTix API v3
  const apiV3Url = `https://api.todaytix.com/api/v3/shows/${showInfo.id}`;
  console.log(`   API v3: ${apiV3Url}`);

  try {
    const apiData = await fetchJson(apiV3Url);
    if (DEBUG) {
      console.log(`   DEBUG: API v3 response keys: ${Object.keys(apiData || {}).join(', ')}`);
    }
    const imageUrl = extractImageFromApi(apiData);
    if (imageUrl) {
      console.log(`   ✓ Found via API v3: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ API v3 failed: ${err.message}`);
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
  console.log(`   Content API: ${altApiUrl}`);

  try {
    const altData = await fetchJson(altApiUrl);
    const imageUrl = extractImageFromApi(altData);
    if (imageUrl) {
      console.log(`   ✓ Found via Content API: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ Content API failed: ${err.message}`);
  }

  // Method 3b: Try TodayTix show details endpoint
  const detailsUrl = `https://api.todaytix.com/api/v2/shows/${showInfo.id}/details`;
  console.log(`   Details API: ${detailsUrl}`);

  try {
    const detailsData = await fetchJson(detailsUrl);
    const imageUrl = extractImageFromApi(detailsData);
    if (imageUrl) {
      console.log(`   ✓ Found via Details API: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ Details API failed: ${err.message}`);
  }

  // Method 3c: Try TodayTix media endpoint
  const mediaUrl = `https://api.todaytix.com/api/v2/shows/${showInfo.id}/media`;
  console.log(`   Media API: ${mediaUrl}`);

  try {
    const mediaData = await fetchJson(mediaUrl);
    const imageUrl = extractImageFromApi(mediaData);
    if (imageUrl) {
      console.log(`   ✓ Found via Media API: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ Media API failed: ${err.message}`);
  }

  // Method 4: Try Broadway.com
  const broadwaySlug = showSlug.replace(/-/g, '');
  const broadwayUrl = `https://www.broadway.com/shows/${showInfo.slug || showSlug}/`;
  console.log(`   Broadway.com: ${broadwayUrl}`);

  try {
    const html = await fetchPage(broadwayUrl);
    const imageUrl = extractImageFromHtml(html);
    if (imageUrl) {
      console.log(`   ✓ Found via Broadway.com: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ Broadway.com failed: ${err.message}`);
  }

  // Method 5: Try Playbill
  const playbillUrl = `https://playbill.com/production/${showSlug}`;
  console.log(`   Playbill: ${playbillUrl}`);

  try {
    const html = await fetchPage(playbillUrl);
    // Playbill uses different image patterns
    const imgMatch = html.match(/https:\/\/bsp-static\.playbill\.com\/[^"'\s]+\.(jpg|jpeg|png|webp)/i) ||
                     html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (imgMatch) {
      const imageUrl = imgMatch[1] || imgMatch[0];
      console.log(`   ✓ Found via Playbill: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ Playbill failed: ${err.message}`);
  }

  // Method 6: Try TheaterMania
  const theaterManiaSlug = showSlug.replace(/-/g, '-');
  const theaterManiaUrl = `https://www.theatermania.com/shows/broadway/${theaterManiaSlug}`;
  console.log(`   TheaterMania: ${theaterManiaUrl}`);

  try {
    const html = await fetchPage(theaterManiaUrl);
    const imageUrl = extractImageFromHtml(html);
    if (imageUrl) {
      console.log(`   ✓ Found via TheaterMania: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ TheaterMania failed: ${err.message}`);
  }

  // Method 7: Try TodayTix with just ID (no slug)
  const simplePageUrl = `https://www.todaytix.com/nyc/shows/${showInfo.id}`;
  console.log(`   TodayTix (ID only): ${simplePageUrl}`);

  try {
    const html = await fetchPage(simplePageUrl);
    const imageUrl = extractImageFromHtml(html);
    if (imageUrl) {
      console.log(`   ✓ Found via TodayTix ID: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ TodayTix ID failed: ${err.message}`);
  }

  // Method 8: Try TodayTix GraphQL API
  console.log(`   TodayTix GraphQL API...`);
  try {
    const graphqlData = await fetchTodayTixGraphQL(showInfo.id);
    const imageUrl = extractImageFromApi(graphqlData);
    if (imageUrl) {
      console.log(`   ✓ Found via GraphQL: ${imageUrl.substring(0, 60)}...`);
      return formatImageUrls(imageUrl);
    }
  } catch (err) {
    console.log(`   ⚠ GraphQL failed: ${err.message}`);
  }

  // Method 9: Use hardcoded fallback if available
  if (FALLBACK_IMAGES[showSlug]) {
    console.log(`   ⚠ Using hardcoded fallback image`);
    const fallback = FALLBACK_IMAGES[showSlug];
    // If fallback is already an object with hero/thumbnail/poster, return as-is
    if (typeof fallback === 'object' && fallback.hero) {
      return fallback;
    }
    // Otherwise treat as a single URL
    return formatImageUrls(fallback);
  }

  console.log(`   ✗ No image found from any source`);
  return null;
}

function fetchTodayTixGraphQL(showId) {
  return new Promise((resolve, reject) => {
    const query = JSON.stringify({
      operationName: 'GetShow',
      variables: { showId: showId },
      query: `query GetShow($showId: Int!) {
        show(id: $showId) {
          id
          name
          images {
            type
            file { url }
          }
          heroImageUrl
          posterImageUrl
          thumbnailImageUrl
        }
      }`
    });

    const options = {
      hostname: 'api.todaytix.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(query),
      },
      timeout: 15000,
    };

    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.data || parsed);
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(query);
    req.end();
  });
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
