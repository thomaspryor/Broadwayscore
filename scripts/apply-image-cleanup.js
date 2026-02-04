#!/usr/bin/env node
/**
 * apply-image-cleanup.js
 *
 * Applies curated image cleanup based on the LLM audit results
 * plus manual verification of false positives.
 *
 * This script:
 * 1. Archives bad images to data/audit/deleted-images/
 * 2. Deletes bad thumbnail files
 * 3. Updates shows.json to null out deleted thumbnails
 * 4. Removes orphaned .jpg files where .webp exists
 *
 * Usage:
 *   node scripts/apply-image-cleanup.js --dry-run   # Preview changes
 *   node scripts/apply-image-cleanup.js --apply      # Apply changes
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'audit', 'image-verification.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const DELETED_DIR = path.join(__dirname, '..', 'data', 'audit', 'deleted-images');

// ============================================================
// FALSE POSITIVES — Manually verified as CORRECT images
// These were flagged by the LLM but are actually the right
// promotional art (title was cropped off in the square crop)
// ============================================================
const FALSE_POSITIVES = new Set([
  'giant-2026',           // John Lithgow is Roald Dahl — GIANT (correct, title visible)
  'appropriate-2023',     // Sarah Paulson with cracked frame (correct TodayTix art)
  'sunset-boulevard-2024', // Nicole Scherzinger (correct, Tony Award art)
  'cult-of-love-2024',    // Family dinner scene (correct TodayTix art, not The Humans)
  'all-in-comedy-about-love-2024', // Heart with cast caricatures (correct art)
  'purpose-2025',         // Cast production photo (correct TodayTix art)
  'good-night-and-good-luck-2025', // George Clooney B&W portrait (correct, title cropped)
  'leopoldstadt-2022',    // Cat's cradle / Tom Stoppard (correct art, title cropped)
  'sweeney-todd-2023',    // Aaron Tveit & Sutton Foster (correct, title cropped)
  'sea-wall-2019',        // Jake Gyllenhaal & Tom Sturridge (correct, title cropped)
]);

// ============================================================
// MAIN
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  if (dryRun) {
    console.log('=== DRY RUN MODE (use --apply to execute) ===\n');
  } else {
    console.log('=== APPLYING CHANGES ===\n');
  }

  // Load audit results
  if (!fs.existsSync(AUDIT_PATH)) {
    console.error('ERROR: Run audit-images-llm.js first to generate audit results.');
    process.exit(1);
  }
  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
  const results = audit.results;

  // Load shows.json
  const showsRaw = fs.readFileSync(SHOWS_PATH, 'utf8');
  const showsData = JSON.parse(showsRaw);
  const shows = showsData.shows || showsData;
  const showsArr = Array.isArray(shows) ? shows : Object.values(shows);

  // Build show map for quick lookup
  const showMap = {};
  showsArr.forEach(s => { showMap[s.id] = s; });

  // ========================================
  // Step 1: Identify images to delete from audit
  // ========================================
  const toDelete = [];
  const toKeepOverride = [];

  for (const [id, r] of Object.entries(results)) {
    if (r.action !== 'delete') continue;
    if (FALSE_POSITIVES.has(id)) {
      toKeepOverride.push(id);
      continue;
    }
    toDelete.push({
      showId: id,
      file: r.localFile,
      reason: r.reason || r.description,
      imageSource: r.imageSource,
      thumbnailPath: r.thumbnailPath,
    });
  }

  console.log(`Audit DELETE flags: ${Object.values(results).filter(r => r.action === 'delete').length}`);
  console.log(`False positive overrides: ${toKeepOverride.length}`);
  console.log(`Final images to delete: ${toDelete.length}`);

  // ========================================
  // Step 2: Find orphaned .jpg files (where .webp also exists)
  // ========================================
  const orphanedJpgs = [];
  const showDirs = fs.readdirSync(IMAGES_DIR);
  for (const dir of showDirs) {
    const jpgPath = path.join(IMAGES_DIR, dir, 'thumbnail.jpg');
    const webpPath = path.join(IMAGES_DIR, dir, 'thumbnail.webp');
    if (fs.existsSync(jpgPath) && fs.existsSync(webpPath)) {
      // Check if this .jpg is already in the delete list
      const alreadyListed = toDelete.some(d => d.file === jpgPath);
      if (!alreadyListed) {
        orphanedJpgs.push({ showId: dir, file: jpgPath });
      }
    }
  }

  console.log(`Orphaned .jpg files (have .webp sibling): ${orphanedJpgs.length}`);

  // ========================================
  // Step 3: Archive and delete
  // ========================================
  if (!dryRun) {
    fs.mkdirSync(DELETED_DIR, { recursive: true });
  }

  let deletedCount = 0;
  let nulledCount = 0;

  // Delete audit-flagged images
  for (const item of toDelete) {
    if (item.file && fs.existsSync(item.file)) {
      const archiveDir = path.join(DELETED_DIR, item.showId);
      const archivePath = path.join(archiveDir, path.basename(item.file));

      if (dryRun) {
        console.log(`  [DELETE] ${item.showId}: ${path.basename(item.file)} — ${item.reason}`);
      } else {
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.copyFileSync(item.file, archivePath);
        fs.unlinkSync(item.file);
        deletedCount++;
      }
    }

    // Null out thumbnail in shows.json
    const show = showMap[item.showId];
    if (show && show.images) {
      if (dryRun) {
        if (show.images.thumbnail) {
          console.log(`  [NULL]   ${item.showId}: thumbnail → null`);
        }
      } else {
        if (show.images.thumbnail) {
          show.images.thumbnail = null;
          nulledCount++;
        }
      }
    }
  }

  // Delete orphaned .jpg files (don't null shows.json since .webp is the active one)
  for (const item of orphanedJpgs) {
    const archiveDir = path.join(DELETED_DIR, item.showId);
    const archivePath = path.join(archiveDir, 'thumbnail.jpg');

    if (dryRun) {
      console.log(`  [ORPHAN] ${item.showId}: thumbnail.jpg (has .webp)`);
    } else {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.copyFileSync(item.file, archivePath);
      fs.unlinkSync(item.file);
      deletedCount++;
    }
  }

  // ========================================
  // Step 4: Write updated shows.json
  // ========================================
  if (!dryRun) {
    // Re-read and modify shows.json to preserve formatting
    const freshData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const freshShows = freshData.shows || freshData;
    const freshArr = Array.isArray(freshShows) ? freshShows : Object.values(freshShows);

    for (const item of toDelete) {
      const show = freshArr.find(s => s.id === item.showId);
      if (show && show.images && show.images.thumbnail) {
        show.images.thumbnail = null;
      }
    }

    fs.writeFileSync(SHOWS_PATH, JSON.stringify(freshData, null, 2) + '\n');
  }

  // ========================================
  // Summary
  // ========================================
  console.log('\n============================================================');
  if (dryRun) {
    console.log('DRY RUN COMPLETE — no changes made');
    console.log(`Would delete: ${toDelete.filter(d => d.file && fs.existsSync(d.file)).length} bad images`);
    console.log(`Would delete: ${orphanedJpgs.length} orphaned .jpg files`);
    console.log(`Would null: ${toDelete.filter(d => showMap[d.showId]?.images?.thumbnail).length} thumbnails in shows.json`);
    console.log(`Kept (false positives): ${toKeepOverride.length}`);
    console.log('\nRun with --apply to execute these changes.');
  } else {
    console.log('CLEANUP COMPLETE');
    console.log(`Deleted: ${deletedCount} image files (archived in data/audit/deleted-images/)`);
    console.log(`Nulled: ${nulledCount} thumbnails in shows.json`);
    console.log(`Kept (false positives): ${toKeepOverride.length}`);
  }
  console.log('============================================================\n');
}

main();
