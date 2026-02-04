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
const IBDB_IMAGE_CACHE_PATH = path.join(__dirname, '..', 'data', 'ibdb-image-cache.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;

// Broadway.org CDN image transforms
const BROADWAY_ORG_TRANSFORMS = {
  square:    '?width=1080&height=1080&fit=cover&quality=85',
  portrait:  '?width=720&height=1080&fit=cover&quality=85',
  landscape: '?width=1920&height=800&fit=cover&quality=85',
};

function loadIbdbImageCache() {
  try {
    return JSON.parse(fs.readFileSync(IBDB_IMAGE_CACHE_PATH, 'utf8'));
  } catch {
    return { shows: {}, lastUpdated: null };
  }
}

function saveIbdbImageCache(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(IBDB_IMAGE_CACHE_PATH, JSON.stringify(data, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchViaScrapingBee(url, { premiumProxy = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY not set'));
      return;
    }

    let scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;
    if (premiumProxy) scrapingBeeUrl += '&premium_proxy=true';

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

// Search Google via ScrapingBee SERP API for IBDB production pages
function searchGoogleForIBDB(showTitle, openingYear) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY not set'));
      return;
    }

    const yearStr = openingYear ? ` ${openingYear}` : '';
    const query = `site:ibdb.com/broadway-production "${showTitle}"${yearStr}`;
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
          const parsed = JSON.parse(data);
          const organic = parsed.organic_results || [];
          const results = organic
            .filter(r => r.url && r.url.includes('/broadway-production/'))
            .map(r => r.url);
          resolve(results);
        } catch {
          reject(new Error('Failed to parse Google SERP response'));
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Extract broadway.org CDN image URLs from IBDB page HTML
// IBDB embeds broadway.org images for show posters and production photos
function extractBroadwayOrgImages(html, showTitle) {
  // Match broadway.org asset URLs (both direct and CDN domains)
  const imgPattern = /(?:https?:\/\/(?:www\.)?broadway\.org\/assets\/shows(?:-media)?\/[^"'<>\s?]+|https?:\/\/cdn\.craft\.cloud\/[^"'<>\s?]+\/assets\/shows(?:-media)?\/[^"'<>\s?]+)/gi;
  const allUrls = html.match(imgPattern) || [];

  if (allUrls.length === 0) return null;

  // Deduplicate by base filename
  const seen = new Set();
  const uniqueUrls = [];
  for (const url of allUrls) {
    const base = url.split('?')[0];
    if (!seen.has(base)) {
      seen.add(base);
      uniqueUrls.push(base);
    }
  }

  // Separate poster images (assets/shows/) from media (assets/shows-media/)
  const posterUrls = uniqueUrls.filter(u => /\/assets\/shows\/[^/]+$/.test(u) && !/\/shows-media\//.test(u));
  const mediaUrls = uniqueUrls.filter(u => /\/assets\/shows-media\//.test(u));

  // Try to identify show-specific images via alt text
  // IBDB uses alt="Show Title - Show Title Year" on show images
  // Extract img tags with broadway.org src and matching alt text
  const normalTitle = showTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  let bestPoster = null;

  // Look for img tags with alt text matching the show
  const imgTagPattern = /<img[^>]*alt="([^"]*)"[^>]*src="([^"]*broadway\.org[^"]*|[^"]*cdn\.craft\.cloud[^"]*)"[^>]*/gi;
  const imgTagPattern2 = /<img[^>]*src="([^"]*broadway\.org[^"]*|[^"]*cdn\.craft\.cloud[^"]*)"[^>]*alt="([^"]*)"[^>]*/gi;

  for (const pattern of [imgTagPattern, imgTagPattern2]) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const alt = pattern === imgTagPattern ? match[1] : match[2];
      const src = pattern === imgTagPattern ? match[2] : match[1];
      const normalAlt = alt.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (isSafeSubstringMatch(normalAlt, normalTitle) && /\/assets\/shows\//.test(src) && !/\/shows-media\//.test(src)) {
        bestPoster = src.split('?')[0];
        break;
      }
    }
    if (bestPoster) break;
  }

  // Also check background-image styles for show poster
  if (!bestPoster) {
    const bgPattern = /background-image:\s*url\(['"]?((?:https?:\/\/(?:www\.)?broadway\.org|https?:\/\/cdn\.craft\.cloud)[^'")\s]+\/assets\/shows\/[^'")\s?]+)/gi;
    let match;
    while ((match = bgPattern.exec(html)) !== null) {
      bestPoster = match[1].split('?')[0];
      break;
    }
  }

  // Do NOT fall back to first poster URL — it could be from a sidebar show.
  // Only use images we're confident belong to the target show.
  if (!bestPoster && mediaUrls.length === 0) return null;

  // If we only have media URLs but no poster, verify media belongs to show
  // by checking if the media filename contains a show-related slug
  if (!bestPoster && mediaUrls.length > 0) {
    const titleSlug = showTitle.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const hasRelevantMedia = mediaUrls.some(u => {
      const filename = u.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '');
      return filename.includes(titleSlug) || titleSlug.includes(filename.replace(/\d+$/, ''));
    });
    if (!hasRelevantMedia) return null;
  }

  // Build result with CDN transforms
  const result = {
    thumbnail: bestPoster ? bestPoster + BROADWAY_ORG_TRANSFORMS.square : null,
    poster: bestPoster ? bestPoster + BROADWAY_ORG_TRANSFORMS.portrait : null,
    hero: (mediaUrls[0] || bestPoster) ? (mediaUrls[0] || bestPoster) + BROADWAY_ORG_TRANSFORMS.landscape : null,
  };

  // Only return if we got at least a thumbnail or poster
  if (!result.thumbnail && !result.poster) return null;
  return result;
}

