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
 * Usage: node scripts/fetch-show-images-auto.js [--show=show-id] [--missing|--missing-only] [--bad-images] [--dry-run] [--audit-existing]
 */

const https = require('https');
const fs = require('fs');
const { serpQuery } = require('./lib/url-discovery');
const path = require('path');
const { compressImage } = require('./lib/compress-image');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');
const scraper = require('./lib/scraper');
const { fetchPage, checkScrapingBeeCredits } = scraper;

const crypto = require('crypto');

const USAGE = `fetch-show-images-auto.js — discover + fetch show images (TodayTix/Playbill/IBDB).

Usage:
  node scripts/fetch-show-images-auto.js [--show=show-id] [--missing|--missing-only]
    [--bad-images] [--dry-run] [--audit-existing] [--concurrency=N] [--no-verify]
    [--flagged] [--max-runtime=MIN]
  node scripts/fetch-show-images-auto.js --help, -h   print this usage and exit — no fetches/writes
`;

const SHOWS_JSON_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const TODAYTIX_IDS_PATH = path.join(__dirname, '..', 'data', 'todaytix-ids.json');
const PLAYBILL_URLS_PATH = path.join(__dirname, '..', 'data', 'playbill-urls.json');
const IBDB_IMAGE_CACHE_PATH = path.join(__dirname, '..', 'data', 'ibdb-image-cache.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const DRY_RUN_DIR = path.join(__dirname, '..', 'data', 'audit', 'image-dry-run');
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');

// MD5 hashes of known "Coming Soon" placeholder images on disk.
// These are the TodayTix placeholder graphics that were saved before URL-based filtering was added.
const PLACEHOLDER_FILE_HASHES = new Set([
  'b4d7d1bdb443e0a94e69ac8a5abd6f40', // poster.webp (19,118 bytes) — variant 1 (round-rect glow)
  'ac3ea27f64c633474ad93fd826f614e7', // thumbnail.webp (11,664 bytes) — variant 1
  '4aed489bb69c5c49be3315e3f85b342f', // hero.webp (28,998 bytes) — variant 1 (round-rect glow)
  '52968e9f240e2db8d7523ac053d019fb', // hero.webp (28,808 bytes) — variant 2 (oval glow, different layout)
  'da0408f33ffaff9c63baf108b53b1128', // hero.webp (25,372 bytes) — variant 3 (1440x580 landscape)
  '9d1b34a4045d176b1856ab38a852d47b', // thumbnail.webp (32,372 bytes) — variant 2 (square format)
]);

function isPlaceholderFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    return PLACEHOLDER_FILE_HASHES.has(hash);
  } catch { return false; }
}
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;

// Module-level dry-run state (set in main)
let dryRunMode = false;
let dryRunResults = [];

// Module-level shows data (loaded in main, referenced by processOneShow guard)
let allShowsData = null;

// ============================================================
// PINNED IMAGES — Manually curated thumbnails, NEVER overwrite
// These were hand-selected or restored by human review.
// To add: append the show ID here and commit.
// To override: remove from this list first, then re-fetch.
// ============================================================
const PINNED_IMAGES = new Set([
  // Manually curated promotional art (restored/selected by human review)
  'sunset-boulevard-2024',        // Nicole Scherzinger Tony Award promo art
  'an-enemy-of-the-people-2024',  // Jeremy Strong underwater poster art
  'waiting-for-godot-2025',       // Reeves & Winter blue promo poster
  'good-night-and-good-luck-2025',// George Clooney B&W full title poster
  'parade-2023',                  // Ben Platt & Micaela Diamond promo art
  'redwood-2025',                 // Idina Menzel "Returns to Broadway" poster
  'smash-2025',                   // Red marquee light-bulb logo
  'once-upon-a-mattress-2024',    // Sutton Foster promo art
  'maybe-happy-ending-2024',      // Square key art (protected from poster crop)
  'romeo-juliet-2024',            // Manually uploaded promotional art
  'art-2025',                     // Manually sourced thumbnail
  'burnout-paradise-off-broadway-2026', // Restored from original St. Ann's Warehouse poster.jpg
  'bughouse-off-broadway-2026',         // TodayTix CDN returns "Coming Soon" — real art archived locally
  // Currently open shows — thumbnails curated/verified by human
  'aladdin-2014',
  'all-out-2025',
  'and-juliet-2022',
  'book-of-mormon-2011',
  'buena-vista-social-club-2025',
  'bug-2026',
  'chess-2025',
  'chicago-1996',
  'death-becomes-her-2024',
  'hadestown-2019',
  'hamilton-2015',
  'harry-potter-2021',
  'hells-kitchen-2024',
  'just-in-time-2025',
  'marjorie-prime-2025',
  'mj-2022',
  'moulin-rouge-2019',
  'oedipus-2025',
  'oh-mary-2024',
  'operation-mincemeat-2025',
  'ragtime-2025',
  'six-2021',
  'stranger-things-2024',
  'the-great-gatsby-2024',
  'the-lion-king-1997',
  'the-outsiders-2024',
  'two-strangers-bway-2025',
  'wicked-2003',
  // Historical shows — manually fixed after wrong-image contamination
  'the-cripple-of-inishmaan-2014', // Google SERP returned Wicked TodayTix page
  'november-2008',                  // Google SERP returned In The Heights TodayTix page
  'private-lives-2011',             // TodayTix returned generic "Coming Soon" placeholders
]);

// ============================================================
// PRE-BROADWAY VENUE SHOWS — Accept venue-branded art for these
// These shows only have pre-Broadway venue branding available
// (e.g., Steppenwolf, NYTW). Gemini's "non_broadway" rejection
// is overridden for listed shows. Add as discovered.
// ============================================================
const PRE_BROADWAY_VENUE_SHOWS = new Set([
  'the-minutes-2022',           // Steppenwolf
  'august-osage-county-2007',   // Steppenwolf
  'jerome-off-broadway-2025',   // Playwrights Horizons — venue-branded art, Gemini rejects as non_broadway
]);

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

// Fetch page HTML through the shared fallback chain (Bright Data → ScrapingBee →
// Scrapingdog → Playwright — see scripts/lib/scraper.js). Replaces the former
// private ScrapingBee/Bright Data-only implementation: that duplicate path
// never got Scrapingdog's cheap tier or Playwright's free tier, and re-hit an
// exhausted ScrapingBee key on every call instead of latching off after the
// first 401 (task #688). Throws on total failure, same as the old fallback.
async function fetchPageWithFallback(url, opts = {}) {
  if (!url) throw new Error('fetchPageWithFallback: no URL provided');
  const result = await fetchPage(url, opts.renderJs != null ? { renderJs: opts.renderJs } : {});
  return result.content;
}

// Download image directly from URL (no proxy needed for public CDN images)
async function downloadImageDirect(url) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Regional shows (category:'regional') — TodayTix/IBDB/ShowScore have nothing
// for Broadway-feeder venues. Source the venue page og:image (canonical key
// art), falling back to the show's archived BWW roundup og:image (production
// photo). Unlike the CDN sources, venue images are downloaded and sharp-
// cropped HERE (600x900 poster / 300x450 thumb / 1600x1000 hero, attention
// crop) because venue og:images are usually landscape and would fail
// archive-show-images.js's poster aspect gate as-is. Returns LOCAL
// /images/shows/<id>/ paths (the persist step keeps those verbatim).
// ---------------------------------------------------------------------------

/**
 * Portrait card (poster/thumbnail) from arbitrary key art. Venue og:images
 * are usually landscape title-art; a straight 2:3 attention-crop amputates
 * the title ("BLACK SWAN" → "BLAC SWA", user report 2026-07-12). Strategy:
 *   - trim uniform borders (white-background promo shoots read as whitespace
 *     in small cards otherwise);
 *   - portrait-ish source (w/h ≤ 0.85) → tight cover/attention crop;
 *   - landscape/square source → CONTAIN the full art over a blurred,
 *     darkened cover of itself (the standard letterbox-poster treatment) so
 *     no text is ever cut.
 */
async function portraitCardFromKeyArt(sharpLib, buffer, w, h, quality) {
  let src = buffer;
  try {
    const trimmed = await sharpLib(buffer).trim({ threshold: 25 }).toBuffer({ resolveWithObject: true });
    // Only adopt the trim when it kept a meaningful image (guards against
    // aggressive trims of low-contrast art collapsing to slivers).
    if (trimmed.info.width > 200 && trimmed.info.height > 200) src = trimmed.data;
  } catch { /* keep original */ }
  const meta = await sharpLib(src).metadata();
  const ratio = (meta.width || 1) / (meta.height || 1);
  if (ratio <= 0.85) {
    return sharpLib(src).resize(w, h, { fit: 'cover', position: 'attention' }).webp({ quality }).toBuffer();
  }
  const bg = await sharpLib(src).resize(w, h, { fit: 'cover' }).blur(30).modulate({ brightness: 0.5, saturation: 1.15 }).toBuffer();
  const fg = await sharpLib(src).resize(w - 24, h - 24, { fit: 'inside' }).toBuffer();
  return sharpLib(bg).composite([{ input: fg, gravity: 'centre' }]).webp({ quality }).toBuffer();
}

async function fetchFromRegionalVenue(show, verifyCtx) {
  let sharpLib;
  try { sharpLib = require('sharp'); } catch { console.log('   ⚠ sharp unavailable — cannot process regional venue images'); return null; }
  const { REGIONAL_FEEDER_VENUES } = require('./lib/aggregator-candidate-extract');
  const venueEntry = REGIONAL_FEEDER_VENUES.find(v => v.re.test(show.venue || ''));

  const localPaths = {
    poster: `/images/shows/${show.id}/poster.webp`,
    thumbnail: `/images/shows/${show.id}/thumbnail.webp`,
    hero: `/images/shows/${show.id}/hero.webp`,
  };

  // Existing real files win unless --force: re-runs (default local run, manual
  // dispatch with only_missing=false, --show=<id>) must not silently replace
  // curated/manual images with a re-scraped roundup photo. (ship-check P2)
  const posterOnDisk = path.join(IMAGES_DIR, show.id, 'poster.webp');
  if (!process.argv.includes('--force') && fs.existsSync(posterOnDisk) && !isPlaceholderFile(posterOnDisk)) {
    console.log('   ✓ regional images already on disk — keeping (use --force to re-source)');
    return { ...localPaths };
  }

  const extractOgImage = (html, baseUrl) => {
    const m = (html && html.match(/property="og:image"\s+content="([^"]+)"/i))
      || (html && html.match(/content="([^"]+)"\s+property="og:image"/i));
    if (!m) return null;
    const raw = m[1].replace(/&amp;/g, '&');
    try { return new URL(raw, baseUrl || undefined).href; } catch { return null; }
  };

  // Candidate source URLs, best-first.
  const sources = [];
  if (venueEntry && venueEntry.domain) {
    try {
      const results = await serpQuery(`site:${venueEntry.domain} "${show.title}"`);
      const hit = (results || []).map(r => r.url).find(u => u && u.includes(venueEntry.domain));
      if (hit) sources.push({ url: hit, label: 'venue page' });
    } catch (e) {
      console.log(`   ⚠ venue SERP failed: ${e.message.slice(0, 60)}`);
    }
  }
  const roundupArchive = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups', `${show.id}.html`);
  if (fs.existsSync(roundupArchive)) sources.push({ archivePath: roundupArchive, label: 'BWW roundup archive' });

  for (const src of sources) {
    try {
      const html = src.archivePath
        ? fs.readFileSync(src.archivePath, 'utf8')
        : await fetchPageWithFallback(src.url);
      const ogImage = extractOgImage(html, src.url);
      if (!ogImage) { console.log(`   ⚠ no og:image on ${src.label}`); continue; }
      console.log(`   Regional source (${src.label}): ${ogImage.slice(0, 90)}`);
      const buffer = await downloadImageDirect(ogImage);
      const meta = await sharpLib(buffer).metadata();
      if (!meta.width || meta.width < 400) { console.log(`   ⚠ source image too small (${meta.width}px)`); continue; }

      // Same Gemini verification gate every other non-trusted source passes —
      // a venue SERP can land on a season-announcement page whose og:image is
      // another show's art or the venue logo. (ship-check P1)
      if (verifyCtx) {
        try {
          const { verifyImage: verifyRegionalImage } = require('./lib/verify-image');
          const v = await verifyRegionalImage(buffer, show.title, { year: show.openingDate ? String(new Date(show.openingDate).getFullYear()) : undefined });
          if (v && v.match === false) {
            console.log(`   ✗ verification rejected ${src.label} image: ${(v.description || '').slice(0, 80)}`);
            continue;
          }
        } catch (e) {
          console.log(`   ⚠ verification errored (${e.message.slice(0, 50)}) — accepting unverified`);
        }
      }

      // Honor --dry-run exactly like the other local-write paths. (ship-check P1)
      const outputBase = dryRunMode ? DRY_RUN_DIR : IMAGES_DIR;
      const dir = path.join(outputBase, show.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'poster.webp'), await portraitCardFromKeyArt(sharpLib, buffer, 600, 900, 82));
      fs.writeFileSync(path.join(dir, 'thumbnail.webp'), await portraitCardFromKeyArt(sharpLib, buffer, 300, 450, 80));
      await sharpLib(buffer).resize(1600, 1000, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toFile(path.join(dir, 'hero.webp'));
      console.log(`   ✓ regional images written (poster/thumbnail/hero) from ${src.label}${dryRunMode ? ' [dry-run dir]' : ''}`);
      return { ...localPaths, _source: `regional-venue:${src.label}` };
    } catch (e) {
      console.log(`   ⚠ ${src.label} failed: ${e.message.slice(0, 80)}`);
    }
  }
  return null;
}

