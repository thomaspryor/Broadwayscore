#!/usr/bin/env node
/**
 * fetch-opera-images.js
 *
 * Downloads production images for Met Opera shows from metopera.org season pages.
 * Images live at /globalassets/season/{YYYY-YY}/{slug}/{name}-1600x1200.jpg
 *
 * Usage:
 *   node scripts/fetch-opera-images.js [--dry-run] [--season=2025-26] [--season=2026-27]
 *   node scripts/fetch-opera-images.js --show=aida-off-broadway-2027
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { fetchPage, cleanup } = require('./lib/scraper');
const { compressImage } = require('./lib/compress-image');
const showsWriteGuard = require('./lib/shows-write-guard');

let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }

const SHOWS_FILE = (() => {
  const candidates = [
    path.join(__dirname, '..', 'data', 'shows.json'),
    path.join('/Users/tompryor/broadway-scorecard-data', 'shows.json'),
  ];
  return candidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || candidates[0];
})();

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');

const dryRun = process.argv.includes('--dry-run');
const targetShowId = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];
const seasonArgs = process.argv.filter(a => a.startsWith('--season=')).map(a => a.split('=')[1]);
const SEASONS = seasonArgs.length > 0 ? seasonArgs : ['2025-26', '2026-27'];

// ─── HTTP download ────────────────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Season page scraping ─────────────────────────────────────────────────────

async function getSeasonImageUrls(seasonSlug) {
  const url = `https://www.metopera.org/season/${seasonSlug}-season/`;
  console.log(`\nFetching ${url}…`);
  const result = await fetchPage(url, { forceMethod: 'brightdata', renderJs: true });
  const rawHtml = result.html || result.text || result;
  const html = typeof rawHtml === 'string' ? rawHtml : JSON.stringify(rawHtml);

  // Extract all globalassets image paths
  const regex = /globalassets\/season\/[^\s"'\\]+\.(jpg|jpeg|png|webp)/gi;
  const urls = new Set();
  let m;
  while ((m = regex.exec(html)) !== null) urls.add(`https://www.metopera.org/${m[0]}`);

  console.log(`  Found ${urls.size} image URLs`);
  return [...urls];
}

// ─── URL path slug → show ID matching ────────────────────────────────────────

function slugifyTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// Known slug typos/aliases on metopera.org
const URL_SLUG_ALIASES = {
  'jenfa': 'jenufa',
};

// Extract folder slug from a metopera.org globalassets URL
// e.g. /globalassets/season/2026-27/aida/aida-1600x1200.jpg → "aida"
function extractUrlSlug(imageUrl) {
  const m = imageUrl.match(/\/season\/[\d-]+\/([^/]+)\//);
  if (!m) return null;
  const slug = m[1];
  return URL_SLUG_ALIASES[slug] || slug;
}

// Get opening year from show
function getOpeningYear(show) {
  if (show.openingDate) return new Date(show.openingDate).getFullYear();
  const m = show.id.match(/-(\d{4})$/);
  return m ? parseInt(m[1]) : null;
}

// For a given season slug (e.g. "2025-26"), return the two calendar years
function seasonYears(seasonSlug) {
  const first = parseInt(seasonSlug.split('-')[0]);
  return [first, first + 1];
}

// Match an image URL to an opera show. Only considers shows in the correct season.
function matchImageToShow(imageUrl, operaShows, years) {
  const urlSlug = extractUrlSlug(imageUrl);
  if (!urlSlug) return null;

  // Normalize the URL slug: double dashes → single, map known URL→title transformations
  // metopera uses "--" for "&" in URLs (kavalier--clay)
  const urlNorm = urlSlug.replace(/--+/g, '-and-').replace(/-+/g, '-');

  // Only consider shows in this season
  const seasonShows = operaShows.filter(s => {
    const yr = getOpeningYear(s);
    return yr && years.includes(yr);
  });

  return seasonShows.find(s => {
    const idSlug = s.id.replace(/-off-broadway-\d{4}$/, '');
    // Exact match
    if (idSlug === urlSlug) return true;
    if (idSlug === urlNorm) return true;
    // Also try our title slugify against the URL slug
    const showTitleSlug = slugifyTitle(s.title);
    if (showTitleSlug === urlSlug) return true;
    if (showTitleSlug === urlNorm) return true;
    return false;
  }) || null;
}

// ─── Shows I/O ────────────────────────────────────────────────────────────────

function loadShows() {
  return showsWriteGuard.loadShows();
}

function saveShows(data) {
  showsWriteGuard.saveShows(data);
}

// ─── Crop helpers ─────────────────────────────────────────────────────────────

// Met Opera source images are landscape (1600×1200). Poster (aspect-[2/3]) and
// thumbnail containers need portrait/square art or the subject renders as a sliver.

async function cropForPoster(buffer) {
  if (!sharp) return buffer;
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) return buffer;
  // Target 2:3 portrait (h/w = 1.5). Crop width from center, keep full height.
  const targetW = Math.floor(height / 1.5);
  if (targetW >= width) return buffer; // already portrait
  const left = Math.floor((width - targetW) / 2);
  return sharp(buffer).extract({ left, top: 0, width: targetW, height }).toBuffer();
}

async function cropForThumbnail(buffer) {
  if (!sharp) return buffer;
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) return buffer;
  // Square crop (1:1) from center.
  const size = Math.min(width, height);
  const left = Math.floor((width - size) / 2);
  const top = Math.floor((height - size) / 2);
  return sharp(buffer).extract({ left, top, width: size, height: size }).toBuffer();
}

// ─── Image saving ─────────────────────────────────────────────────────────────

async function fetchAndSaveImage(showId, imageUrl) {
  const showDir = path.join(IMAGES_DIR, showId);
  const existing = fs.existsSync(showDir) ? fs.readdirSync(showDir) : [];
  const needsPoster = !existing.includes('poster.webp');
  const needsHero = !existing.includes('hero.webp');
  const needsThumbnail = !existing.includes('thumbnail.webp');

  if (!needsPoster && !needsHero && !needsThumbnail) {
    console.log(`    already complete`);
    return false;
  }

  console.log(`    downloading ${imageUrl}…`);
  let buffer;
  try {
    buffer = await downloadBuffer(imageUrl);
  } catch (e) {
    console.warn(`    ✗ download failed: ${e.message}`);
    return false;
  }

  if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

  const saved = [];
  if (needsPoster) {
    fs.writeFileSync(path.join(showDir, 'poster.webp'), await compressImage(await cropForPoster(buffer), 'poster'));
    saved.push('poster');
  }
  if (needsHero) {
    fs.writeFileSync(path.join(showDir, 'hero.webp'), await compressImage(buffer, 'hero'));
    saved.push('hero');
  }
  if (needsThumbnail) {
    fs.writeFileSync(path.join(showDir, 'thumbnail.webp'), await compressImage(await cropForThumbnail(buffer), 'thumbnail'));
    saved.push('thumbnail');
  }

  console.log(`    ✓ saved: ${saved.join(', ')}`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async function main() {
  const data = loadShows();
  const operaShows = data.shows.filter(s => s.type === 'opera');
  const showsToProcess = targetShowId
    ? operaShows.filter(s => s.id === targetShowId)
    : operaShows;

  console.log(`Processing ${showsToProcess.length} opera show(s)`);

  // imageAssignments: showId → imageUrl (only assign each show once, first match wins)
  const imageAssignments = new Map();

  for (const seasonSlug of SEASONS) {
    let imageUrls;
    try {
      imageUrls = await getSeasonImageUrls(seasonSlug);
    } catch (e) {
      console.error(`  ✗ Failed to fetch ${seasonSlug}: ${e.message}`);
      continue;
    }

    const years = seasonYears(seasonSlug);

    for (const imgUrl of imageUrls) {
      const show = matchImageToShow(imgUrl, showsToProcess, years);
      if (show && !imageAssignments.has(show.id)) {
        imageAssignments.set(show.id, imgUrl);
      }
    }
  }

  console.log(`\nMatched ${imageAssignments.size} of ${showsToProcess.length} shows to images:`);
  for (const [id, url] of imageAssignments) {
    console.log(`  ${id} → ${url.split('/').slice(-1)[0]}`);
  }

  const unmatched = showsToProcess.filter(s => !imageAssignments.has(s.id));
  if (unmatched.length > 0) {
    console.log(`\nUnmatched (${unmatched.length}):`);
    unmatched.forEach(s => console.log(`  ${s.id}`));
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No files written.');
    return;
  }

  let savedCount = 0;
  let updatedInJson = 0;

  for (const [showId, imgUrl] of imageAssignments) {
    console.log(`\n${showId}`);
    const didSave = await fetchAndSaveImage(showId, imgUrl);
    if (didSave) {
      savedCount++;
      const show = data.shows.find(s => s.id === showId);
      if (show) {
        const hadImages = show.images && Object.keys(show.images).length > 0;
        if (!hadImages) {
          show.images = {
            hero: `/images/shows/${showId}/hero.webp`,
            thumbnail: `/images/shows/${showId}/thumbnail.webp`,
            poster: `/images/shows/${showId}/poster.webp`,
          };
          updatedInJson++;
        }
      }
    }
  }

  if (updatedInJson > 0) {
    saveShows(data);
    console.log(`\n✓ Saved images for ${savedCount} shows`);
    console.log(`✓ Updated images field for ${updatedInJson} shows in shows.json`);
  } else {
    console.log('\nNo new images to save.');
  }
})()
  .catch(e => {
    console.error(e.stack || e.message);
    process.exit(1);
  })
  .finally(() => cleanup?.());
