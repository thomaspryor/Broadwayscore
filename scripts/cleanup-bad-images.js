#!/usr/bin/env node

/**
 * Cleanup bad TodayTix mappings and wrong images.
 *
 * Reads data/audit/bad-todaytix-mappings.json (from audit-todaytix-mappings.js)
 * and removes:
 *   - Bad TodayTix mappings from todaytix-ids.json
 *   - Bad image-sources entries from image-sources.json
 *   - Wrong poster.webp and hero.webp files
 *   - Wrong thumbnail files IF they came from TodayTix (ctfassets.net)
 *   - Updates shows.json to null out removed image paths
 *
 * Skips PINNED shows.
 *
 * Usage:
 *   node scripts/cleanup-bad-images.js --dry-run          # Preview changes
 *   node scripts/cleanup-bad-images.js                    # Auto-clean only (<30%)
 *   node scripts/cleanup-bad-images.js --tier all         # Include borderline (30-60%)
 *   node scripts/cleanup-bad-images.js --tier manual-review  # Only borderline
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import showsWriteGuardPkg from './lib/shows-write-guard.js';
const { loadShows, saveShows } = showsWriteGuardPkg;
import { hasHelpFlag } from './lib/cli-help.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const USAGE = `cleanup-bad-images.js — Cleanup bad TodayTix mappings and wrong images.

Usage:
  node scripts/cleanup-bad-images.js [options]
  node scripts/cleanup-bad-images.js --help, -h    print this usage and exit
`;

function main() {
  const args = process.argv.slice(2);
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const dryRun = args.includes('--dry-run');
  const tierArg = args.find((_, i, arr) => arr[i - 1] === '--tier') || 'auto';

  // Load audit data
  const auditPath = path.join(ROOT, 'data/audit/bad-todaytix-mappings.json');
  if (!fs.existsSync(auditPath)) {
    console.error('Run audit-todaytix-mappings.js first to generate the audit data.');
    process.exit(1);
  }

  const allBad = JSON.parse(fs.readFileSync(auditPath, 'utf8'));

  // Filter by tier
  let entries;
  if (tierArg === 'all') {
    entries = allBad;
  } else if (tierArg === 'manual-review') {
    entries = allBad.filter(e => e.tier === 'manual-review');
  } else {
    entries = allBad.filter(e => e.tier === 'auto-clean');
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Processing ${entries.length} entries (tier: ${tierArg})\n`);

  // Load mutable data files
  const todaytixIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/todaytix-ids.json'), 'utf8'));
  const imageSources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/image-sources.json'), 'utf8'));
  const showsRaw = loadShows();
  const shows = showsRaw.shows || showsRaw;

  let mappingsRemoved = 0;
  let imageSourcesRemoved = 0;
  let postersDeleted = 0;
  let herosDeleted = 0;
  let thumbnailsDeleted = 0;
  let showsUpdated = 0;
  let pinnedSkipped = 0;

  for (const entry of entries) {
    const { showId, slug, isPinned, hasPoster, hasHero, thumbnailFromTodayTix } = entry;

    if (isPinned) {
      console.log(`  SKIP (pinned): ${showId}`);
      pinnedSkipped++;
      continue;
    }

    console.log(`  ${showId} → ${slug} (${Math.round(entry.matchRatio * 100)}%)`);

    // 1. Remove TodayTix mapping
    if (todaytixIds.shows && todaytixIds.shows[showId]) {
      if (!dryRun) delete todaytixIds.shows[showId];
      mappingsRemoved++;
      console.log(`    ✓ Removed todaytix-ids mapping`);
    }

    // 2. Remove image-sources entry (only TodayTix sources)
    if (imageSources[showId]) {
      const sources = imageSources[showId];
      let removedAny = false;

      for (const key of ['poster', 'thumbnail', 'hero']) {
        if (sources[key] && sources[key].includes('ctfassets.net')) {
          if (!dryRun) delete sources[key];
          removedAny = true;
        }
      }

      // If all sources removed, delete the entire entry
      if (!dryRun && Object.keys(sources).length === 0) {
        delete imageSources[showId];
      }

      if (removedAny) {
        imageSourcesRemoved++;
        console.log(`    ✓ Removed TodayTix image-sources`);
      }
    }

    // 3. Delete wrong image files
    const imageDir = path.join(ROOT, 'public/images/shows', showId);

    if (hasPoster) {
      const posterPath = path.join(imageDir, 'poster.webp');
      if (fs.existsSync(posterPath)) {
        if (!dryRun) fs.unlinkSync(posterPath);
        postersDeleted++;
        console.log(`    ✓ Deleted poster.webp`);
      }
    }

    if (hasHero) {
      const heroPath = path.join(imageDir, 'hero.webp');
      if (fs.existsSync(heroPath)) {
        if (!dryRun) fs.unlinkSync(heroPath);
        herosDeleted++;
        console.log(`    ✓ Deleted hero.webp`);
      }
    }

    // Only delete thumbnail if it came from TodayTix
    if (thumbnailFromTodayTix) {
      const thumbWebp = path.join(imageDir, 'thumbnail.webp');
      const thumbJpg = path.join(imageDir, 'thumbnail.jpg');
      if (fs.existsSync(thumbWebp)) {
        if (!dryRun) fs.unlinkSync(thumbWebp);
        thumbnailsDeleted++;
        console.log(`    ✓ Deleted thumbnail.webp (from TodayTix)`);
      }
      if (fs.existsSync(thumbJpg)) {
        // Check if .jpg is also from TodayTix
        const source = (imageSources[showId] || {}).thumbnail || '';
        if (source.includes('ctfassets.net')) {
          if (!dryRun) fs.unlinkSync(thumbJpg);
          thumbnailsDeleted++;
          console.log(`    ✓ Deleted thumbnail.jpg (from TodayTix)`);
        }
      }
    }

    // 4. Update shows.json images
    const show = shows.find(s => s.id === showId);
    if (show && show.images) {
      let updated = false;

      if (hasPoster && show.images.poster) {
        if (!dryRun) show.images.poster = null;
        updated = true;
      }
      if (hasHero && show.images.hero) {
        if (!dryRun) show.images.hero = null;
        updated = true;
      }
      if (thumbnailFromTodayTix && show.images.thumbnail) {
        // Check if the thumbnail path is a .webp (TodayTix) vs .jpg (other source)
        if (show.images.thumbnail.endsWith('.webp') || show.images.thumbnail.endsWith('.jpg')) {
          const thumbFile = path.join(ROOT, 'public', show.images.thumbnail);
          // Only null it if the file was deleted or doesn't exist
          if (!dryRun) {
            const stillExists = fs.existsSync(thumbFile);
            if (!stillExists) {
              show.images.thumbnail = null;
            }
          } else {
            // In dry-run, mark it if thumbnail is from TodayTix
            updated = true;
          }
        }
      }

      if (updated) {
        showsUpdated++;
      }
    }
  }

  // Save modified files
  if (!dryRun) {
    todaytixIds.lastUpdated = new Date().toISOString();
    fs.writeFileSync(path.join(ROOT, 'data/todaytix-ids.json'), JSON.stringify(todaytixIds, null, 2) + '\n');
    fs.writeFileSync(path.join(ROOT, 'data/image-sources.json'), JSON.stringify(imageSources, null, 2) + '\n');
    saveShows(showsRaw);
  }

  // Summary
  console.log(`\n=== Summary ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`Entries processed: ${entries.length}`);
  console.log(`PINNED skipped: ${pinnedSkipped}`);
  console.log(`TodayTix mappings removed: ${mappingsRemoved}`);
  console.log(`Image-sources cleaned: ${imageSourcesRemoved}`);
  console.log(`Posters deleted: ${postersDeleted}`);
  console.log(`Heroes deleted: ${herosDeleted}`);
  console.log(`Thumbnails deleted: ${thumbnailsDeleted}`);
  console.log(`Shows.json entries updated: ${showsUpdated}`);
}

main();
