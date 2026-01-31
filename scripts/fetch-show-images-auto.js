#!/usr/bin/env node
/**
 * fetch-show-images-auto.js
 *
 * Automatically discovers and fetches images for ALL shows:
 *
 * For OPEN shows (primary path - no ScrapingBee needed):
 * 1. Batch-fetches all active NYC shows from TodayTix REST API
 * 2. Matches our shows by title against API results
 * 3. Uses native image assets: posterImageSquare (1080x1080), posterImage (480x720), appHeroImage
 *
 * For CLOSED shows (fallback path - uses ScrapingBee):
 * 1. Discovers TodayTix page via Google SERP search
 * 2. Scrapes the page for Contentful image URLs
 * 3. Uses Contentful's Image Transformation API for sizing
 *
 * Last resort: Playbill OG images (landscape only, used as hero)
 *
 * No hardcoded IDs - works for any show!
 *
 * Usage: node scripts/fetch-show-images-auto.js [--show=show-id] [--missing] [--bad-images]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const TODAYTIX_IDS_PATH = path.join(__dirname, '..', 'data', 'todaytix-ids.json');
const PLAYBILL_URLS_PATH = path.join(__dirname, '..', 'data', 'playbill-urls.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
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

// Search Google via ScrapingBee SERP API for TodayTix pages (works for closed shows)
function searchGoogleForTodayTix(showTitle) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY not set'));
      return;
    }

    const query = `site:todaytix.com "${showTitle}" broadway nyc`;
    const serpUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_API_KEY}&search=${encodeURIComponent(query)}`;

    https.get(serpUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Failed to parse Google SERP response'));
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Detect shows with bad images (identical poster/thumbnail/hero from Playbill)
function hasBadImages(showId) {
  const showDir = path.join(IMAGES_DIR, showId);
  if (!fs.existsSync(showDir)) return false;

  const sizes = {};
  for (const format of ['poster', 'thumbnail', 'hero']) {
    // Check both .jpg and .webp
    const jpgPath = path.join(showDir, `${format}.jpg`);
    const webpPath = path.join(showDir, `${format}.webp`);
    const filePath = fs.existsSync(jpgPath) ? jpgPath : fs.existsSync(webpPath) ? webpPath : null;
    if (filePath) {
      sizes[format] = fs.statSync(filePath).size;
    }
  }

  // Bad if poster and thumbnail exist and are the same size (identical Playbill image)
  if (sizes.poster && sizes.thumbnail && sizes.poster === sizes.thumbnail) {
    return true;
  }

  return false;
}

// Normalize a show title for fuzzy matching against TodayTix API
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[''\u2018\u2019""\u201C\u201D:!?,.\-\u2013\u2014()&]/g, '')
    .replace(/\bon broadway\b/g, '')
    .replace(/\bthe musical\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch a page of shows from TodayTix REST API (no auth required)
function fetchTodayTixApiPage(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=1&limit=${limit}&offset=${offset}`;

    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix API HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Failed to parse TodayTix API response'));
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Fetch all active NYC shows from TodayTix API and build a lookup map
// Returns { normalizedTitle: { id, displayName, square, poster, hero, ... } }
async function fetchAllTodayTixShows() {
  console.log('\nFetching active shows from TodayTix API...');
  const allShows = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetchTodayTixApiPage(offset, limit);
    if (!response.data || response.data.length === 0) break;

    allShows.push(...response.data);
    const total = response.pagination?.total || '?';
    console.log(`   Fetched ${allShows.length}/${total} shows...`);

    if (allShows.length >= (response.pagination?.total || 0)) break;

    offset += limit;
    await sleep(500);
  }

  console.log(`   Found ${allShows.length} active shows from API\n`);

  // Extract URL from API image field (each field is an object: { file: { url: "//..." }, title })
  // and fix protocol-relative URLs (API returns //images.ctfassets.net/...)
  const extractUrl = (field) => {
    if (!field) return null;
    const url = field?.file?.url;
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('//')) return 'https:' + url;
    return url;
  };

  const lookup = {};
  for (const show of allShows) {
    const name = show.displayName || show.name;
    if (!name) continue;

    const images = show.images?.productMedia || {};
    const key = normalizeTitle(name);

    lookup[key] = {
      id: show.id,
      displayName: name,
      square: extractUrl(images.posterImageSquare),
      poster: extractUrl(images.posterImage),
      hero: extractUrl(images.appHeroImage),
      imageForAds: extractUrl(images.imageForAds),
      headerImage: extractUrl(images.headerImage),
    };
  }

  return lookup;
}

// Match our show title against the TodayTix API lookup map
function matchTodayTixShow(showTitle, apiLookup) {
  if (!apiLookup || Object.keys(apiLookup).length === 0) return null;

  const normalized = normalizeTitle(showTitle);

  // 1. Exact normalized match
  if (apiLookup[normalized]) {
    return apiLookup[normalized];
  }

  // 2. Substring containment (either direction)
  for (const [apiNorm, data] of Object.entries(apiLookup)) {
    if (apiNorm.includes(normalized) || normalized.includes(apiNorm)) {
      return data;
    }
  }

  // 3. Strip year suffix from our title and retry (e.g., "hells kitchen 2024" → "hells kitchen")
  const withoutYear = normalized.replace(/\s*\d{4}$/, '').trim();
  if (withoutYear !== normalized && withoutYear.length > 2) {
    if (apiLookup[withoutYear]) {
      return apiLookup[withoutYear];
    }
    for (const [apiNorm, data] of Object.entries(apiLookup)) {
      if (apiNorm.includes(withoutYear) || withoutYear.includes(apiNorm)) {
        return data;
      }
    }
  }

  return null;
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

  // Method 1: Direct TodayTix search (works for open shows)
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
  } catch (err) {
    console.log(`   ⚠ Direct TodayTix search failed: ${err.message}`);
  }

  // Method 2: Google SERP search (works for closed shows whose pages still exist)
  console.log(`   Trying Google SERP search for TodayTix page...`);
  try {
    const serpData = await searchGoogleForTodayTix(showTitle);
    const results = serpData?.organic_results || serpData?.results || [];

    for (const result of results) {
      const url = result.url || result.link || '';
      // Match NYC show URLs only (reject /london/, /chicago/, etc.)
      const match = url.match(/todaytix\.com\/nyc\/shows\/(\d+)-([a-z0-9-]+)/i);
      if (match) {
        const id = parseInt(match[1]);
        const slug = match[2];
        console.log(`   ✓ Found TodayTix ID via Google: ${id} (${slug})`);
        return { id, slug };
      }
    }

    console.log(`   ✗ No TodayTix NYC page found in Google results`);
  } catch (err) {
    console.log(`   ⚠ Google SERP search failed: ${err.message}`);
  }

  console.log(`   ✗ Could not find TodayTix ID`);
  return null;
}

// Contentful URL transformation parameters - ONLY used as fallback
// Contentful's Image API allows requesting any size/crop on the fly
const CONTENTFUL_TRANSFORMS = {
  // Square thumbnail (1:1) - good for grid cards
  square: '?w=1080&h=1080&fit=fill&f=face&fm=webp&q=90',
  // Portrait poster (2:3) - standard theatrical poster ratio
  portrait: '?w=720&h=1080&fit=fill&f=face&fm=webp&q=90',
  // Landscape hero (roughly 2.4:1) - good for hero banners
  landscape: '?w=1920&h=800&fit=fill&f=center&fm=webp&q=90'
};

// Extract images from TodayTix page
// Priority: Find actual square AND portrait images first, only crop as last resort
function extractAllImageFormats(html) {
  // Extract all Contentful image URLs
  const imageMatches = html.match(/https:\/\/images\.ctfassets\.net\/[^"'<\s]+\.(jpg|jpeg|png)/gi);

  if (!imageMatches) return null;

  // Clean URLs (remove query params) and deduplicate
  const uniqueImages = [...new Set(imageMatches.map(url => url.split('?')[0]))];

  // Find specific format images
  let squareImage = null;    // Actual square image (best)
  let portraitImage = null;  // Actual portrait/poster image (best)
  let heroImage = null;      // Wide production photo for hero
  let fallbackImage = null;  // Any usable image as last resort

  for (const baseUrl of uniqueImages) {
    const filename = baseUrl.split('/').pop().toLowerCase();

    // Look for actual SQUARE images (TodayTix uses these for card grids)
    // Common patterns: 1080x1080, 1000x1000, 500x500, or "square" in name
    if (!squareImage && (
        filename.match(/1080x1080|1000x1000|500x500/) ||
        filename.includes('square') ||
        filename.includes('_sq') ||
        filename.includes('-sq')
    )) {
      squareImage = baseUrl;
    }

    // Look for actual PORTRAIT/POSTER images
    // Common patterns: 480x720, 600x900, "poster", "key_art"
    if (!portraitImage && (
        filename.includes('poster') ||
        filename.includes('key_art') ||
        filename.includes('keyart') ||
        filename.match(/480x720|600x900|400x600/)
    )) {
      portraitImage = baseUrl;
    }

    // Look for LANDSCAPE/HERO images (production photos)
    // These are typically wider aspect ratio photos
    if (!heroImage && (
        filename.includes('hero') ||
        filename.includes('banner') ||
        filename.includes('header') ||
        filename.includes('production') ||
        filename.includes('company') ||
        filename.includes('ensemble') ||
        filename.match(/1920x|1600x|1440x|landscape/)
    )) {
      heroImage = baseUrl;
    }

    // Track a fallback (any decent-sized image that's not a headshot)
    if (!fallbackImage && filename.length > 10 && !filename.match(/^[a-z]+\.(png|jpg)$/)) {
      fallbackImage = baseUrl;
    }
  }

  // Use fallbacks where needed
  if (!fallbackImage) fallbackImage = uniqueImages[0];
  if (!portraitImage) portraitImage = fallbackImage;
  if (!heroImage) heroImage = portraitImage;

  // For square: prefer actual square image, otherwise crop portrait as last resort
  let squareUrl, squareMethod;
  if (squareImage) {
    squareUrl = squareImage + '?fm=webp&q=90';
    squareMethod = 'native';
  } else {
    // Fallback: crop the portrait to square (not ideal but works)
    squareUrl = portraitImage + CONTENTFUL_TRANSFORMS.square;
    squareMethod = 'cropped';
  }

  // For portrait: use the portrait image with quality params
  const portraitUrl = portraitImage + '?fm=webp&q=90';

  // For landscape: use hero image, crop if needed for exact dimensions
  const landscapeUrl = heroImage + CONTENTFUL_TRANSFORMS.landscape;

  return {
    square: squareUrl,
    portrait: portraitUrl,
    landscape: landscapeUrl,
    // Keep metadata for debugging
    _sources: {
      square: squareImage ? 'native' : 'cropped from portrait',
      portrait: portraitImage,
      hero: heroImage
    }
  };
}

// Load or create Playbill URL cache
function loadPlaybillUrls() {
  try {
    return JSON.parse(fs.readFileSync(PLAYBILL_URLS_PATH, 'utf8'));
  } catch {
    return { shows: {}, lastUpdated: null };
  }
}

function savePlaybillUrls(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PLAYBILL_URLS_PATH, JSON.stringify(data, null, 2) + '\n');
}

// Global cache for Playbill URLs (loaded at start)
let playbillUrlCache = null;

function slugify(str) {
  return str.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Extract og:image from HTML
function extractOgImage(html) {
  const patterns = [
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /https:\/\/assets\.playbill\.com\/playbill-covers\/[^"'\s]+/i,
    /https:\/\/bsp-static\.playbill\.com\/[^"'\s]+\.(jpg|jpeg|png|webp)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }
  return null;
}

// Generate potential Playbill URL patterns for a show
function generatePlaybillUrlPatterns(show) {
  const year = (show.openingDate || '').split('-')[0];
  const titleSlug = slugify(show.title);
  const venueSlug = show.venue ? slugify(show.venue) : '';

  const patterns = [];

  // Pattern 1: title-broadway-year (most common)
  if (year) {
    patterns.push(`${titleSlug}-broadway-${year}`);
  }

  // Pattern 2: title-broadway-venue-year
  if (venueSlug && year) {
    patterns.push(`${titleSlug}-broadway-${venueSlug}-${year}`);
  }

  // Pattern 3: title without "the" prefix
  if (titleSlug.startsWith('the-')) {
    const noThe = titleSlug.substring(4);
    if (year) {
      patterns.push(`${noThe}-broadway-${year}`);
      if (venueSlug) {
        patterns.push(`${noThe}-broadway-${venueSlug}-${year}`);
      }
    }
  }

  // Pattern 4: Just the slug
  patterns.push(titleSlug);

  return patterns;
}

// Fallback: try Playbill with multiple URL patterns
async function fetchFromPlaybill(show) {
  if (!playbillUrlCache) {
    playbillUrlCache = loadPlaybillUrls();
  }

  const cachedUrl = playbillUrlCache.shows[show.id];
  if (cachedUrl) {
    console.log(`   Trying cached Playbill URL: ${cachedUrl}`);
    try {
      const html = await fetchViaScrapingBee(cachedUrl);
      const imageUrl = extractOgImage(html);
      if (imageUrl) {
        console.log(`   ✓ Found via cached Playbill: ${imageUrl.substring(0, 60)}...`);
        // Playbill OG images are always landscape (1200x630) — only suitable as hero
        return { hero: imageUrl, thumbnail: null, poster: null };
      }
    } catch (err) {
      console.log(`   ⚠ Cached URL failed: ${err.message}`);
    }
  }

  const patterns = generatePlaybillUrlPatterns(show);

  for (const pattern of patterns) {
    const playbillUrl = `https://playbill.com/production/${pattern}`;
    console.log(`   Trying Playbill: ${playbillUrl}`);

    try {
      const html = await fetchViaScrapingBee(playbillUrl);
      const imageUrl = extractOgImage(html);

      if (imageUrl) {
        console.log(`   ✓ Found via Playbill: ${imageUrl.substring(0, 60)}...`);
        playbillUrlCache.shows[show.id] = playbillUrl;
        savePlaybillUrls(playbillUrlCache);
        // Playbill OG images are always landscape (1200x630) — only suitable as hero
        return { hero: imageUrl, thumbnail: null, poster: null };
      }
    } catch (err) {
      continue;
    }

    await sleep(1000);
  }

  // Last resort: Google search
  console.log(`   Trying Google search for Playbill page...`);
  const searchUrl = `https://www.google.com/search?q=site:playbill.com/production+"${encodeURIComponent(show.title)}"+broadway`;

  try {
    const searchHtml = await fetchViaScrapingBee(searchUrl);
    const urlMatch = searchHtml.match(/https:\/\/playbill\.com\/production\/[a-z0-9-]+-broadway[a-z0-9-]*/i);

    if (urlMatch) {
      const discoveredUrl = urlMatch[0];
      console.log(`   Found via Google: ${discoveredUrl}`);

      await sleep(2000);
      const html = await fetchViaScrapingBee(discoveredUrl);
      const imageUrl = extractOgImage(html);

      if (imageUrl) {
        console.log(`   ✓ Found image: ${imageUrl.substring(0, 60)}...`);
        playbillUrlCache.shows[show.id] = discoveredUrl;
        savePlaybillUrls(playbillUrlCache);
        // Playbill OG images are always landscape (1200x630) — only suitable as hero
        return { hero: imageUrl, thumbnail: null, poster: null };
      }
    }
  } catch (err) {
    console.log(`   ⚠ Google search failed: ${err.message}`);
  }

  console.log(`   ✗ No image found via Playbill`);
  return null;
}