// Search Google for TodayTix pages (works for closed shows)
async function searchGoogleForTodayTix(showTitle) {
  const query = `site:todaytix.com "${showTitle}" broadway nyc`;
  const results = await serpQuery(query);
  // Return in original format (callers expect {organic_results})
  return { organic_results: (results || []).map(r => ({ url: r.url, title: r.title })) };
}

// Search Google for IBDB production pages
async function searchGoogleForIBDB(showTitle, openingYear) {
  const yearStr = openingYear ? ` ${openingYear}` : '';
  const query = `site:ibdb.com/broadway-production "${showTitle}"${yearStr}`;
  const results = await serpQuery(query);
  if (!results) return [];
  return results.map(r => r.url).filter(url => url && url.includes('/broadway-production/'));
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

// ---- Mezzanine (theaterdiary.com) image source ----
// Reads from local cache (data/mezzanine-image-cache.json) first.
// Falls back to Parse API if cache is missing/stale (>7 days).
// Also merges poster URLs from diary-shows.json (off-Broadway/regional imports).

const MEZZ_CACHE_PATH = path.join(__dirname, '../data/mezzanine-image-cache.json');
const MEZZ_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let mezzanineCache = null; // Lazy-loaded: { byNormTitle: Map }

function normalizeMezzTitle(s) {
  return s.toLowerCase()
    .replace(/['\u2018\u2019\u201C\u201D!:,.;\-\u2013\u2014&+()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

function buildMezzIndex(records) {
  const byNormTitle = new Map();
  for (const r of records) {
    if (!r.name || !r.artUrl) continue;
    const norm = normalizeMezzTitle(r.name);
    if (!byNormTitle.has(norm)) byNormTitle.set(norm, []);
    byNormTitle.get(norm).push(r);
  }
  return byNormTitle;
}

async function loadMezzanineProductions() {
  if (mezzanineCache) return mezzanineCache;

  // Step 1: Try local cache file
  let records = [];
  let cacheAge = Infinity;
  try {
    const raw = JSON.parse(fs.readFileSync(MEZZ_CACHE_PATH, 'utf8'));
    records = raw.records || [];
    cacheAge = Date.now() - new Date(raw.lastUpdated || 0).getTime();
  } catch { /* no cache yet */ }

  // Step 2: If cache is stale or missing, refresh from API
  if (records.length === 0 || cacheAge > MEZZ_CACHE_MAX_AGE_MS) {
    const APP_ID = process.env.MEZZANINE_APP_ID;
    const SESSION_TOKEN = process.env.MEZZANINE_SESSION_TOKEN;

    if (APP_ID && SESSION_TOKEN) {
      console.log('   Refreshing Mezzanine image cache from API...');
      const apiRecords = [];
      let skip = 0;
      const batchSize = 1000;

      try {
        while (true) {
          const body = JSON.stringify({
            limit: batchSize, skip,
            where: { art: { '$exists': true } },
            include: 'show,theater',
            keys: 'art,show.name,theater.name,theater.isBroadway,openedAt,firstPreview,ratingsCount',
            _method: 'GET'
          });

          const data = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'api.theaterdiary.com',
              path: '/parse/classes/Production',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Parse-Application-Id': APP_ID,
                'X-Parse-Session-Token': SESSION_TOKEN,
                'Content-Length': Buffer.byteLength(body)
              }
            }, res => {
              let d = '';
              res.on('data', c => d += c);
              res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { reject(new Error('Mezzanine parse error')); }
              });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
          });

          if (!data.results || data.results.length === 0) break;
          for (const p of data.results) {
            if (!p.show?.name || !p.art?.url) continue;
            apiRecords.push({
              name: p.show.name,
              artUrl: p.art.url,
              theater: p.theater?.name || null,
              isBroadway: p.theater?.isBroadway === true,
              openedAt: p.openedAt || p.firstPreview || null,
              ratingsCount: p.ratingsCount || 0,
            });
          }
          skip += data.results.length;
          if (data.results.length < batchSize) break;
        }

        if (apiRecords.length > 0) {
          records = apiRecords;
          fs.writeFileSync(MEZZ_CACHE_PATH, JSON.stringify({
            lastUpdated: new Date().toISOString(),
            recordCount: records.length,
            records,
          }, null, 2));
          console.log(`   Cached ${records.length} Mezzanine productions with art`);
        }
      } catch (err) {
        console.log(`   ⚠ Mezzanine API error: ${err.message} — using ${records.length > 0 ? 'stale cache' : 'diary-shows fallback'}`);
      }
    } else if (records.length === 0) {
      console.log('   Mezzanine credentials not set, no cache available');
    }
  } else {
    console.log(`   Mezzanine cache: ${records.length} productions (${Math.round(cacheAge / 3600000)}h old)`);
  }

  // Step 3: Merge diary-shows.json poster URLs (off-Broadway/regional shows not in API)
  try {
    const diary = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/diary-shows.json'), 'utf8'));
    const existingNorms = new Set(records.map(r => normalizeMezzTitle(r.name)));
    let added = 0;
    for (const s of (diary.shows || [])) {
      if (!s.posterUrl || !s.title) continue;
      if (existingNorms.has(normalizeMezzTitle(s.title))) continue;
      records.push({
        name: s.title,
        artUrl: s.posterUrl,
        theater: s.venue || null,
        isBroadway: false,
        openedAt: s.openingDate || null,
        ratingsCount: s.audienceRatingsCount || 0,
      });
      added++;
    }
    if (added > 0) console.log(`   Merged ${added} additional poster URLs from diary-shows.json`);
  } catch { /* diary-shows not available */ }

  const byNormTitle = buildMezzIndex(records);
  mezzanineCache = { byNormTitle };
  return mezzanineCache;
}

// Mezzanine openedAt comes back from Parse API as { __type: 'Date', iso: '...' }
// but diary-shows.json fallback writes plain ISO strings. Handle both shapes.
function extractMezzYear(openedAt) {
  if (!openedAt) return 0;
  if (typeof openedAt === 'object' && openedAt !== null) {
    const iso = openedAt.iso || '';
    const y = parseInt(String(iso).substring(0, 4));
    return Number.isFinite(y) && y > 1900 ? y : 0;
  }
  if (typeof openedAt === 'string') {
    const y = parseInt(openedAt.substring(0, 4));
    return Number.isFinite(y) && y > 1900 ? y : 0;
  }
  return 0;
}

async function fetchFromMezzanine(show) {
  const { byNormTitle } = await loadMezzanineProductions();
  if (byNormTitle.size === 0) return null;

  const normTitle = normalizeMezzTitle(show.title);
  const candidates = byNormTitle.get(normTitle);
  if (!candidates || candidates.length === 0) return null;

  // Pick the best match by year proximity
  const showYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : 0;
  let best = null;
  let bestDist = Infinity;

  for (const p of candidates) {
    const mYear = extractMezzYear(p.openedAt);
    const dist = showYear && mYear ? Math.abs(showYear - mYear) : 999;

    // Year proximity is the PRIMARY signal. Broadway flag and ratings count are
    // only used as tiebreakers when year distance is equal. Previously, the
    // Broadway flag dominated year, so the first Broadway-flagged candidate
    // would win for every production of the same title.
    if (!best ||
        dist < bestDist ||
        (dist === bestDist && p.isBroadway && !best.isBroadway) ||
        (dist === bestDist && p.isBroadway === best.isBroadway && (p.ratingsCount || 0) > (best.ratingsCount || 0))) {
      best = p;
      bestDist = dist;
    }
  }

  if (!best || !best.artUrl) return null;

  // Reject if the best candidate's year is > 2 years off from the show.
  // This applies whether there is 1 candidate or many — a 1979 show should NOT
  // get the 1992 production's poster just because it's the only Mezzanine entry.
  // When no candidates have dates at all, fall through and trust verification downstream.
  const bestYear = extractMezzYear(best.openedAt);
  if (showYear && bestYear && bestDist > 2) {
    console.log(`   ✗ Mezzanine: best candidate is ${bestDist} years off (${bestYear} vs show ${showYear}) — skipping`);
    return null;
  }

  // Extra guard: if multiple candidates exist but the show has no opening year,
  // we cannot disambiguate productions. Skip rather than return an arbitrary one.
  if (candidates.length > 1 && !showYear) {
    console.log(`   ✗ Mezzanine: ${candidates.length} candidates but show has no openingDate — skipping`);
    return null;
  }

  const theater = best.theater || 'unknown venue';
  console.log(`   ✓ Mezzanine: found poster art (${theater}, ${bestDist <= 2 ? `year match dist=${bestDist}` : 'no year'})`);

  return {
    thumbnail: best.artUrl,
    poster: best.artUrl,
    hero: null,
  };
}

// ---- Theatr (theatr-app.com) image source — READ-ONLY CACHE ----
// This script does NOT call the Theatr API. The cache file
// data/theatr-image-cache.json is populated by scripts/scrape-theatr-audience.js
// (run weekly by update-theatr.yml). Centralizing Theatr auth to one script
// prevents the refresh-token race where two different workflows both rotated
// the token and one of them lost the rotated value, burning the whole chain.

const THEATR_CACHE_PATH = path.join(__dirname, '../data/theatr-image-cache.json');
const THEATR_CACHE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000; // 8 days — matches weekly cron cadence

let theatrCache = null;

