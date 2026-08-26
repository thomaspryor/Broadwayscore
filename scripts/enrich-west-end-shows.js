#!/usr/bin/env node
/**
 * Enrich West End shows with images and venue data from TodayTix London API.
 * One-time backfill script. Run locally.
 *
 * Usage: node scripts/enrich-west-end-shows.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { isLondonMarket, sanitizeVenueForWrite } = require('./lib/venue-classification');
const { isPlaceholderVenue } = require('./audit-placeholder-venues');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-west-end-shows.js — Enrich West End shows with images and venue data from TodayTix London API.

Usage:
  node scripts/enrich-west-end-shows.js [options]
  node scripts/enrich-west-end-shows.js --help, -h    print this usage and exit
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const DRY_RUN = process.argv.includes('--dry-run');

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

async function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
    https.get(finalUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${finalUrl}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchAllTodayTixShows() {
  const allShows = [];
  let offset = 0;
  while (true) {
    const url = `https://api.todaytix.com/api/v2/shows?location=2&limit=100&offset=${offset}`;
    console.log(`Fetching TodayTix offset=${offset}...`);
    const data = await fetchJson(url);
    if (!data.data || data.data.length === 0) break;

    // Filter to West End shows
    const westEnd = data.data.filter(s =>
      s.subcategories && s.subcategories.some(sc => sc.name === 'West End')
    );
    allShows.push(...westEnd);
    offset += 100;
    if (data.data.length < 100) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return allShows;
}

/**
 * Decide whether/what to update a show's venue to from TodayTix data.
 * Returns { venue: <sanitized venue to write> | null, reason: <skip reason
 * when a TodayTix venue was refused> | null }. Only updates when the current
 * venue is missing/TBA/Unknown; the TodayTix venue is refused when it fails
 * sanitizeVenueForWrite (card #994 write-time guard — a placeholder or
 * neighbourhood-blob string must not be written, card #1922 cousin of #1921).
 */
function decideVenueUpdate(currentVenue, rawTtVenue) {
  if (!rawTtVenue || typeof rawTtVenue !== 'string' || !rawTtVenue.trim()) {
    return { venue: null, reason: null };
  }
  // Canonical placeholder check (audit-placeholder-venues.js — same predicate
  // sanitizeVenueForWrite reuses) rather than a hardcoded TBA/Unknown list, so
  // a current venue of "TBD"/"N/A"/a neighbourhood blob is also eligible for
  // replacement, not just the two literal strings (ship-check finding).
  const needsUpdate = isPlaceholderVenue(currentVenue).placeholder;
  if (!needsUpdate) return { venue: null, reason: null };
  const sanitized = sanitizeVenueForWrite(rawTtVenue.trim());
  if (!sanitized) {
    return { venue: null, reason: `venue "${rawTtVenue.trim()}" failed sanitizeVenueForWrite (placeholder/neighbourhood blob)` };
  }
  return { venue: sanitized, reason: null };
}

function matchShow(ttShow, weShows) {
  const ttSlug = slugify(ttShow.displayName);
  // Try exact slug match first
  const exactMatch = weShows.find(s => {
    const showSlug = slugify(s.title);
    return showSlug === ttSlug;
  });
  if (exactMatch) return exactMatch;

  // Try contains match
  const containsMatch = weShows.find(s => {
    const showSlug = slugify(s.title);
    return ttSlug.includes(showSlug) || showSlug.includes(ttSlug);
  });
  return containsMatch || null;
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  // Load shows
  const showsData = loadShows();
  const shows = showsData.shows || showsData;
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Found ${weShows.length} West End shows in shows.json`);

  // Fetch TodayTix data
  const ttShows = await fetchAllTodayTixShows();
  console.log(`Found ${ttShows.length} West End shows on TodayTix\n`);

  let matched = 0, imagesDownloaded = 0, venuesUpdated = 0;

  for (const tt of ttShows) {
    const show = matchShow(tt, weShows);
    if (!show) {
      console.log(`  SKIP: No match for "${tt.displayName}"`);
      continue;
    }

    matched++;
    const showId = show.id;
    console.log(`  MATCH: "${tt.displayName}" → ${showId}`);

    // Update venue if missing or TBA
    const venueDecision = decideVenueUpdate(show.venue, tt.venue);
    if (venueDecision.venue) {
      console.log(`    Venue: "${show.venue}" → "${venueDecision.venue}"`);
      if (!DRY_RUN) show.venue = venueDecision.venue;
      venuesUpdated++;
    } else if (venueDecision.reason) {
      console.log(`    Venue SKIPPED: ${venueDecision.reason}`);
    }

    // Download images
    const imageDir = path.join(IMAGES_DIR, showId);
    if (!DRY_RUN && !fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
    }

    // Poster image (480x720 portrait — good for show detail pages)
    const posterUrl = tt.images?.productMedia?.posterImage?.file?.url
      || tt.images?.posterImage?.file?.url
      || tt.posterImageUrl;
    if (posterUrl) {
      const posterPath = path.join(imageDir, 'poster.jpg');
      const posterRelPath = `/images/shows/${showId}/poster.jpg`;
      if (!show.images) show.images = {};
      if (!show.images.poster || show.images.poster.includes('placeholder')) {
        console.log(`    Poster: downloading...`);
        if (!DRY_RUN) {
          try {
            await downloadImage(posterUrl, posterPath);
            show.images.poster = posterRelPath;
            imagesDownloaded++;
          } catch (e) {
            console.log(`    Poster FAILED: ${e.message}`);
          }
        }
      }
    }

    // Hero image (landscape — for OG tags and headers)
    const heroUrl = tt.images?.productMedia?.appHeroImage?.file?.url
      || tt.images?.productMedia?.headerImage?.file?.url
      || tt.heroImageUrl;
    if (heroUrl) {
      const heroPath = path.join(imageDir, 'hero.jpg');
      const heroRelPath = `/images/shows/${showId}/hero.jpg`;
      if (!show.images) show.images = {};
      if (!show.images.hero || show.images.hero.includes('placeholder')) {
        console.log(`    Hero: downloading...`);
        if (!DRY_RUN) {
          try {
            await downloadImage(heroUrl, heroPath);
            show.images.hero = heroRelPath;
            imagesDownloaded++;
          } catch (e) {
            console.log(`    Hero FAILED: ${e.message}`);
          }
        }
      }
    }

    // Thumbnail (square — for browse list cards)
    const thumbUrl = tt.images?.productMedia?.posterImageSquare?.file?.url
      || tt.images?.posterImageSquare?.file?.url;
    if (thumbUrl) {
      const thumbPath = path.join(imageDir, 'thumbnail.jpg');
      const thumbRelPath = `/images/shows/${showId}/thumbnail.jpg`;
      if (!show.images) show.images = {};
      if (!show.images.thumbnail || show.images.thumbnail.includes('placeholder')) {
        console.log(`    Thumbnail: downloading...`);
        if (!DRY_RUN) {
          try {
            await downloadImage(thumbUrl, thumbPath);
            show.images.thumbnail = thumbRelPath;
            imagesDownloaded++;
          } catch (e) {
            console.log(`    Thumbnail FAILED: ${e.message}`);
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Matched: ${matched}/${weShows.length}`);
  console.log(`Venues updated: ${venuesUpdated}`);
  console.log(`Images downloaded: ${imagesDownloaded}`);

  if (!DRY_RUN && (venuesUpdated > 0 || imagesDownloaded > 0)) {
    saveShows(showsData);
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { decideVenueUpdate };