async function fetchShowImages(show, todayTixInfo, apiData) {
  console.log(`\n📽️  ${show.title}`);

  // Step 1: Try TodayTix API data (native square images, no HTTP call needed)
  if (apiData) {
    console.log(`   Found in TodayTix API: "${apiData.displayName}" (ID: ${apiData.id})`);

    const thumbnail = apiData.square || apiData.imageForAds || null;
    const poster = apiData.poster || null;
    const hero = apiData.hero || apiData.headerImage || null;

    if (thumbnail || poster) {
      // Add webp quality param to Contentful URLs that don't already have params
      const addWebp = (url) => {
        if (!url) return null;
        if (url.includes('?')) return url;
        return url + '?fm=webp&q=90';
      };

      console.log(`     - Square (thumbnail): ${thumbnail ? 'native square from API' : 'not available'}`);
      console.log(`     - Portrait (poster): ${poster ? 'from API' : 'not available'}`);
      console.log(`     - Landscape (hero): ${hero ? 'from API' : 'not available'}`);

      return {
        hero: addWebp(hero),
        thumbnail: addWebp(thumbnail),
        poster: addWebp(poster),
      };
    }

    console.log(`   API match found but missing image data, falling back to page scrape`);
  }

  // Step 2: Try TodayTix page scrape if we have an ID
  if (todayTixInfo && todayTixInfo.id) {
    const slug = todayTixInfo.slug || show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.todaytix.com/nyc/shows/${todayTixInfo.id}-${slug}`;
    console.log(`   Fetching: ${url}`);

    try {
      const html = await fetchViaScrapingBee(url);
      const images = extractAllImageFormats(html);

      if (images && (images.square || images.portrait || images.landscape)) {
        console.log(`   ✓ Found images:`);

        // Report square image source
        if (images._sources?.square === 'native') {
          console.log(`     - Square (thumbnail): ✓ native square image found`);
        } else {
          console.log(`     - Square (thumbnail): ⚠ cropped from portrait (fallback)`);
        }

        // Report portrait
        if (images._sources?.portrait) {
          const posterFile = images._sources.portrait.split('/').pop();
          console.log(`     - Portrait (poster): ✓ ${posterFile}`);
        }

        // Report hero
        if (images._sources?.hero) {
          const heroFile = images._sources.hero.split('/').pop();
          console.log(`     - Landscape (hero): ✓ ${heroFile}`);
        }

        // Format for shows.json
        return {
          hero: images.landscape,
          thumbnail: images.square,
          poster: images.portrait,
        };
      }

      console.log(`   ✗ No images found in TodayTix page`);
    } catch (err) {
      console.log(`   ✗ TodayTix error: ${err.message}`);
    }
  } else {
    console.log(`   ✗ No TodayTix ID available`);
  }

  // If TodayTix failed, try Playbill fallback
  return await fetchFromPlaybill(show);
}

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
  const onlyMissing = args.includes('--missing');
  const badImagesOnly = args.includes('--bad-images');

  if (!SCRAPINGBEE_API_KEY) {
    console.error('ERROR: Set SCRAPINGBEE_API_KEY environment variable');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('AUTO-FETCH SHOW IMAGES');
  if (badImagesOnly) console.log('MODE: Re-sourcing shows with bad (identical Playbill) images');
  console.log('='.repeat(60));

  const showsData = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf8'));
  const todayTixIds = loadTodayTixIds();

  // Batch-fetch all active NYC shows from TodayTix API (free, no ScrapingBee needed)
  let apiLookup = {};
  try {
    apiLookup = await fetchAllTodayTixShows();
  } catch (err) {
    console.log(`TodayTix API unavailable: ${err.message}`);
    console.log('  Falling back to page-scrape method for all shows.\n');
  }

  // Filter shows - include all statuses when fetching missing, bad-images, or specific shows
  let shows = showsData.shows;
  if (!onlyMissing && !badImagesOnly && !showFilter) {
    shows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  }

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    console.log(`Filtering to show: ${showFilter}`);
  }

  if (onlyMissing) {
    shows = shows.filter(s => !s.images?.poster || !s.images?.thumbnail);
    console.log(`Processing only shows with missing images: ${shows.length}`);
  }

  if (badImagesOnly) {
    const badShows = shows.filter(s => hasBadImages(s.id));
    console.log(`\nDetected ${badShows.length} shows with bad (identical) images:`);
    badShows.forEach(s => console.log(`  - ${s.id}`));
    shows = badShows;
  }

  console.log(`\nProcessing ${shows.length} shows...\n`);

  const results = { success: [], failed: [], skipped: [] };

  for (const show of shows) {
    // Try matching against TodayTix API data (instant, no HTTP call)
    const apiData = matchTodayTixShow(show.title, apiLookup);

    // Cache API-discovered TodayTix ID
    if (apiData && apiData.id) {
      todayTixIds.shows[show.id] = { id: apiData.id, slug: null };
      saveTodayTixIds(todayTixIds);
    }

    // When re-sourcing bad images, clear the cached TodayTix ID so we re-discover
    if (badImagesOnly && todayTixIds.shows[show.id]) {
      console.log(`   Clearing cached TodayTix ID for ${show.id} (re-discovering)`);
      delete todayTixIds.shows[show.id];
    }

    // If no API match, try page-scrape discovery
    let todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];

    if (!todayTixInfo && !apiData) {
      todayTixInfo = await discoverTodayTixId(show.title);
      if (todayTixInfo) {
        todayTixIds.shows[show.id] = todayTixInfo;
        saveTodayTixIds(todayTixIds);
      }
      await sleep(2000); // Rate limit
    }

    // Fetch images: API data → page scrape → Playbill fallback
    const images = await fetchShowImages(show, todayTixInfo, apiData);

    if (images) {
      show.images = images;
      results.success.push(show.title);
    } else {
      results.failed.push(show.title);
    }

    // Only rate-limit if we made HTTP calls (API-sourced images are instant)
    if (!apiData) {
      await sleep(2000);
    }
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