async function loadTheatrShows() {
  if (theatrCache) return theatrCache;

  // READ-ONLY: this script no longer calls Theatr API. The cache file is
  // populated exclusively by scripts/scrape-theatr-audience.js (run weekly
  // by update-theatr.yml). Centralizing Theatr auth to one script prevents
  // the refresh-token race where fetch-images and update-theatr both rotated
  // the token and one of them lost the rotated value.
  //
  // If the cache is stale it is still used — the alternative (no Theatr
  // images) is strictly worse than a slightly old image URL.
  let records = [];
  let cacheAge = Infinity;
  try {
    const raw = JSON.parse(fs.readFileSync(THEATR_CACHE_PATH, 'utf8'));
    records = raw.records || [];
    cacheAge = Date.now() - new Date(raw.lastUpdated || 0).getTime();
  } catch { /* no cache */ }

  if (records.length === 0) {
    console.log('   ✗ Theatr: no cache file (run update-theatr.yml to populate)');
    theatrCache = { byNormTitle: new Map() };
    return theatrCache;
  }

  if (cacheAge > THEATR_CACHE_MAX_AGE_MS) {
    console.log(`   Theatr cache: ${records.length} shows (${Math.round(cacheAge / 3600000)}h old — stale but usable)`);
  } else {
    console.log(`   Theatr cache: ${records.length} shows (${Math.round(cacheAge / 3600000)}h old)`);
  }

  const byNormTitle = new Map();
  for (const r of records) {
    if (!r.name) continue;
    const norm = normalizeMezzTitle(r.name);
    if (!byNormTitle.has(norm)) byNormTitle.set(norm, []);
    byNormTitle.get(norm).push(r);
  }

  theatrCache = { byNormTitle };
  return theatrCache;
}