let ibdbImageCache = null;

// Fetch show images from IBDB page (which embeds broadway.org CDN images)
async function fetchFromIBDB(show) {
  if (!ibdbImageCache) {
    ibdbImageCache = loadIbdbImageCache();
  }

  // Check cache first — if we have a cached base URL, construct sized images directly
  const cached = ibdbImageCache.shows[show.id];
  if (cached && cached.posterBaseUrl) {
    console.log(`   Using cached IBDB/Broadway.org image: ${cached.posterBaseUrl.split('/').pop()}`);
    return {
      thumbnail: cached.posterBaseUrl + BROADWAY_ORG_TRANSFORMS.square,
      poster: cached.posterBaseUrl + BROADWAY_ORG_TRANSFORMS.portrait,
      hero: (cached.mediaBaseUrl || cached.posterBaseUrl) + BROADWAY_ORG_TRANSFORMS.landscape,
    };
  }
  if (cached && cached.notFound) {
    return null; // Previously confirmed no images on IBDB
  }

  console.log(`   Trying IBDB/Broadway.org...`);

  // Step 1: Find IBDB production URL via Google SERP
  let ibdbUrl = null;
  const openingYear = show.openingDate ? show.openingDate.substring(0, 4) : null;

  try {
    const results = await searchGoogleForIBDB(show.title, openingYear);
    if (results.length > 0) {
      // If we have an opening year, prefer URL containing that year
      ibdbUrl = results.find(u => openingYear && u.includes(openingYear)) || results[0];
    }
  } catch (err) {
    console.log(`   ⚠ IBDB SERP search failed: ${err.message}`);
  }

  // Fallback: construct URL from title slug
  if (!ibdbUrl) {
    const slug = show.title.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    ibdbUrl = `https://www.ibdb.com/broadway-production/${slug}`;
    console.log(`   Trying constructed IBDB URL: ${ibdbUrl}`);
  }

  await sleep(1500);

  // Step 2: Scrape IBDB page (needs premium proxy)
  try {
    const html = await fetchViaScrapingBee(ibdbUrl, { premiumProxy: true });

    // Check for redirect to homepage (production not found)
    if (html.includes('Opening Nights in History') && !html.includes('Opening Date')) {
      console.log(`   ✗ IBDB page not found (redirected to homepage)`);
      ibdbImageCache.shows[show.id] = { notFound: true, lastChecked: new Date().toISOString() };
      return null;
    }

    // Step 3: Extract broadway.org images
    const images = extractBroadwayOrgImages(html, show.title);
    if (images) {
      console.log(`   ✓ Found images via IBDB/Broadway.org`);
      // Cache the base URLs for future runs
      const posterBase = images.thumbnail ? images.thumbnail.split('?')[0] : null;
      const mediaBase = images.hero ? images.hero.split('?')[0] : null;
      ibdbImageCache.shows[show.id] = {
        ibdbUrl,
        posterBaseUrl: posterBase,
        mediaBaseUrl: mediaBase !== posterBase ? mediaBase : null,
        lastChecked: new Date().toISOString()
      };
      return images;
    }

    console.log(`   ✗ No broadway.org images found on IBDB page`);
    ibdbImageCache.shows[show.id] = { notFound: true, ibdbUrl, lastChecked: new Date().toISOString() };
  } catch (err) {
    console.log(`   ✗ IBDB page fetch failed: ${err.message}`);
  }

  return null;
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

// Guard against substring false positives (e.g., "Rocky" matching "The Rocky Horror Show")
// Requires the shorter string to be at least 60% of the longer string's length
function isSafeSubstringMatch(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (!longer.includes(shorter)) return false;
  return shorter.length / longer.length >= 0.6;
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

  // 2. Substring containment (with length-ratio guard to prevent false positives)
  for (const [apiNorm, data] of Object.entries(apiLookup)) {
    if (isSafeSubstringMatch(apiNorm, normalized)) {
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
      if (isSafeSubstringMatch(apiNorm, withoutYear)) {
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

// Detect if a thumbnail URL points to a native square asset vs a portrait poster crop
function isNativeSquareUrl(url) {
  if (!url) return false;
  const filename = url.split('/').pop().split('?')[0].toLowerCase();
  // Native square: filename has square dimensions or "square" keyword
  if (filename.match(/1080x1080|1024x1024|1000x1000|900x900|500x500/)) return true;
  if (filename.includes('square') || filename.includes('_sq') || filename.includes('-sq')) return true;
  if (filename.includes('1x1')) return true;
  // Portrait poster crop: filename has portrait dimensions
  if (filename.match(/480x720|600x900|400x600/)) return false;
  if (filename.includes('poster')) return false;
  // Check URL params - if it has fit=fill with square dimensions on a non-square source, it's a crop
  if (url.includes('fit=fill') && url.includes('h=1080') && filename.match(/480x720|poster/)) return false;
  // Unknown - assume it could be okay
  return true;
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

// Verify images from a non-trusted tier before accepting.
// Returns images if verified (or verification disabled), null if rejected.
async function verifyAndAccept(images, show, tierName, verifyCtx) {
  if (!verifyCtx) return images;

  const { verifyImage } = require('./lib/verify-image');

  // Pick best image to verify: thumbnail > poster > hero
  const urlToVerify = images.thumbnail || images.poster || images.hero;
  if (!urlToVerify) return images;

  const year = show.openingDate ? show.openingDate.substring(0, 4) : null;
  console.log(`   🔍 Verifying ${tierName} image...`);

  const result = await verifyImage(urlToVerify, show.title, {
    year,
    openingDate: show.openingDate,
    rateLimiter: verifyCtx.rateLimiter,
  });

  if (result.match === true) {
    console.log(`   ✓ VERIFIED (${result.confidence}): ${result.description}`);
    verifyCtx.verified = (verifyCtx.verified || 0) + 1;
    return images;
  } else if (result.match === false &&
             (result.confidence === 'high' || result.confidence === 'medium')) {
    console.log(`   ✗ REJECTED (${result.confidence}): ${result.description} [${result.issues.join(', ')}]`);
    verifyCtx.rejected = (verifyCtx.rejected || 0) + 1;
    return null;
  } else {
    // Low confidence rejection or API error → fail open
    console.log(`   ⚠ UNCERTAIN (${result.confidence}): ${result.description} — accepting`);
    verifyCtx.uncertain = (verifyCtx.uncertain || 0) + 1;
    return images;
  }
}

async function fetchShowImages(show, todayTixInfo, apiData, verifyCtx) {
  console.log(`\n📽️  ${show.title}`);

  // Step 1: Try TodayTix API data (native square images, no HTTP call needed)
  // TRUSTED SOURCE — skip verification
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

      const thumbIsNative = isNativeSquareUrl(thumbnail);
      console.log(`     - Square (thumbnail): ${thumbnail ? (thumbIsNative ? '✓ native square from API' : '⚠ poster crop from API') : 'not available'}`);
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
  // NEEDS VERIFICATION — scraped images may be from wrong show/production
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
        const formatted = {
          hero: images.landscape,
          thumbnail: images.square,
          poster: images.portrait,
        };

        const verified = await verifyAndAccept(formatted, show, 'TodayTix scrape', verifyCtx);
        if (verified) return verified;
        console.log(`   Falling through to IBDB...`);
      } else {
        console.log(`   ✗ No images found in TodayTix page`);
      }
    } catch (err) {
      console.log(`   ✗ TodayTix error: ${err.message}`);
    }
  } else {
    console.log(`   ✗ No TodayTix ID available`);
  }

  // Step 3: Try IBDB → broadway.org images (poster + production photos)
  // NEEDS VERIFICATION — IBDB neighbor shows cause cross-contamination
  const ibdbImages = await fetchFromIBDB(show);
  if (ibdbImages && (ibdbImages.thumbnail || ibdbImages.poster)) {
    const verified = await verifyAndAccept(ibdbImages, show, 'IBDB', verifyCtx);
    if (verified) return verified;
    console.log(`   Falling through to Playbill...`);
  }

  // Step 4: Playbill fallback (landscape OG image only)
  // NEEDS VERIFICATION — last resort, accept with warning if verification fails
  const playbillImages = await fetchFromPlaybill(show);
  if (playbillImages) {
    const verified = await verifyAndAccept(playbillImages, show, 'Playbill', verifyCtx);
    if (verified) return verified;
    console.log(`   ⚠ Playbill image failed verification but accepting as last resort`);
    if (verifyCtx) {
      verifyCtx.rejected = (verifyCtx.rejected || 0) - 1; // Don't count last-resort accepts as rejections
      verifyCtx.lastResort = (verifyCtx.lastResort || 0) + 1;
    }
    return playbillImages;
  }

  return null;
}

// Process a single show: discover TodayTix ID, fetch images, update show object.
// Returns { show, images, apiSourced } or null on failure.
async function processOneShow(show, apiLookup, todayTixIds, badImagesOnly, verifyCtx) {
  // Try matching against TodayTix API data (instant, no HTTP call)
  const apiData = matchTodayTixShow(show.title, apiLookup);

  // Cache API-discovered TodayTix ID
  if (apiData && apiData.id) {
    todayTixIds.shows[show.id] = { id: apiData.id, slug: null };
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
    }
  }

  // Fetch images: API data → page scrape → Playbill fallback (with optional LLM verification)
  const images = await fetchShowImages(show, todayTixInfo, apiData, verifyCtx);
  return { show, images, apiSourced: !!apiData };
}

// Process shows in batches with concurrency.
// API-sourced shows (instant) are separated from scrape-needing shows.
async function processShowsConcurrently(shows, apiLookup, todayTixIds, badImagesOnly, concurrency, verifyCtx) {
  const results = { success: [], failed: [], skipped: [] };

  // Separate API-matched shows (instant, no rate limit needed) from scrape-needed shows
  const apiShows = [];
  const scrapeShows = [];
  for (const show of shows) {
    const apiData = matchTodayTixShow(show.title, apiLookup);
    if (apiData) {
      apiShows.push(show);
    } else {
      scrapeShows.push(show);
    }
  }

  // When verification is active, reduce scrape concurrency to avoid overwhelming Gemini rate limiter
  const scrapeConcurrency = verifyCtx ? Math.min(concurrency, 2) : concurrency;

  console.log(`  API-matched (instant): ${apiShows.length} shows`);
  console.log(`  Need scraping: ${scrapeShows.length} shows`);
  console.log(`  Concurrency: ${scrapeConcurrency}${verifyCtx ? ` (reduced from ${concurrency} for LLM verification)` : ''}\n`);

  // Process API-matched shows first (fast, no rate limiting, no verification needed)
  for (const show of apiShows) {
    const result = await processOneShow(show, apiLookup, todayTixIds, badImagesOnly, verifyCtx);
    if (result && result.images) {
      applyImages(result.show, result.images);
      results.success.push(show.title);
    } else {
      results.failed.push(show.title);
    }
  }

  if (apiShows.length > 0) {
    console.log(`\n--- API phase done: ${results.success.length} success ---\n`);
  }

  // Process scrape-needed shows with concurrency
  let processed = 0;
  for (let i = 0; i < scrapeShows.length; i += scrapeConcurrency) {
    const batch = scrapeShows.slice(i, i + scrapeConcurrency);
    const batchResults = await Promise.allSettled(
      batch.map(show => processOneShow(show, apiLookup, todayTixIds, badImagesOnly, verifyCtx))
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled' && settled.value && settled.value.images) {
        applyImages(settled.value.show, settled.value.images);
        results.success.push(settled.value.show.title);
      } else {
        const show = settled.status === 'fulfilled' ? settled.value?.show : batch[0];
        results.failed.push(show?.title || 'unknown');
      }
    }

    processed += batch.length;
    if (scrapeShows.length > scrapeConcurrency) {
      console.log(`   [${processed}/${scrapeShows.length}] ${results.success.length} success, ${results.failed.length} failed`);
    }

    // Rate limit between batches (not between individual shows within a batch)
    if (i + scrapeConcurrency < scrapeShows.length) {
      await sleep(2000);
    }
  }

  // Save caches once at end (not per-show)
  saveTodayTixIds(todayTixIds);
  if (ibdbImageCache) saveIbdbImageCache(ibdbImageCache);

  return results;
}

// Apply fetched images to a show object, protecting existing local thumbnails
function applyImages(show, images) {
  const existingThumb = show.images?.thumbnail;
  const hasLocalThumb = existingThumb && existingThumb.startsWith('/images/');
  const newThumbIsNative = isNativeSquareUrl(images.thumbnail);

  if (hasLocalThumb && !newThumbIsNative) {
    console.log(`   ⚠ Keeping existing local thumbnail for ${show.id} (new source is poster crop)`);
    images.thumbnail = existingThumb;
  }

  show.images = images;
}

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
  const onlyMissing = args.includes('--missing');
  const badImagesOnly = args.includes('--bad-images');
  const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '5', 10);
  const verifyEnabled = args.includes('--verify');

  if (!SCRAPINGBEE_API_KEY) {
    console.error('ERROR: Set SCRAPINGBEE_API_KEY environment variable');
    process.exit(1);
  }

  // Initialize LLM verification gate
  let verifyCtx = null;
  if (verifyEnabled) {
    const { createRateLimiter } = require('./lib/verify-image');
    verifyCtx = { rateLimiter: createRateLimiter(15), verified: 0, rejected: 0, uncertain: 0, lastResort: 0 };
    console.log('Image verification: ENABLED (Gemini 2.0 Flash)');
  }

  console.log('='.repeat(60));
  console.log('AUTO-FETCH SHOW IMAGES');
  if (badImagesOnly) console.log('MODE: Re-sourcing shows with bad (identical Playbill) images');
  if (verifyEnabled) console.log('MODE: LLM verification gate active');
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

  // Use concurrent processing for large batches, sequential for small
  const results = await processShowsConcurrently(shows, apiLookup, todayTixIds, badImagesOnly, concurrency, verifyCtx);

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

  // Verification stats
  if (verifyCtx) {
    console.log(`\n🔍 Verification Stats:`);
    console.log(`  Verified (accepted): ${verifyCtx.verified}`);
    console.log(`  Rejected (wrong image): ${verifyCtx.rejected}`);
    console.log(`  Uncertain (accepted anyway): ${verifyCtx.uncertain}`);
    if (verifyCtx.lastResort > 0) {
      console.log(`  Last resort (Playbill, accepted with warning): ${verifyCtx.lastResort}`);
    }
  }

  // GitHub Actions output
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `images_fetched=${results.success.length}\n`);
    fs.appendFileSync(outputFile, `images_failed=${results.failed.length}\n`);
    if (verifyCtx) {
      fs.appendFileSync(outputFile, `images_rejected=${verifyCtx.rejected}\n`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
