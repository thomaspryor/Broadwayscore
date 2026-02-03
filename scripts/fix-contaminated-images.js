#!/usr/bin/env node
/**
 * fix-contaminated-images.js
 *
 * Identifies and cleans image cross-contamination where different shows
 * share identical image files due to fuzzy title matching bugs.
 *
 * Usage:
 *   node scripts/fix-contaminated-images.js --dry-run    # Report only
 *   node scripts/fix-contaminated-images.js              # Clean contaminated images
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const IMAGE_SOURCES_PATH = path.join(__dirname, '..', 'data', 'image-sources.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');

const dryRun = process.argv.includes('--dry-run');

function md5File(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch {
    return null;
  }
}

// Extract base title without year suffix for revival detection
function baseTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+\d{4}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Check if two shows are legitimate same-production revivals
function areSameShow(showA, showB) {
  const baseA = baseTitle(showA.title);
  const baseB = baseTitle(showB.title);
  return baseA === baseB;
}

function main() {
  console.log(dryRun ? '=== DRY RUN ===' : '=== CLEANING CONTAMINATED IMAGES ===');
  console.log();

  // Load data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  const shows = showsData.shows;
  let imageSources = {};
  try {
    imageSources = JSON.parse(fs.readFileSync(IMAGE_SOURCES_PATH, 'utf-8'));
  } catch { /* ok if missing */ }

  // Build show lookup by ID
  const showById = {};
  for (const show of shows) {
    showById[show.id] = show;
  }

  // Hash all image files
  console.log('Hashing image files...');
  const hashToShows = {}; // hash -> [{ showId, filePath, format }]
  let totalFiles = 0;

  if (!fs.existsSync(IMAGES_DIR)) {
    console.log('No images directory found.');
    return;
  }

  const showDirs = fs.readdirSync(IMAGES_DIR);
  for (const dir of showDirs) {
    const dirPath = path.join(IMAGES_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      if (!fs.statSync(filePath).isFile()) continue;

      const hash = md5File(filePath);
      if (!hash) continue;
      totalFiles++;

      if (!hashToShows[hash]) hashToShows[hash] = [];
      hashToShows[hash].push({
        showId: dir,
        filePath,
        fileName: file,
        format: file.replace(/\.\w+$/, ''), // thumbnail, hero, poster
      });
    }
  }

  console.log(`Hashed ${totalFiles} files across ${showDirs.length} directories.\n`);

  // Find contamination groups (same hash, different shows)
  const contaminatedGroups = [];
  const placeholderGroups = [];

  for (const [hash, entries] of Object.entries(hashToShows)) {
    const uniqueShows = [...new Set(entries.map(e => e.showId))];
    if (uniqueShows.length < 2) continue;

    // Check if all shows in group are revivals of same show
    const showObjects = uniqueShows.map(id => showById[id]).filter(Boolean);
    if (showObjects.length >= 2) {
      const allSameShow = showObjects.every(s => areSameShow(s, showObjects[0]));
      if (allSameShow) continue; // Legitimate revival pair
    }

    if (uniqueShows.length >= 8) {
      placeholderGroups.push({ hash, shows: uniqueShows, entries });
    } else {
      contaminatedGroups.push({ hash, shows: uniqueShows, entries });
    }
  }

  console.log(`Found ${contaminatedGroups.length} contaminated groups (${contaminatedGroups.reduce((s, g) => s + g.shows.length, 0)} shows)`);
  console.log(`Found ${placeholderGroups.length} placeholder groups (${placeholderGroups.reduce((s, g) => s + g.shows.length, 0)} shows)`);
  console.log();

  // For each contaminated group, determine the "owner" (show most likely to have the correct image)
  // Heuristic: the show with the most reviews, or the most recent/prominent show
  const reviewsData = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'reviews.json'), 'utf-8'));
    } catch { return { shows: {} }; }
  })();

  function getReviewCount(showId) {
    // Check review-texts directory
    const dir = path.join(__dirname, '..', 'data', 'review-texts', showId);
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  function pickOwner(showIds) {
    // Score each show: more reviews = more likely to be the "real" owner of the image
    let best = showIds[0];
    let bestScore = -1;

    for (const id of showIds) {
      const show = showById[id];
      const reviewCount = getReviewCount(id);
      // Bonus for open/recent shows (TodayTix likely matched them correctly)
      const statusBonus = show?.status === 'open' ? 100 : show?.status === 'previews' ? 50 : 0;
      const yearStr = show?.openingDate?.substring(0, 4) || '2000';
      const recencyBonus = Math.max(0, parseInt(yearStr) - 2015); // Recent shows get bonus
      const score = reviewCount + statusBonus + recencyBonus;

      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  const showsToClean = new Set();
  const allGroups = [...contaminatedGroups, ...placeholderGroups];

  for (const group of contaminatedGroups) {
    const owner = pickOwner(group.shows);
    const nonOwners = group.shows.filter(id => id !== owner);

    if (dryRun) {
      const ownerShow = showById[owner];
      console.log(`Contaminated (hash ${group.hash.substring(0, 8)}...):`);
      console.log(`  Owner: ${owner} (${ownerShow?.title || 'unknown'})`);
      for (const id of nonOwners) {
        const show = showById[id];
        console.log(`  Clean: ${id} (${show?.title || 'unknown'})`);
      }
      console.log();
    }

    for (const id of nonOwners) {
      showsToClean.add(id);
    }
  }

  // For placeholder groups, clean ALL shows (nobody has a real image)
  for (const group of placeholderGroups) {
    if (dryRun) {
      console.log(`Placeholder (hash ${group.hash.substring(0, 8)}...) — ${group.shows.length} shows, cleaning ALL:`);
      for (const id of group.shows) {
        const show = showById[id];
        console.log(`  Clean: ${id} (${show?.title || 'unknown'})`);
      }
      console.log();
    }

    for (const id of group.shows) {
      showsToClean.add(id);
    }
  }

  console.log(`\nTotal shows to clean: ${showsToClean.size}`);

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to clean.');
    return;
  }

  // Clean contaminated images
  let deletedFiles = 0;
  let cleanedShows = 0;

  for (const showId of showsToClean) {
    const showDir = path.join(IMAGES_DIR, showId);
    if (fs.existsSync(showDir)) {
      const files = fs.readdirSync(showDir);
      for (const file of files) {
        fs.unlinkSync(path.join(showDir, file));
        deletedFiles++;
      }
      // Remove empty directory
      try { fs.rmdirSync(showDir); } catch { /* ok */ }
    }

    // Clear image-sources.json entry
    if (imageSources[showId]) {
      delete imageSources[showId];
    }

    // Clear shows.json image paths
    const showIdx = shows.findIndex(s => s.id === showId);
    if (showIdx !== -1) {
      shows[showIdx].images = {
        hero: null,
        thumbnail: null,
        poster: null,
      };
    }

    cleanedShows++;
  }

  // Write updated files
  fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
  fs.writeFileSync(IMAGE_SOURCES_PATH, JSON.stringify(imageSources, null, 2) + '\n');

  console.log(`\nCleaned ${cleanedShows} shows, deleted ${deletedFiles} files.`);

  // Output list of shows needing re-fetch
  const cleanedList = [...showsToClean].sort();
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'audit', 'images-to-refetch.txt'),
    cleanedList.join('\n') + '\n'
  );
  console.log(`\nWrote ${cleanedList.length} show IDs to data/audit/images-to-refetch.txt`);
  console.log('Run: node scripts/fetch-show-images-auto.js --show=SLUG for each');
}

main();