async function fetchFromTheatr(show) {
  const { byNormTitle } = await loadTheatrShows();
  if (byNormTitle.size === 0) return null;

  const normTitle = normalizeMezzTitle(show.title);
  const candidates = byNormTitle.get(normTitle);
  if (!candidates || candidates.length === 0) return null;

  const best = candidates.find(c => c.eventCategory === 'Broadway') || candidates[0];
  const hasImages = best.imageUrl || best.posterUrl || best.heroUrl;
  if (!hasImages) return null;

  console.log(`   ✓ Theatr: found images (${[
    best.imageUrl && 'square',
    best.posterUrl && 'poster',
    best.heroUrl && 'hero',
  ].filter(Boolean).join(' + ')})`);

  return {
    thumbnail: best.imageUrl || null,
    poster: best.posterUrl || null,
    hero: best.heroUrl || null,
  };
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

  // No fallback URL construction — IBDB bare slugs without numeric production IDs
  // redirect to homepage. Skip IBDB image search if no real URL is available.
  if (!ibdbUrl) {
    console.log(`   No IBDB URL available for "${show.title}" — skipping IBDB image search`);
    return null;
  }

  await sleep(1500);

  // Step 2: Scrape IBDB page (needs premium proxy)
  try {
    const html = await fetchPageWithFallback(ibdbUrl, { premiumProxy: true });

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

// Fetch show poster from ShowScore (show-score.com)
// ShowScore hosts poster images on CloudFront. We scrape the OG image or poster from the page.
async function fetchFromShowScore(show) {
  const category = show.category || 'broadway';
  const ssCategory = category === 'off-broadway' ? 'off-broadway-shows'
    : category === 'west-end' ? 'london-shows'
    : 'broadway-shows';

  // ShowScore slugs: lowercase, hyphens, no special chars
  const slug = show.title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '').replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const ssUrl = `https://www.show-score.com/${ssCategory}/${slug}`;
  console.log(`   Trying ShowScore: ${ssUrl}`);

  try {
    const html = await fetchPageWithFallback(ssUrl);

    // Extract poster image from CloudFront CDN
    // Pattern: d4ov6iqsvotvt.cloudfront.net/uploads/show/poster_image/NNNN/medium_...
    const posterMatch = html.match(/https:\/\/d4ov6iqsvotvt\.cloudfront\.net\/uploads\/show\/poster_image\/\d+\/medium_[^"'<\s]+\.(jpg|jpeg|png)/i);
    if (posterMatch) {
      const posterUrl = posterMatch[0];
      // Build thumbnail URL by replacing 'medium_' with 'preview_'
      const thumbUrl = posterUrl.replace('/medium_', '/preview_');
      console.log(`   ✓ Found poster via ShowScore`);
      return { thumbnail: thumbUrl, poster: posterUrl, hero: null };
    }

    // Fallback: try OG image meta tag
    const ogMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
    if (ogMatch && ogMatch[1] && ogMatch[1].includes('cloudfront.net')) {
      console.log(`   ✓ Found OG image via ShowScore`);
      return { thumbnail: ogMatch[1], poster: ogMatch[1], hero: null };
    }

    console.log(`   ✗ No poster image found on ShowScore page`);
  } catch (err) {
    console.log(`   ✗ ShowScore fetch failed: ${err.message}`);
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
// location=1 for NYC, location=2 for London
function fetchTodayTixApiPage(offset = 0, limit = 100, location = 1) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=${location}&limit=${limit}&offset=${offset}`;

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

// Fetch all active shows from TodayTix API (NYC + London) and build a lookup map
// Returns { normalizedTitle: { id, displayName, square, poster, hero, ... } }
async function fetchAllTodayTixShows() {
  console.log('\nFetching active shows from TodayTix API...');
  const allShows = [];

  // Fetch both NYC (location=1) and London (location=2)
  for (const loc of [1, 2]) {
    const market = loc === 1 ? 'NYC' : 'London';
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await fetchTodayTixApiPage(offset, limit, loc);
      if (!response.data || response.data.length === 0) break;

      allShows.push(...response.data);
      const total = response.pagination?.total || '?';
      console.log(`   Fetched ${allShows.length} shows (${market}: ${offset + response.data.length}/${total})...`);

      if (offset + response.data.length >= (response.pagination?.total || 0)) break;

      offset += limit;
      await sleep(500);
    }
  }

  console.log(`   Found ${allShows.length} active shows from API (NYC + London)\n`);

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
  const byId = {}; // TodayTix ID → image data (avoids title collisions between NYC/London)
  for (const show of allShows) {
    const name = show.displayName || show.name;
    if (!name) continue;

    const images = show.images?.productMedia || {};
    const entry = {
      id: show.id,
      displayName: name,
      square: extractUrl(images.posterImageSquare),
      poster: extractUrl(images.posterImage),
      hero: extractUrl(images.appHeroImage),
      imageForAds: extractUrl(images.imageForAds),
      headerImage: extractUrl(images.headerImage),
    };
    const key = normalizeTitle(name);
    lookup[key] = entry;
    byId[show.id] = entry;
  }

  lookup._byId = byId;
  return lookup;
}

// Match our show title against the TodayTix API lookup map
function matchTodayTixShow(showTitle, apiLookup, todaytixId) {
  if (!apiLookup || Object.keys(apiLookup).length === 0) return null;

  // 0. Direct ID match (most reliable — handles cross-market title collisions like "Hamilton")
  if (todaytixId && apiLookup._byId && apiLookup._byId[todaytixId]) {
    return apiLookup._byId[todaytixId];
  }

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
  const searchUrl = `https://www.todaytix.com/nyc/shows?q=${encodeURIComponent(cleanSearchTitle(showTitle))}`;

  try {
    const html = await fetchPageWithFallback(searchUrl);

    // Look for show links in format: /nyc/shows/{id}-{slug}
    const showLinkMatch = html.match(/\/nyc\/shows\/(\d+)-([a-z0-9-]+)/i);

    if (showLinkMatch) {
      const id = parseInt(showLinkMatch[1]);
      const slug = showLinkMatch[2];

      // Verify slug matches show title (prevent false positives like "fun-home" → "fun-homes-oscar-williams")
      const slugWords1 = slug.replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 0);
      const titleWords1 = normalizeTitle(showTitle).split(/\s+/).filter(w => w.length > 0);
      const overlap1 = titleWords1.length > 0 ? titleWords1.filter(w => slugWords1.includes(w)).length / titleWords1.length : 0;

      if (overlap1 >= 0.5) {
        console.log(`   ✓ Found TodayTix ID: ${id} (${slug})`);
        return { id, slug };
      } else {
        console.log(`   ✗ Skipping TodayTix result: slug "${slug}" doesn't match "${showTitle}" (${Math.round(overlap1 * 100)}% overlap)`);
      }
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

        // Verify slug matches show title (prevent SERP false positives)
        const slugWords2 = slug.replace(/-/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 0);
        const titleWords2 = normalizeTitle(showTitle).split(/\s+/).filter(w => w.length > 0);
        const overlap2 = titleWords2.length > 0 ? titleWords2.filter(w => slugWords2.includes(w)).length / titleWords2.length : 0;

        if (overlap2 >= 0.5) {
          console.log(`   ✓ Found TodayTix ID via Google: ${id} (${slug})`);
          return { id, slug };
        } else {
          console.log(`   ✗ Skipping SERP result: slug "${slug}" doesn't match "${showTitle}" (${Math.round(overlap2 * 100)}% overlap)`);
        }
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
      const html = await fetchPageWithFallback(cachedUrl);
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
      const html = await fetchPageWithFallback(playbillUrl);
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

  // Last resort: Google search. The literal quotes around the title must be
  // part of the encoded query — an unencoded `"` in the URL trips Bright
  // Data's `"url" must be a valid uri` 400 (task #688).
  console.log(`   Trying Google search for Playbill page...`);
  const searchQuery = `site:playbill.com/production "${show.title}" broadway`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;

  try {
    const searchHtml = await fetchPageWithFallback(searchUrl);
    const urlMatch = searchHtml.match(/https:\/\/playbill\.com\/production\/[a-z0-9-]+-broadway[a-z0-9-]*/i);

    if (urlMatch) {
      const discoveredUrl = urlMatch[0];
      console.log(`   Found via Google: ${discoveredUrl}`);

      await sleep(2000);
      const html = await fetchPageWithFallback(discoveredUrl);
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

// ============================================================
// Google Images search via ScrapingBee SERP API
// ============================================================

// Image magic number signatures for binary validation
const IMAGE_SIGNATURES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png:  [0x89, 0x50, 0x4E, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46],  // "RIFF" (WebP starts with RIFF....WEBP)
};

function isImageBuffer(buffer) {
  if (buffer.length < 4) return false;
  for (const [, sig] of Object.entries(IMAGE_SIGNATURES)) {
    if (sig.every((byte, i) => buffer[i] === byte)) return true;
  }
  return false;
}

// ============================================================
// Image dimension detection from binary headers
// Supports JPEG (SOF0/SOF2), PNG (IHDR), WebP (VP8/VP8L/VP8X)
// Returns { width, height } or null on parse failure (fail-open)
// ============================================================

function getImageDimensions(buffer) {
  if (!buffer || buffer.length < 30) return null;
  try {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xFF) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
        const len = buffer.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
      return null;
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      const fourCC = buffer.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buffer.length > 29) {
        const width = buffer.readUInt16LE(26) & 0x3FFF;
        const height = buffer.readUInt16LE(28) & 0x3FFF;
        return { width, height };
      }
      if (fourCC === 'VP8L' && buffer.length > 25) {
        const bits = buffer.readUInt32LE(21);
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        return { width, height };
      }
      if (fourCC === 'VP8X' && buffer.length > 29) {
        const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
        const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
        return { width, height };
      }
    }
  } catch { }
  return null;
}

function isNativeSquareBuffer(buffer) {
  const dims = getImageDimensions(buffer);
  if (!dims) return false;
  const ratio = dims.width / dims.height;
  return ratio >= 0.85 && ratio <= 1.15;
}

// Reject wide-landscape buffers in the poster slot. The show page renders
// poster.webp inside aspect-[2/3] object-cover — landscape inputs become
// vertical slivers (evita-west-end-2025 commit a71c3defe4 class).
// Threshold matches scripts/check-image-aspect.js: h/w >= 1.0.
function isPortraitOrSquareBuffer(buffer) {
  const dims = getImageDimensions(buffer);
  if (!dims) return true; // can't tell — let downstream verification decide
  return (dims.height / dims.width) >= 1.0;
}

function extractDirectImageUrl(url) {
  // Google redirect URLs: google.com/imgres?imgurl=ACTUAL_URL&...
  if (url.includes('google.com/imgres')) {
    const match = url.match(/[?&]imgurl=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return url;
}

function searchGoogleImagesSB(query) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY not set'));
      return;
    }

    const serpUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_API_KEY}&search=${encodeURIComponent(query)}&search_type=images&nb_results=10`;
    https.get(serpUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Google Images SERP HTTP ${response.statusCode}`));
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.image_results || parsed.images || []);
        } catch { reject(new Error('Failed to parse image search results')); }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Search Google Images via the shared fallback chain (fallback — returns
// direct URLs, not base64). Plain HTML page fetch, so fetchPage() handles it
// like any other page (Bright Data → ScrapingBee → Scrapingdog → Playwright).
async function searchGoogleImagesBD(query) {
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&num=20`;
  const html = await fetchPageWithFallback(googleUrl);
  const results = [];
  // Google embeds image metadata as JSON arrays: ["URL", width, height]
  const imgRegex = /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\s*(\d+),\s*(\d+)\]/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const imgUrl = match[1];
    const width = parseInt(match[2]);
    const height = parseInt(match[3]);
    if (width < 100 || height < 100) continue;
    if (imgUrl.includes('gstatic.com') || imgUrl.includes('google.com')) continue;
    let domain = '';
    try { domain = new URL(imgUrl).hostname; } catch {}
    if (/ebay|etsy|pinterest|redbubble|teepublic|amazon\.com\/dp/i.test(domain)) continue;
    results.push({ image: null, imageUrl: imgUrl, url: imgUrl, title: '', domain, width, height, _brightdata: true });
    if (results.length >= 10) break;
  }
  return results;
}

// Unified Google Images search: ScrapingBee → Bright Data fallback
// Latches off after the first ScrapingBee credit/auth failure so an exhausted
// key logs ONE skip line instead of re-hitting the same 401 on every show
// (task #688 — this endpoint is ScrapingBee's Google-Images SERP product,
// which has no fetchPage() equivalent, so it can't inherit scraper.js's
// shared _scrapingBeePageExhausted latch and needs its own).
let _sbImagesExhausted = false;

async function searchGoogleImages(query) {
  if (SCRAPINGBEE_API_KEY && !_sbImagesExhausted) {
    try {
      return await searchGoogleImagesSB(query);
    } catch (sbErr) {
      const status = /HTTP (\d+)/.exec(sbErr.message)?.[1];
      if ([401, 403, 429].includes(Number(status))) {
        _sbImagesExhausted = true;
        console.log(`   ⚠ ScrapingBee Images exhausted (HTTP ${status}) — skipping SB Images for the rest of this run`);
      }
      if (BRIGHTDATA_TOKEN) {
        console.log(`   ⚠ ScrapingBee Images failed (${sbErr.message}), trying Bright Data...`);
      } else {
        throw sbErr;
      }
    }
  }
  return await searchGoogleImagesBD(query);
}

// Helper: extract valid image buffer from Google Images result
// Handles both ScrapingBee (base64 inline) and Bright Data (direct URL) results
async function extractImageBuffer(result) {
  // ScrapingBee format: base64 data URI
  if (result.image && result.image.startsWith('data:image/')) {
    const commaIdx = result.image.indexOf(',');
    if (commaIdx === -1) return null;
    const buffer = Buffer.from(result.image.substring(commaIdx + 1), 'base64');
    if (buffer.length < 3000 || !isImageBuffer(buffer)) return null;
    return buffer;
  }
  // Bright Data format: direct image URL — download it
  if (result._brightdata && result.imageUrl) {
    try {
      const buffer = await downloadImageDirect(result.imageUrl);
      if (buffer.length < 3000 || !isImageBuffer(buffer)) return null;
      return buffer;
    } catch {
      return null;
    }
  }
  return null;
}

// Helper: filter Google Images results to usable candidates
// Handles both ScrapingBee (base64 image) and Bright Data (imageUrl) formats
function filterGoogleCandidates(results, maxCount = 10) {
  return (results || [])
    .filter(r => {
      // ScrapingBee: has base64 data URI
      const hasSBImage = r.image && r.image.startsWith('data:image/');
      // Bright Data: has direct URL
      const hasBDImage = r._brightdata && r.imageUrl;
      if (!hasSBImage && !hasBDImage) return false;
      const domain = (r.domain || r.url || '').toLowerCase();
      if (/ebay|etsy|pinterest|redbubble|teepublic|amazon\.com\/dp/i.test(domain)) return false;
      return true;
    })
    .slice(0, maxCount);
}

async function fetchFromGoogleImages(show) {
  const year = show.openingDate ? show.openingDate.substring(0, 4) : '';
  const safeTitle = show.title.replace(/"/g, '');
  // Query keyword must match the show's market — searching "Broadway" for an
  // Off-Broadway/West End production surfaces the wrong-production's art (or
  // nothing at all: the-gin-game-2026 at Housing Works found 0 candidates while
  // the 2015 Broadway revival's images ranked).
  const marketKw = show.category === 'off-broadway' ? 'Off-Broadway'
    : show.category === 'west-end' ? 'West End'
    : 'Broadway';
  const outputBase = dryRunMode ? DRY_RUN_DIR : IMAGES_DIR;
  const showDir = path.join(outputBase, show.id);
  fs.mkdirSync(showDir, { recursive: true });

  let thumbnailBuffer = null;
  let thumbnailResult = null;
  let posterBuffer = null;
  let squareCandidates = [];
  let posterCandidates = [];

  // ============================================================
  // SEARCH 1: Square images (for homepage thumbnail cards)
  // Year-aware query with quoted title to prevent partial matches
  // ============================================================
  const squareQuery = year
    ? `"${safeTitle}" ${year} ${marketKw} square`
    : `"${safeTitle}" ${marketKw} square`;
  console.log(`   Trying Google Images (square): "${squareQuery}"`);

  try {
    const squareResults = await searchGoogleImages(squareQuery);
    squareCandidates = filterGoogleCandidates(squareResults, 10);
    console.log(`   Found ${squareCandidates.length} square candidates`);

    for (const result of squareCandidates) {
      const buffer = await extractImageBuffer(result);
      if (buffer) {
        const dims = getImageDimensions(buffer);
        if (dims && !isNativeSquareBuffer(buffer)) {
          console.log(`   ⚠ Skipping non-square image (${dims.width}x${dims.height}) from ${result.domain}`);
          continue;
        }
        console.log(`   ✓ Valid square image (${(buffer.length/1024).toFixed(0)} KB${dims ? `, ${dims.width}x${dims.height}` : ''}) from ${result.domain}`);
        thumbnailBuffer = buffer;
        thumbnailResult = result;
        break;
      }
    }

    // Fallback: retry without year if year query returned 0 candidates
    if (!thumbnailBuffer && year && squareCandidates.length === 0) {
      const fallbackQuery = `"${safeTitle}" ${marketKw} square`;
      console.log(`   Retrying square search without year: "${fallbackQuery}"`);
      const fallbackResults = await searchGoogleImages(fallbackQuery);
      const fallbackCandidates = filterGoogleCandidates(fallbackResults, 10);
      for (const result of fallbackCandidates) {
        const buffer = await extractImageBuffer(result);
        if (buffer) {
          const dims = getImageDimensions(buffer);
          if (dims && !isNativeSquareBuffer(buffer)) continue;
          thumbnailBuffer = buffer;
          thumbnailResult = result;
          squareCandidates = fallbackCandidates;
          break;
        }
      }
    }
  } catch (err) {
    console.log(`   ⚠ Square search failed: ${err.message}`);
  }

  await sleep(1500);

  // ============================================================
  // SEARCH 2: Poster images (for show detail pages)
  // Year-aware query with quoted title
  // ============================================================
  const posterQuery = year
    ? `"${safeTitle}" ${year} ${marketKw} poster`
    : `"${safeTitle}" ${marketKw} poster`;
  console.log(`   Trying Google Images (poster): "${posterQuery}"`);

  try {
    const posterResults = await searchGoogleImages(posterQuery);
    posterCandidates = filterGoogleCandidates(posterResults, 10);
    console.log(`   Found ${posterCandidates.length} poster candidates`);

    for (const result of posterCandidates) {
      const buffer = await extractImageBuffer(result);
      if (buffer) {
        if (!isPortraitOrSquareBuffer(buffer)) {
          const dims = getImageDimensions(buffer);
          console.log(`   ⚠ Skipping landscape image (${dims ? `${dims.width}x${dims.height}` : 'unknown dims'}) from ${result.domain} — wrong shape for poster`);
          continue;
        }
        console.log(`   ✓ Valid poster image (${(buffer.length/1024).toFixed(0)} KB) from ${result.domain}`);
        posterBuffer = buffer;
        break;
      }
    }

    // Fallback: retry without year if year query returned 0 candidates
    if (!posterBuffer && year && posterCandidates.length === 0) {
      const fallbackQuery = `"${safeTitle}" ${marketKw} poster`;
      console.log(`   Retrying poster search without year: "${fallbackQuery}"`);
      const fallbackResults = await searchGoogleImages(fallbackQuery);
      posterCandidates = filterGoogleCandidates(fallbackResults, 10);
      for (const result of posterCandidates) {
        const buffer = await extractImageBuffer(result);
        if (buffer) {
          if (!isPortraitOrSquareBuffer(buffer)) continue;
          posterBuffer = buffer;
          break;
        }
      }
    }
  } catch (err) {
    console.log(`   ⚠ Poster search failed: ${err.message}`);
  }

  // ============================================================
  // Save results - need at least one image
  // ============================================================
  if (!thumbnailBuffer && !posterBuffer) {
    console.log(`   ✗ No usable images found`);
    return null;
  }

  // Save thumbnail (prefer square, fall back to poster)
  const finalThumbnailBuffer = await compressImage(thumbnailBuffer || posterBuffer, 'thumbnail');
  const thumbHash = crypto.createHash('md5').update(finalThumbnailBuffer).digest('hex');
  if (PLACEHOLDER_FILE_HASHES.has(thumbHash)) {
    console.log(`   ✗ Downloaded thumbnail is a "Coming Soon" placeholder — rejecting`);
    return null;
  }
  const thumbnailPath = path.join(showDir, 'thumbnail.jpg');
  fs.writeFileSync(thumbnailPath, finalThumbnailBuffer);
  console.log(`   ✓ Saved thumbnail${thumbnailBuffer ? ' (native square)' : ' (from poster)'}`);

  // Save poster if we have one distinct from thumbnail
  let posterPath = null;
  if (posterBuffer && posterBuffer !== (thumbnailBuffer || posterBuffer)) {
    const compressedPoster = await compressImage(posterBuffer, 'poster');
    const posterHash = crypto.createHash('md5').update(compressedPoster).digest('hex');
    if (PLACEHOLDER_FILE_HASHES.has(posterHash)) {
      console.log(`   ✗ Downloaded poster is a "Coming Soon" placeholder — rejecting`);
    } else {
      posterPath = path.join(showDir, 'poster.jpg');
      fs.writeFileSync(posterPath, compressedPoster);
      console.log(`   ✓ Saved poster`);
    }
  }

  // Build remaining candidates for retry (combine both searches)
  const usedResults = [thumbnailResult].filter(Boolean);
  const allRemaining = [...squareCandidates, ...posterCandidates]
    .filter(r => !usedResults.includes(r));

  return {
    thumbnail: `/images/shows/${show.id}/thumbnail.jpg`,
    poster: posterPath ? `/images/shows/${show.id}/poster.jpg` : null,
    hero: null,
    _verifyBuffer: finalThumbnailBuffer,
    _remainingCandidates: allRemaining,
    _hasNativeSquare: !!thumbnailBuffer,
  };
}

// Try next Google Images candidate after rejection
// Re-uses the remaining candidates from the initial search
// Handles both ScrapingBee (base64) and Bright Data (direct URL) results
async function tryNextGoogleCandidate(show, remainingCandidates) {
  for (const result of remainingCandidates) {
    try {
      const buffer = await extractImageBuffer(result);
      if (!buffer) continue;

      console.log(`   ✓ Trying next Google Images candidate (${(buffer.length/1024).toFixed(0)} KB) from ${result.domain}: ${result.title?.substring(0, 50)}`);

      const outputBase = dryRunMode ? DRY_RUN_DIR : IMAGES_DIR;
      const showDir = path.join(outputBase, show.id);
      fs.mkdirSync(showDir, { recursive: true });
      const compressed = await compressImage(buffer, 'thumbnail');
      const thumbnailPath = path.join(showDir, 'thumbnail.jpg');
      fs.writeFileSync(thumbnailPath, compressed);

      const nextRemaining = remainingCandidates.slice(remainingCandidates.indexOf(result) + 1);
      return {
        thumbnail: `/images/shows/${show.id}/thumbnail.jpg`,
        poster: null,
        hero: null,
        _verifyBuffer: buffer,
        _remainingCandidates: nextRemaining,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// Score an image candidate based on verification result and URL heuristics.
// Higher score = more desirable image (promotional art > production still > other).
function scoreCandidate(verifyResult, url) {
  const { classifyImageUrl } = require('./lib/verify-image');
  const typeScores = { promotional_art: 3, production_still: 1, headshot_cast: 0, other: 0 };
  const confScores = { high: 2, medium: 1, low: 0 };
  let score = (typeScores[verifyResult.imageType] || 0) * 10
            + (confScores[verifyResult.confidence] || 0);
  // URL heuristic bonus
  if (classifyImageUrl(url) === 'promotional_art') score += 3;
  return score;
}

// Verify images from a non-trusted tier.
// Returns { images, verifyResult, url, tierName, score } for candidate collection,
// or null if rejected.
async function verifyAndCollect(images, show, tierName, verifyCtx) {
  if (!verifyCtx) {
    delete images._verifyBuffer;
    delete images._remainingCandidates;
    return { images, verifyResult: null, tierName, score: 0 };
  }

  const { verifyImage } = require('./lib/verify-image');

  // Pick best image to verify: thumbnail > poster > hero
  const urlToVerify = images.thumbnail || images.poster || images.hero;
  if (!urlToVerify) return { images, verifyResult: null, tierName, score: 0 };

  // Use pre-downloaded buffer if available (e.g., Google Images base64 data)
  const imageInput = images._verifyBuffer || urlToVerify;
  // Clean up internal fields so they don't leak into shows.json
  delete images._verifyBuffer;
  delete images._remainingCandidates;

  const year = show.openingDate ? show.openingDate.substring(0, 4) : null;
  console.log(`   🔍 Verifying ${tierName} image...`);

  const result = await verifyImage(imageInput, show.title, {
    year,
    openingDate: show.openingDate,
    rateLimiter: verifyCtx.rateLimiter,
  });

  // Fix 2: Override non_broadway rejection for pre-Broadway venue shows
  // ONLY when non_broadway is the sole issue — if the image is also wrong_show
  // or generic_image, the override must NOT fire (e.g., Starlight Theatre banner ≠ Jerome)
  if (result.match === false
      && result.issues?.length === 1
      && result.issues[0] === 'non_broadway'
      && PRE_BROADWAY_VENUE_SHOWS.has(show.id)) {
    console.log(`   ⚠ VENUE OVERRIDE: Accepting pre-Broadway venue art for ${show.id}`);
    const score = scoreCandidate({ ...result, match: true }, urlToVerify);
    verifyCtx.verified = (verifyCtx.verified || 0) + 1;
    verifyCtx.venueOverrides = (verifyCtx.venueOverrides || 0) + 1;
    return { images, verifyResult: result, url: urlToVerify, tierName, score };
  }

  // Fix 3: Track production photos as fallback instead of rejecting outright
  if (result.imageType === 'production_still') {
    const bufSize = Buffer.isBuffer(imageInput) ? imageInput.length : 0;
    console.log(`   ⚠ DEFERRED (production photo): ${result.description} — will use as fallback if no poster art`);
    verifyCtx.productionPhotos = (verifyCtx.productionPhotos || 0) + 1;
    verifyCtx.productionPhotoFallbacks = verifyCtx.productionPhotoFallbacks || [];
    verifyCtx.productionPhotoFallbacks.push({ images, verifyResult: result, url: urlToVerify, tierName, score: -5, bufSize });
    return null;  // Don't add to main candidates yet
  }

  if (result.match === true) {
    const score = scoreCandidate(result, urlToVerify);
    console.log(`   ✓ VERIFIED (${result.confidence}, ${result.imageType}): ${result.description} [score=${score}]`);
    verifyCtx.verified = (verifyCtx.verified || 0) + 1;
    if (result.imageType) {
      verifyCtx.imageTypes = verifyCtx.imageTypes || {};
      verifyCtx.imageTypes[result.imageType] = (verifyCtx.imageTypes[result.imageType] || 0) + 1;
    }
    return { images, verifyResult: result, url: urlToVerify, tierName, score };
  } else if (result.match === false &&
             (result.confidence === 'high' || result.confidence === 'medium')) {
    console.log(`   ✗ REJECTED (${result.confidence}): ${result.description} [${result.issues.join(', ')}]`);
    verifyCtx.rejected = (verifyCtx.rejected || 0) + 1;
    return null;
  } else {
    // Low confidence rejection or API error → fail open
    const score = scoreCandidate(result, urlToVerify);
    console.log(`   ⚠ UNCERTAIN (${result.confidence}): ${result.description} — accepting [score=${score}]`);
    verifyCtx.uncertain = (verifyCtx.uncertain || 0) + 1;
    return { images, verifyResult: result, url: urlToVerify, tierName, score };
  }
}

async function fetchShowImages(show, todayTixInfo, apiData, verifyCtx) {
  console.log(`\n📽️  ${show.title}`);

  // Regional feeder-venue shows: venue og:image is the canonical key art —
  // none of the NYC-centric sources below know these productions.
  if (show.category === 'regional') {
    const regional = await fetchFromRegionalVenue(show, verifyCtx);
    if (regional) return regional;
    console.log('   ⚠ regional venue sourcing failed — falling through to generic chain');
  }

  // Step 1: Try TodayTix API data (native square images, no HTTP call needed)
  // TRUSTED SOURCE — skip verification
  if (apiData) {
    console.log(`   Found in TodayTix API: "${apiData.displayName}" (ID: ${apiData.id})`);

    const thumbnail = apiData.square || apiData.imageForAds || null;
    const poster = apiData.poster || null;
    const hero = apiData.hero || apiData.headerImage || null;

    // Filter out "Coming Soon" placeholder images from TodayTix
    // Detect by filename pattern OR known Contentful asset IDs (some use generic filenames)
    const COMING_SOON_ASSET_IDS = new Set([
      '74xXALpVG4Bdn59x8L9OYN', '42EOxYmUHQE0Xuza0dUlJm', '1Ya0iMOMWjrOvnZPMv9y8k',
      '6W6O3eG33mXg3uJes4DBQ2', 'Y2lDO0gaKjUKp333ZG3zW', '3khjL5U7k9860pnRWY6wxe',
      '3kXlmb7NIDQUq2fEi8FK8C', '2NXMbF8ZGgylEVESpiUIlf', '4dVF8DYwWDn4B5OFSi3x3c',
    ]);
    const getAssetId = (url) => { const m = url && url.match(/ctfassets\.net\/[^/]+\/([^/]+)/); return m ? m[1] : null; };
    const isComingSoon = (url) => url && (
      /coming.?soon/i.test(url) ||
      /NORAM[_\s]/i.test(url) ||          // TodayTix generic "Coming Soon" poster/hero template
      /square_photo\.png/i.test(url) ||    // TodayTix generic "Coming Soon" square template
      COMING_SOON_ASSET_IDS.has(getAssetId(url))
    );
    const filteredThumb = isComingSoon(thumbnail) ? null : thumbnail;
    const filteredPoster = isComingSoon(poster) ? null : poster;
    const filteredHero = isComingSoon(hero) ? null : hero;

    if (filteredThumb !== thumbnail || filteredPoster !== poster || filteredHero !== hero) {
      console.log(`   ⚠️  Filtered out "Coming Soon" placeholder image(s)`);
    }

    if (filteredThumb || filteredPoster) {
      // Add webp quality param to Contentful URLs that don't already have params
      const addWebp = (url) => {
        if (!url) return null;
        if (url.includes('?')) return url;
        return url + '?fm=webp&q=90';
      };

      const thumbIsNative = isNativeSquareUrl(filteredThumb);
      console.log(`     - Square (thumbnail): ${filteredThumb ? (thumbIsNative ? '✓ native square from API' : '⚠ poster crop from API') : 'not available'}`);
      console.log(`     - Portrait (poster): ${filteredPoster ? 'from API' : 'not available'}`);
      console.log(`     - Landscape (hero): ${filteredHero ? 'from API' : 'not available'}`);

      // Verify TodayTix API images when --verify is active.
      // TodayTix was the source of every Coming Soon placeholder that hit the site —
      // visual verification catches novel placeholder designs that URL patterns miss.
      if (verifyCtx) {
        const { verifyImage: verifyTodayTixImage } = require('./lib/verify-image');
        const verifyUrl = addWebp(filteredThumb || filteredPoster);
        try {
          const buffer = await downloadImageDirect(verifyUrl);
          if (buffer) {
            const result = await verifyTodayTixImage(buffer, show.title, {
              year: show.openingDate ? show.openingDate.substring(0, 4) : null,
              openingDate: show.openingDate,
              rateLimiter: verifyCtx.rateLimiter,
            });
            if (result.match === false && result.confidence === 'high') {
              console.log(`   ✗ TodayTix API image REJECTED by verification: ${result.description} [${result.issues?.join(', ')}]`);
              // Fall through to other sources
            } else {
              console.log(`   ✓ TodayTix API image verified: ${result.description}`);
              return {
                hero: addWebp(filteredHero),
                thumbnail: addWebp(filteredThumb),
                poster: addWebp(filteredPoster),
              };
            }
          }
        } catch (err) {
          // Verification failed (network, rate limit) — trust URL-based detection and accept
          console.log(`   ⚠ TodayTix API verification failed (${err.message}), accepting based on URL check`);
          return {
            hero: addWebp(filteredHero),
            thumbnail: addWebp(filteredThumb),
            poster: addWebp(filteredPoster),
          };
        }
      } else {
        // No verification — trust URL-based filtering
        return {
          hero: addWebp(filteredHero),
          thumbnail: addWebp(filteredThumb),
          poster: addWebp(filteredPoster),
        };
      }
    }

    console.log(`   API match found but all images are placeholders, trying other sources`);
  }

  // When --verify is active, collect candidates from all tiers and pick the best
  // instead of returning on first success. This prefers promotional art over production stills.
  const candidates = [];

  // Step 1.5: Try Mezzanine (theaterdiary.com) — direct API, production-specific, free
  // NEEDS VERIFICATION — user-uploaded poster photos, quality varies
  const mezzImages = await fetchFromMezzanine(show);
  if (mezzImages && (mezzImages.thumbnail || mezzImages.poster)) {
    const candidate = await verifyAndCollect(mezzImages, show, 'Mezzanine', verifyCtx);
    if (candidate) {
      candidates.push(candidate);
      if (candidate.verifyResult?.imageType === 'promotional_art' &&
          candidate.verifyResult?.confidence === 'high') {
        console.log(`   ★ Promotional art found at high confidence — using this`);
        return candidate.images;
      }
      if (!verifyCtx) return candidate.images;
    }
    if (verifyCtx && !candidate) console.log(`   Falling through to TodayTix scrape...`);
  }

  // Step 1.75: Try Theatr — all 3 image formats including hero (landscape banner)
  // NEEDS VERIFICATION — current shows only, ~200 Broadway/OB
  const theatrImages = await fetchFromTheatr(show);
  if (theatrImages && (theatrImages.thumbnail || theatrImages.poster)) {
    const candidate = await verifyAndCollect(theatrImages, show, 'Theatr', verifyCtx);
    if (candidate) {
      candidates.push(candidate);
      if (candidate.verifyResult?.imageType === 'promotional_art' &&
          candidate.verifyResult?.confidence === 'high') {
        console.log(`   ★ Promotional art found at high confidence — using this`);
        return candidate.images;
      }
      if (!verifyCtx) return candidate.images;
    }
    if (verifyCtx && !candidate) console.log(`   Falling through to TodayTix scrape...`);
  }

  // Step 2: Try TodayTix page scrape if we have an ID
  // NEEDS VERIFICATION — scraped images may be from wrong show/production
  if (todayTixInfo && todayTixInfo.id) {
    const slug = todayTixInfo.slug || show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.todaytix.com/nyc/shows/${todayTixInfo.id}-${slug}`;
    console.log(`   Fetching: ${url}`);

    try {
      const html = await fetchPageWithFallback(url);
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

        const candidate = await verifyAndCollect(formatted, show, 'TodayTix scrape', verifyCtx);
        if (candidate) {
          candidates.push(candidate);
          // Early exit: if this is promotional art at high confidence, no need to try more tiers
          if (candidate.verifyResult?.imageType === 'promotional_art' &&
              candidate.verifyResult?.confidence === 'high') {
            console.log(`   ★ Promotional art found at high confidence — using this`);
            return candidate.images;
          }
          // Without verify, first success wins (original behavior)
          if (!verifyCtx) return candidate.images;
        }
        if (verifyCtx && !candidate) console.log(`   Falling through to IBDB...`);
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
    const candidate = await verifyAndCollect(ibdbImages, show, 'IBDB', verifyCtx);
    if (candidate) {
      candidates.push(candidate);
      if (candidate.verifyResult?.imageType === 'promotional_art' &&
          candidate.verifyResult?.confidence === 'high') {
        console.log(`   ★ Promotional art found at high confidence — using this`);
        return candidate.images;
      }
      if (!verifyCtx) return candidate.images;
    }
    if (verifyCtx && !candidate) console.log(`   Falling through to Google Images...`);
  }

  // Step 3.5: Try ShowScore poster images
  const showScoreImages = await fetchFromShowScore(show);
  if (showScoreImages && (showScoreImages.thumbnail || showScoreImages.poster)) {
    const candidate = await verifyAndCollect(showScoreImages, show, 'ShowScore', verifyCtx);
    if (candidate) {
      candidates.push(candidate);
      if (candidate.verifyResult?.imageType === 'promotional_art' &&
          candidate.verifyResult?.confidence === 'high') {
        console.log(`   ★ Promotional art found at high confidence — using this`);
        return candidate.images;
      }
      if (!verifyCtx) return candidate.images;
    }
    if (verifyCtx && !candidate) console.log(`   Falling through to Google Images...`);
  }

  // Step 4 (NEW): Google Images search for promotional art
  // Broad coverage — finds thumbnail art that structured sources miss
  // Loops through multiple candidates if verification rejects the first one
  let googleImages = await fetchFromGoogleImages(show);
  while (googleImages && googleImages.thumbnail) {
    // Save remaining candidates before verifyAndCollect deletes them
    const remaining = googleImages._remainingCandidates || [];
    const candidate = await verifyAndCollect(googleImages, show, 'Google Images', verifyCtx);
    if (candidate) {
      candidates.push(candidate);
      if (candidate.verifyResult?.imageType === 'promotional_art' &&
          candidate.verifyResult?.confidence === 'high') {
        console.log(`   ★ Promotional art found at high confidence — using this`);
        return candidate.images;
      }
      if (!verifyCtx) return candidate.images;
      break;  // Accepted — stop trying more candidates
    }
    // Rejected — try next candidate from the same search results
    if (remaining.length === 0) break;
    googleImages = await tryNextGoogleCandidate(show, remaining);
  }

  // Step 5 (was Step 4): Playbill fallback (landscape OG image only)
  // NEEDS VERIFICATION — last resort
  const playbillImages = await fetchFromPlaybill(show);
  if (playbillImages) {
    const candidate = await verifyAndCollect(playbillImages, show, 'Playbill', verifyCtx);
    if (candidate) {
      candidates.push(candidate);
      if (!verifyCtx) return candidate.images;
    } else if (verifyCtx) {
      // Even Playbill failed verification — treat as last resort candidate
      verifyCtx.lastResort = (verifyCtx.lastResort || 0) + 1;
      candidates.push({ images: playbillImages, verifyResult: null, tierName: 'Playbill (last resort)', score: -1 });
    }
  }

  // Pick the best candidate from all tiers
  if (candidates.length > 0) {
    if (verifyCtx && candidates.length > 1) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      console.log(`   ★ Picked best candidate: ${best.tierName} (score=${best.score}, type=${best.verifyResult?.imageType || 'unknown'})`);
      if (candidates.length > 1) {
        const others = candidates.slice(1).map(c => `${c.tierName}(${c.score})`).join(', ');
        console.log(`     Other candidates: ${others}`);
      }
      return best.images;
    }
    return candidates[0].images;
  }

  // Fix 4: Last resort — use production photo fallback with 3 safety guards
  const existingThumb = show.images?.thumbnail;
  const isPinned = PINNED_IMAGES.has(show.id);
  if (!existingThumb                                      // GUARD 1: Don't overwrite existing images
      && !isPinned                                         // GUARD 2: Never override pinned images
      && verifyCtx?.productionPhotoFallbacks?.length > 0) {
    const best = verifyCtx.productionPhotoFallbacks[0];
    if (best.bufSize > 5000) {                             // GUARD 3: Quality floor (>5KB)
      console.log(`   ⚠ LAST RESORT: Using production photo — no poster art available (${(best.bufSize/1024).toFixed(0)} KB)`);
      verifyCtx.lastResort = (verifyCtx.lastResort || 0) + 1;
      return best.images;
    } else {
      console.log(`   ✗ Production photo too small/no buffer (${best.bufSize} bytes), skipping`);
    }
  }

  return null;
}

// Process a single show: discover TodayTix ID, fetch images, update show object.
// Returns { show, images, apiSourced } or null on failure.
async function processOneShow(show, apiLookup, todayTixIds, badImagesOnly, verifyCtx) {
  // Skip pinned images — these were manually curated and must not be overwritten
  if (PINNED_IMAGES.has(show.id) && show.images?.thumbnail) {
    console.log(`   PINNED — skipping ${show.id} (manually curated thumbnail)`);
    return null;
  }

  // Guard: for closed shows with a newer production of the same title,
  // skip TodayTix sources (which return current production art) but still try
  // production-specific sources like IBDB, ShowScore, Google Images, and Playbill.
  let skipTodayTix = false;
  if (show.status === 'closed') {
    const baseTitle = show.title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
    const newerProduction = allShowsData.shows.find(s => {
      if (s.id === show.id) return false;
      const sBase = s.title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
      // Exact match OR the full base title (2+ words) appears separated by punctuation (- : , !)
      // Catches "The Tempest - Globe", "Encores! The Wild Party", "Doubt: A Parable"
      // but NOT short titles like "Big" → "Big Fish" (space-only, no punct) or single words
      const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hasMultipleWords = baseTitle.includes(' ');
      const isVariant = hasMultipleWords &&
        new RegExp(`(^${escaped}\\s*[-:,]|[-:!]\\s*${escaped}$)`).test(sBase);
      if (sBase !== baseTitle && !isVariant) return false;
      // Newer = has a later opening date
      const showYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 0;
      const sYear = s.openingDate ? new Date(s.openingDate).getFullYear() : 0;
      return sYear > showYear;
    });
    if (newerProduction) {
      console.log(`   ⚠ Newer production "${newerProduction.id}" exists — skipping TodayTix, trying IBDB/Google`);
      skipTodayTix = true;
    }
  }

  let apiData = null;
  let todayTixInfo = null;

  if (!skipTodayTix) {
    // Try matching against TodayTix API data (instant, no HTTP call)
    apiData = matchTodayTixShow(show.title, apiLookup, show.todaytixId);

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
    todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];

    if (!todayTixInfo && !apiData) {
      todayTixInfo = await discoverTodayTixId(show.title);
      if (todayTixInfo) {
        todayTixIds.shows[show.id] = todayTixInfo;
      }
    }
  }

  // Fetch images: API data → page scrape → IBDB → Google Images → Playbill fallback
  const images = await fetchShowImages(show, todayTixInfo, apiData, verifyCtx);
  return { show, images, apiSourced: !!apiData };
}

// Process shows in batches with concurrency.
// API-sourced shows (instant) are separated from scrape-needing shows.
// checkpoint() is called every 25 shows to save progress to disk.
async function processShowsConcurrently(shows, apiLookup, todayTixIds, badImagesOnly, concurrency, verifyCtx, checkpoint, maxRuntimeMin = 0) {
  const startTime = Date.now();
  const results = { success: [], failed: [], skipped: [] };

  // Separate API-matched shows (instant, no rate limit needed) from scrape-needed shows
  const apiShows = [];
  const scrapeShows = [];
  for (const show of shows) {
    const apiData = matchTodayTixShow(show.title, apiLookup, show.todaytixId);
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
      if (!dryRunMode) applyImages(result.show, result.images);
      if (dryRunMode) dryRunResults.push({ showId: result.show.id, title: result.show.title, currentThumbnail: result.show.images?.thumbnail || null, newImages: result.images, source: result.apiSourced ? 'TodayTix API' : 'scrape' });
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
  let stoppedEarly = false;
  for (let i = 0; i < scrapeShows.length; i += scrapeConcurrency) {
    // Check time budget before each batch
    if (maxRuntimeMin > 0) {
      const elapsedMin = (Date.now() - startTime) / 60000;
      if (elapsedMin >= maxRuntimeMin) {
        console.log(`\n  Max runtime reached (${Math.round(elapsedMin)}/${maxRuntimeMin} min). Stopping gracefully.`);
        console.log(`  Processed ${processed}/${scrapeShows.length} scrape shows. Remaining will be picked up next run.`);
        stoppedEarly = true;
        break;
      }
    }
    const batch = scrapeShows.slice(i, i + scrapeConcurrency);
    const batchResults = await Promise.allSettled(
      batch.map(show => processOneShow(show, apiLookup, todayTixIds, badImagesOnly, verifyCtx))
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled' && settled.value && settled.value.images) {
        if (!dryRunMode) applyImages(settled.value.show, settled.value.images);
        if (dryRunMode) dryRunResults.push({ showId: settled.value.show.id, title: settled.value.show.title, currentThumbnail: settled.value.show.images?.thumbnail || null, newImages: settled.value.images, source: settled.value.apiSourced ? 'TodayTix API' : 'scrape' });
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

    // Checkpoint every 25 shows to save progress (protects against timeout)
    if (!dryRunMode && checkpoint && processed % 25 < scrapeConcurrency && results.success.length > 0) {
      console.log(`\n   💾 CHECKPOINT at ${processed}/${scrapeShows.length} — saving progress...`);
      saveTodayTixIds(todayTixIds);
      if (ibdbImageCache) saveIbdbImageCache(ibdbImageCache);
      checkpoint();
    }

    // Rate limit between batches (not between individual shows within a batch)
    if (i + scrapeConcurrency < scrapeShows.length) {
      await sleep(2000);
    }
  }

  // Final save of caches (skip in dry-run mode)
  if (!dryRunMode) {
    saveTodayTixIds(todayTixIds);
    if (ibdbImageCache) saveIbdbImageCache(ibdbImageCache);
  }

  return results;
}

// Apply fetched images to a show object, preserving existing local images
// when the new fetch doesn't provide a replacement.
function applyImages(show, images) {
  const existingThumb = show.images?.thumbnail;
  const hasLocalThumb = existingThumb && existingThumb.startsWith('/images/');
  const newThumbIsNative = isNativeSquareUrl(images.thumbnail);

  if (hasLocalThumb && !newThumbIsNative) {
    console.log(`   ⚠ Keeping existing local thumbnail for ${show.id} (new source is poster crop)`);
    images.thumbnail = existingThumb;
  }

  // Preserve existing local images when the new fetch returns null.
  // This prevents re-runs from wiping previously-downloaded hero/poster files.
  for (const format of ['hero', 'poster', 'thumbnail']) {
    const existing = show.images?.[format];
    if (!images[format] && existing && existing.startsWith('/images/')) {
      console.log(`   ⚠ Keeping existing local ${format} for ${show.id} (new source is null)`);
      images[format] = existing;
    }
  }

  // Strip internal underscore-prefixed fields before writing to shows.json
  // (_verifyBuffer, _remainingCandidates are already stripped in verifyAndCollect,
  //  but _hasNativeSquare and any future internal fields need this safety net)
  for (const key of Object.keys(images)) {
    if (key.startsWith('_')) delete images[key];
  }

  show.images = images;
}

// Generate a phone-friendly HTML comparison page for dry-run results
function generateComparisonPage(results) {
  const htmlPath = path.join(DRY_RUN_DIR, 'comparison.html');
  const showCards = results.map(r => {
    const currentSrc = r.currentThumbnail
      ? (r.currentThumbnail.startsWith('http') ? r.currentThumbnail : `../../public${r.currentThumbnail}`)
      : '';
    const newSrc = `${r.showId}/thumbnail.jpg`;
    return `
    <div class="card">
      <h3>${r.title} <span class="show-id">(${r.showId})</span></h3>
      <div class="images">
        <div class="img-box">
          <div class="label">Current</div>
          ${currentSrc ? `<img src="${currentSrc}" onerror="this.src='';this.alt='(missing)'" />` : '<div class="placeholder">No image</div>'}
        </div>
        <div class="img-box">
          <div class="label">New Candidate</div>
          <img src="${newSrc}" onerror="this.src='';this.alt='(failed to load)'" />
        </div>
      </div>
      <div class="meta">Source: ${r.source || 'unknown'}</div>
    </div>`;
  }).join('\n');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image Pipeline v7 - Dry Run Comparison</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  h1 { text-align: center; margin-bottom: 8px; color: #fff; }
  .subtitle { text-align: center; color: #888; margin-bottom: 24px; }
  .card { background: #16213e; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
  .card h3 { margin-bottom: 12px; font-size: 16px; }
  .show-id { color: #666; font-weight: normal; font-size: 12px; }
  .images { display: flex; gap: 12px; }
  .img-box { flex: 1; text-align: center; }
  .img-box img { width: 100%; max-width: 300px; border-radius: 8px; border: 2px solid #333; }
  .label { font-size: 12px; color: #aaa; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1px; }
  .placeholder { width: 100%; max-width: 300px; height: 200px; background: #0f3460; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #666; margin: 0 auto; }
  .meta { margin-top: 8px; font-size: 12px; color: #666; }
  @media (max-width: 600px) { .images { flex-direction: column; align-items: center; } }
</style>
</head><body>
<h1>Image Pipeline v7 - Dry Run</h1>
<p class="subtitle">${results.length} candidates - ${new Date().toISOString().split('T')[0]}</p>
${showCards}
</body></html>`;
  fs.writeFileSync(htmlPath, html);
  console.log(`Comparison page: ${htmlPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  // --help/-h checked BEFORE loadShows/any fetch/any write (cousin of
  // #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
  const onlyMissing = args.includes('--missing') || args.includes('--missing-only');
  const badImagesOnly = args.includes('--bad-images');
  const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '5', 10);
  // Verification is ON by default — use --no-verify to skip (faster but less safe)
  const verifyEnabled = !args.includes('--no-verify');
  const isDryRun = args.includes('--dry-run');
  const auditExisting = args.includes('--audit-existing');
  const refetchFlagged = args.includes('--flagged');
  const maxRuntimeMin = parseInt(args.find(a => a.startsWith('--max-runtime='))?.split('=')[1] || '0', 10);

  if (isDryRun) {
    dryRunMode = true;
    dryRunResults = [];
    fs.mkdirSync(DRY_RUN_DIR, { recursive: true });
    console.log(`DRY-RUN MODE: Images saved to ${DRY_RUN_DIR}, shows.json NOT modified`);
  }

  if (!SCRAPINGBEE_API_KEY && !BRIGHTDATA_TOKEN && !auditExisting) {
    console.error('ERROR: Set SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN environment variable');
    process.exit(1);
  }
  if (!SCRAPINGBEE_API_KEY) {
    console.log('⚠ SCRAPINGBEE_API_KEY not set — using Bright Data only');
  }
  if (BRIGHTDATA_TOKEN) {
    console.log('Bright Data fallback: ENABLED');
  }

  // Credit preflight — caches the ScrapingBee balance ONCE so fetchPage()
  // skips a known-exhausted key from the first call instead of discovering
  // it via a 401 on every show (task #688: 135 SB 401s in one run before
  // this existed). A degraded provider isn't fatal — fetchPage() still has
  // Bright Data/Scrapingdog/Playwright — so this only logs, never aborts.
  if (!auditExisting && SCRAPINGBEE_API_KEY) {
    try {
      const sbOk = await checkScrapingBeeCredits();
      console.log(sbOk
        ? '  ScrapingBee credit preflight: OK'
        : '  ⚠ ScrapingBee credit preflight: LOW/exhausted — fetchPage() will skip SB for this run');
    } catch (e) {
      console.log(`  ⚠ ScrapingBee credit preflight check failed (${e.message}) — continuing`);
    }
  }

  // Initialize LLM verification gate (on by default)
  let verifyCtx = null;
  if (verifyEnabled) {
    const { createRateLimiter } = require('./lib/verify-image');
    verifyCtx = { rateLimiter: createRateLimiter(15), verified: 0, rejected: 0, uncertain: 0, lastResort: 0, productionPhotos: 0 };
    console.log('Image verification: ENABLED (Gemini 2.0 Flash) — use --no-verify to skip');
  } else {
    console.log('Image verification: DISABLED (--no-verify flag)');
  }

  console.log('='.repeat(60));
  console.log('AUTO-FETCH SHOW IMAGES');
  if (badImagesOnly) console.log('MODE: Re-sourcing shows with bad (identical Playbill) images');
  console.log('='.repeat(60));

  const showsData = loadShows();
  allShowsData = showsData;

  // ============================================================
  // AUDIT-EXISTING MODE: Scan current images through Gemini (REPORT-ONLY)
  // ============================================================
  if (auditExisting) {
    console.log('\n' + '='.repeat(60));
    console.log('AUDIT EXISTING IMAGES (REPORT-ONLY)');
    console.log('='.repeat(60));

    const { verifyImage, createRateLimiter } = require('./lib/verify-image');
    const rateLimiter = createRateLimiter(15);
    const flagged = [];
    const passed = [];
    const errors = [];
    let scanned = 0;

    const showsToAudit = showFilter
      ? showsData.shows.filter(s => s.id === showFilter || s.slug === showFilter)
      : showsData.shows.filter(s => s.images?.thumbnail);

    console.log(`Scanning ${showsToAudit.length} shows with thumbnails...\n`);

    for (const show of showsToAudit) {
      const thumb = show.images?.thumbnail;
      if (!thumb) continue;
      scanned++;
      let imageBuffer;
      try {
        if (thumb.startsWith('/images/')) {
          const localPath = path.join(__dirname, '..', 'public', thumb);
          if (!fs.existsSync(localPath)) {
            errors.push({ showId: show.id, error: `File not found: ${localPath}` });
            continue;
          }
          imageBuffer = fs.readFileSync(localPath);
        } else if (thumb.startsWith('http')) {
          const resp = await fetch(thumb, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) { errors.push({ showId: show.id, error: `HTTP ${resp.status}` }); continue; }
          imageBuffer = Buffer.from(await resp.arrayBuffer());
        } else {
          errors.push({ showId: show.id, error: `Unknown format: ${thumb}` });
          continue;
        }
      } catch (err) { errors.push({ showId: show.id, error: err.message }); continue; }

      const year = show.openingDate ? show.openingDate.substring(0, 4) : null;
      const result = await verifyImage(imageBuffer, show.title, { year, rateLimiter });

      if (result.match === false && (result.confidence === 'high' || result.confidence === 'medium')) {
        console.log(`  ✗ FLAGGED: ${show.id} — ${result.description} [${result.issues.join(', ')}]`);
        flagged.push({ showId: show.id, title: show.title, thumbnail: thumb, verifyResult: result });
      } else {
        passed.push(show.id);
        if (scanned % 50 === 0) console.log(`  ... ${scanned}/${showsToAudit.length} scanned, ${flagged.length} flagged`);
      }
    }

    const report = { timestamp: new Date().toISOString(), pipelineVersion: 'v7', totalScanned: scanned, flagged, passedCount: passed.length, errors };
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const reportPath = path.join(AUDIT_DIR, 'existing-image-audit.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

    console.log('\n' + '='.repeat(60));
    console.log('AUDIT RESULTS');
    console.log('='.repeat(60));
    console.log(`Scanned: ${scanned}\nPassed: ${passed.length}\nFlagged: ${flagged.length}\nErrors: ${errors.length}`);
    console.log(`\nReport saved to: ${reportPath}`);
    if (flagged.length > 0) {
      console.log('\nFlagged shows:');
      for (const f of flagged) console.log(`  ${f.showId}: ${f.verifyResult.description} [${f.verifyResult.issues.join(', ')}]`);
    }
    return;
  }

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
  if (!onlyMissing && !badImagesOnly && !showFilter && !refetchFlagged) {
    shows = shows.filter(s => s.status === 'open' || s.status === 'previews');
  }

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    console.log(`Filtering to show: ${showFilter}`);
  }

  // FILL-HEROES MODE: Find shows with poster/thumbnail but no hero, fill from Theatr/TodayTix
  const fillHeroes = args.includes('--fill-heroes');
  if (fillHeroes) {
    // Include all statuses — hero gaps exist across all eras
    shows = showsData.shows;
    shows = shows.filter(s => {
      if (!s.images) return false;
      const hasThumbOrPoster = s.images.thumbnail || s.images.poster;
      const hasHero = s.images.hero;
      return hasThumbOrPoster && !hasHero;
    });
    console.log(`Fill-heroes mode: ${shows.length} shows have poster/thumbnail but no hero`);

    // Quick pass: try Theatr and TodayTix API only (both are instant API lookups)
    let filled = 0;

    // Pre-load Theatr cache
    await loadTheatrShows();
    console.log('');

    for (const show of shows) {
      // Try Theatr first (has bannerImageUrl)
      const theatrImages = await fetchFromTheatr(show);
      if (theatrImages?.hero) {
        if (!show.images) show.images = {};
        show.images.hero = theatrImages.hero;
        filled++;
        continue;
      }

      // Try TodayTix API match
      const apiData = matchTodayTixShow(show.title, apiLookup, show.todaytixId);
      if (apiData) {
        const hero = apiData.hero || apiData.headerImage || null;
        if (hero && !/coming.?soon/i.test(hero) && !/NORAM/i.test(hero)) {
          if (!show.images) show.images = {};
          show.images.hero = hero.includes('?') ? hero : hero + '?fm=webp&q=90';
          filled++;
        }
      }
    }

    console.log(`\nFilled ${filled} hero images out of ${shows.length} candidates`);
    saveShows(showsData);
    console.log('💾 shows.json saved');

    // Archive the new hero images
    console.log('\nRun archive-show-images.js to download hero images locally.\n');
    process.exit(0);
  }

  if (onlyMissing) {
    // Exclude closed shows by default — there are 2000+ and most will never
    // have images online. Without this, --missing takes 3+ hours instead of ~25 min.
    // Use --include-closed for explicit historical backfill runs.
    const includeClosed = args.includes('--include-closed');
    if (!includeClosed) {
      const before = shows.length;
      shows = shows.filter(s => s.status !== 'closed');
      console.log(`Excluding ${before - shows.length} closed shows (use --include-closed to override)`);
    }
    shows = shows.filter(s => {
      // Missing in JSON
      if (!s.images?.poster || !s.images?.thumbnail) return true;
      // JSON says images exist but local files are missing on disk
      const poster = s.images.poster;
      const thumb = s.images.thumbnail;
      if (poster && poster.startsWith('/images/')) {
        const posterPath = path.join(__dirname, '..', 'public', poster);
        if (!fs.existsSync(posterPath) || isPlaceholderFile(posterPath)) return true;
      }
      if (thumb && thumb.startsWith('/images/')) {
        const thumbPath = path.join(__dirname, '..', 'public', thumb);
        if (!fs.existsSync(thumbPath) || isPlaceholderFile(thumbPath)) return true;
      }
      return false;
    });
    console.log(`Processing only shows with missing images: ${shows.length}`);
  }

  if (badImagesOnly) {
    const badShows = shows.filter(s => hasBadImages(s.id));
    console.log(`\nDetected ${badShows.length} shows with bad (identical) images:`);
    badShows.forEach(s => console.log(`  - ${s.id}`));
    shows = badShows;
  }

  if (refetchFlagged) {
    const auditPath = path.join(AUDIT_DIR, 'existing-image-audit.json');
    if (!fs.existsSync(auditPath)) {
      console.error('ERROR: No audit report found. Run --audit-existing first.');
      process.exit(1);
    }
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    const flaggedIds = new Set(audit.flagged.map(f => f.showId));
    shows = shows.filter(s => flaggedIds.has(s.id));
    console.log(`\nRe-fetching ${shows.length} flagged shows from audit report:`);
    shows.forEach(s => console.log(`  - ${s.id}`));
    // Auto-enable dry-run for safety
    if (!dryRunMode) {
      dryRunMode = true;
      dryRunResults = [];
      fs.mkdirSync(DRY_RUN_DIR, { recursive: true });
      console.log(`\nAuto-enabled DRY-RUN mode for safety (use --dry-run explicitly to suppress this message)`);
    }
  }

  console.log(`\nProcessing ${shows.length} shows...\n`);

  // Checkpoint callback — saves shows.json to disk so progress survives timeouts
  const saveShowsData = () => {
    // Strip underscore-prefixed internal fields from ALL show images before saving
    // (cleans up historical _hasNativeSquare pollution + any future leaks)
    for (const s of showsData.shows) {
      if (s.images) {
        for (const key of Object.keys(s.images)) {
          if (key.startsWith('_')) delete s.images[key];
        }
      }
    }
    showsData._meta = showsData._meta || {};
    showsData._meta.lastUpdated = new Date().toISOString();
    saveShows(showsData);
    console.log(`   💾 shows.json saved (${showsData.shows.length} shows)`);
  };

  // Use concurrent processing for large batches, sequential for small
  const results = await processShowsConcurrently(shows, apiLookup, todayTixIds, badImagesOnly, concurrency, verifyCtx, saveShowsData, maxRuntimeMin);

  // Post-fetch duplicate image audit: detect shows sharing the same image.
  // NEVER null images — a wrong image is better than no image on the site.
  // Log suspected duplicates to an audit file for human review.
  if (!dryRunMode && results.success.length > 0) {
    const crypto = require('crypto');
    const hashMap = new Map(); // hash → { id, title, status }
    const suspects = [];

    for (const s of showsData.shows) {
      const thumb = s.images?.thumbnail;
      if (!thumb || !thumb.startsWith('/images/')) continue;
      const fullPath = path.join(__dirname, '..', 'public', thumb);
      if (!fs.existsSync(fullPath)) continue;
      const hash = crypto.createHash('md5').update(fs.readFileSync(fullPath)).digest('hex');
      if (hashMap.has(hash)) {
        const first = hashMap.get(hash);
        // Same title = revival/transfer — expected, skip
        const baseTitle = (s.title || s.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const firstTitle = (first.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (baseTitle === firstTitle) continue;
        suspects.push({ show1: first.id, show1Status: first.status, show2: s.id, show2Status: s.status });
        console.log(`   ⚠ SUSPECT DUPLICATE: ${s.id} shares image with ${first.id} — keeping both, logged for review`);
      } else {
        hashMap.set(hash, { id: s.id, title: s.title || s.displayName || '', status: s.status });
      }
    }
    if (suspects.length > 0) {
      const auditPath = path.join(__dirname, '..', 'data', 'audit', 'suspect-duplicate-images.json');
      const auditDir = path.dirname(auditPath);
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      fs.writeFileSync(auditPath, JSON.stringify({ updatedAt: new Date().toISOString(), suspects }, null, 2));
      console.log(`   🔍 ${suspects.length} suspect duplicate images logged to data/audit/suspect-duplicate-images.json`);
    }
  }

  // Thumbnail fallback: if thumbnail file is missing but poster exists, copy poster → thumbnail
  if (!dryRunMode) {
    let fallbackCount = 0;
    for (const s of showsData.shows) {
      const thumb = s.images?.thumbnail;
      const poster = s.images?.poster;
      if (!poster || !poster.startsWith('/images/')) continue;
      const posterPath = path.join(__dirname, '..', 'public', poster);
      if (!fs.existsSync(posterPath)) continue;
      // Case 1: no thumbnail at all
      // Case 2: thumbnail path set but file missing on disk
      const thumbPath = thumb && thumb.startsWith('/images/') ? path.join(__dirname, '..', 'public', thumb) : null;
      const thumbMissing = !thumb || (thumbPath && !fs.existsSync(thumbPath));
      if (thumbMissing) {
        const targetThumb = poster.replace(/poster\.(jpg|png|webp)/, 'thumbnail.$1');
        const targetPath = path.join(__dirname, '..', 'public', targetThumb);
        if (!fs.existsSync(targetPath)) {
          fs.copyFileSync(posterPath, targetPath);
        }
        s.images.thumbnail = targetThumb;
        fallbackCount++;
        console.log(`   📎 Thumbnail fallback: copied poster → thumbnail for ${s.id}`);
      }
    }
    if (fallbackCount > 0) {
      console.log(`   📎 Created ${fallbackCount} thumbnail fallbacks from posters`);
    }
  }

  // Final save (skip in dry-run mode)
  if (results.success.length > 0 && !dryRunMode) {
    saveShowsData();
  }

  // Dry-run report + HTML comparison page
  if (dryRunMode && dryRunResults.length > 0) {
    const report = { timestamp: new Date().toISOString(), pipelineVersion: 'v7', totalCandidates: dryRunResults.length, candidates: dryRunResults };
    fs.mkdirSync(DRY_RUN_DIR, { recursive: true });
    const reportPath = path.join(DRY_RUN_DIR, 'dry-run-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nDry-run report: ${reportPath}`);
    generateComparisonPage(dryRunResults);
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
    console.log(`  Production photos deferred: ${verifyCtx.productionPhotos || 0}`);
    console.log(`  Uncertain (accepted anyway): ${verifyCtx.uncertain}`);
    if (verifyCtx.venueOverrides > 0) {
      console.log(`  Venue overrides (pre-Broadway): ${verifyCtx.venueOverrides}`);
    }
    if (verifyCtx.lastResort > 0) {
      console.log(`  Last resort used: ${verifyCtx.lastResort}`);
    }
    if (verifyCtx.imageTypes) {
      console.log(`\n📊 Image Type Distribution:`);
      const types = verifyCtx.imageTypes;
      console.log(`  Promotional art: ${types.promotional_art || 0}`);
      console.log(`  Production stills: ${types.production_still || 0}`);
      console.log(`  Headshot/cast: ${types.headshot_cast || 0}`);
      console.log(`  Other: ${types.other || 0}`);
    }
  }

  // GitHub Actions output
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `images_fetched=${results.success.length}\n`);
    fs.appendFileSync(outputFile, `images_failed=${results.failed.length}\n`);
    if (verifyCtx) {
      fs.appendFileSync(outputFile, `images_rejected=${verifyCtx.rejected}\n`);
      if (verifyCtx.imageTypes) {
        fs.appendFileSync(outputFile, `promotional_art=${verifyCtx.imageTypes.promotional_art || 0}\n`);
        fs.appendFileSync(outputFile, `production_stills=${verifyCtx.imageTypes.production_still || 0}\n`);
      }
    }
  }

  // Success-rate gate — a run of 10+ shows where more than half fail (e.g. a
  // ScrapingBee credit exhaustion nobody caught for 10 days, 6 runs, 5-15%
  // success every time) must exit non-zero so CI's `if: failure()` step fires
  // notify-failure. Below 10 shows the sample is too small to be meaningful
  // (a single stubborn show failing shouldn't page anyone).
  const totalAttempted = results.success.length + results.failed.length;
  if (totalAttempted >= 10) {
    const failureRate = results.failed.length / totalAttempted;
    if (failureRate > 0.5) {
      console.error(`\n❌ FAILURE RATE ${Math.round(failureRate * 100)}% (${results.failed.length}/${totalAttempted}) exceeds the 50% threshold — exiting non-zero.`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
