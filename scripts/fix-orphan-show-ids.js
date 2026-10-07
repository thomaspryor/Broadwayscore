#!/usr/bin/env node
/**
 * fix-orphan-show-ids.js
 *
 * Finds review-text directories whose showId doesn't match any show in shows.json,
 * proposes corrections, and optionally applies them.
 *
 * Default: dry-run (prints proposed changes)
 * With --apply: renames directories and updates showId in review files
 *
 * Usage:
 *   node scripts/fix-orphan-show-ids.js           # dry-run
 *   node scripts/fix-orphan-show-ids.js --apply    # apply changes
 */

const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-orphan-show-ids.js — Finds review-text directories whose showId doesn't match any show in shows.json,.

Usage:
  node scripts/fix-orphan-show-ids.js [options]
  node scripts/fix-orphan-show-ids.js --help, -h    print this usage and exit
`;
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const applyMode = process.argv.includes('--apply');

// Known mappings (verified manually + via fuzzy matching against shows.json)
// Each orphan ID maps to its correct show ID
const KNOWN_MAPPINGS = {
  'tammy-faye': 'tammy-faye-2024',
  'queen-of-versailles': 'queen-versailles-2025',
  'romeo-juliet': 'romeo-juliet-2024',
  'two-strangers': 'two-strangers-bway-2025',
  'doubt-a-parable': 'doubt-2024',
  'harry-potter-and-the-cursed-child': 'harry-potter-2021',
  'harry-potter-and-the-cursed-child-parts-one-and-two': 'harry-potter-2021',
  'the-lion-king': 'the-lion-king-1997',
  'the-notebook': 'the-notebook-2024',
  'the-shark-is-broken': 'the-shark-is-broken-2023',
  'the-whos-tommy': 'the-whos-tommy-2024',
  'the-wiz': 'the-wiz-2024',
  'water-for-elephants': 'water-for-elephants-2024',
  'aladdin': 'aladdin-2014',
  'moulin-rouge-the-musical-review': 'moulin-rouge-2019',
  'patriots': 'patriots-2024',
  'purpose': 'purpose-2025',
  'the-great-gatsby': 'the-great-gatsby-2024',
  'the-norman-conquests': 'the-norman-conquests-2009',
  'the-roommate': 'the-roommate-2024',
  'uncle-vanya': 'uncle-vanya-2024',
  // take-me-out has two possible matches (2022 and 2003) — needs publish date check
};

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FIX ORPHAN SHOW IDs — ${applyMode ? 'APPLY MODE' : 'DRY RUN'}`);
  console.log('='.repeat(60));

  // Load shows.json
  const showsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  const showMap = new Map();
  showsData.shows.forEach(s => { if (s && s.id) showMap.set(s.id, s); });

  // Load reviews.json
  const reviewsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8'));

  // Find orphan reviews
  const orphanMap = {};
  reviewsData.reviews.forEach(r => {
    if (!showMap.has(r.showId)) {
      if (!orphanMap[r.showId]) orphanMap[r.showId] = [];
      orphanMap[r.showId].push(r);
    }
  });

  const orphanIds = Object.keys(orphanMap).sort();
  console.log(`\nFound ${orphanIds.length} orphan show IDs (${Object.values(orphanMap).flat().length} reviews total)\n`);

  let fixed = 0;
  let skipped = 0;
  const changes = [];

  for (const orphanId of orphanIds) {
    const reviews = orphanMap[orphanId];
    const targetId = KNOWN_MAPPINGS[orphanId];

    if (!targetId) {
      // Try to auto-resolve take-me-out by checking publish dates
      if (orphanId === 'take-me-out') {
        const review = reviews[0];
        const pubDate = review.publishDate ? new Date(review.publishDate) : null;
        if (pubDate && pubDate.getFullYear() >= 2020) {
          console.log(`  ${orphanId} (${reviews.length} reviews) → take-me-out-2022 (by publish date ${review.publishDate})`);
          changes.push({ orphanId, targetId: 'take-me-out-2022', reviews });
          fixed += reviews.length;
          continue;
        } else if (pubDate) {
          console.log(`  ${orphanId} (${reviews.length} reviews) → take-me-out-2003 (by publish date ${review.publishDate})`);
          changes.push({ orphanId, targetId: 'take-me-out-2003', reviews });
          fixed += reviews.length;
          continue;
        }
      }
      console.log(`  ⚠️  ${orphanId} (${reviews.length} reviews) → NO MAPPING FOUND — skipping`);
      skipped += reviews.length;
      continue;
    }

    // Validate target exists
    if (!showMap.has(targetId)) {
      console.log(`  ❌ ${orphanId} → ${targetId} BUT target doesn't exist in shows.json — skipping`);
      skipped += reviews.length;
      continue;
    }

    // Cross-validate publish dates against target show's opening date
    const targetShow = showMap.get(targetId);
    const targetOpening = targetShow.openingDate ? new Date(targetShow.openingDate) : null;
    let dateWarning = false;

    for (const review of reviews) {
      if (review.publishDate && targetOpening) {
        const pubDate = new Date(review.publishDate);
        const diffMonths = (pubDate - targetOpening) / (1000 * 60 * 60 * 24 * 30);
        if (diffMonths < -6) {
          console.log(`  ⚠️  ${orphanId}: review from ${review.publishDate} predates ${targetId} opening ${targetShow.openingDate} by ${Math.abs(Math.round(diffMonths))} months`);
          dateWarning = true;
        }
      }
    }

    if (dateWarning && !applyMode) {
      console.log(`  ⚠️  ${orphanId} (${reviews.length} reviews) → ${targetId} — DATE MISMATCH, review manually`);
    } else {
      console.log(`  ${orphanId} (${reviews.length} reviews) → ${targetId}`);
    }
    changes.push({ orphanId, targetId, reviews, dateWarning });
    fixed += reviews.length;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary: ${fixed} reviews fixable, ${skipped} skipped`);
  console.log(`Changes: ${changes.length} orphan IDs → correct show IDs\n`);

  if (!applyMode) {
    console.log('This was a DRY RUN. To apply changes, run:');
    console.log('  node scripts/fix-orphan-show-ids.js --apply\n');
    console.log('Then rebuild reviews.json:');
    console.log('  node scripts/rebuild-all-reviews.js\n');
    return;
  }

  // Apply mode: update showId in review-text files
  console.log('Applying changes...\n');

  let filesUpdated = 0;
  let dirsRenamed = 0;

  for (const { orphanId, targetId, dateWarning } of changes) {
    if (dateWarning) {
      console.log(`  Skipping ${orphanId} due to date mismatch — needs manual review`);
      continue;
    }

    const orphanDir = path.join(REVIEW_TEXTS_DIR, orphanId);
    const targetDir = path.join(REVIEW_TEXTS_DIR, targetId);

    if (!fs.existsSync(orphanDir)) {
      console.log(`  ${orphanId}: directory not found at ${orphanDir} — skipping`);
      continue;
    }

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Move files from orphan dir to target dir, updating showId
    const files = fs.readdirSync(orphanDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const srcPath = path.join(orphanDir, file);
      const destPath = path.join(targetDir, file);

      try {
        const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
        data.showId = targetId;

        // Check for file collision
        if (fs.existsSync(destPath)) {
          console.log(`    ⚠️  ${file} already exists in ${targetId}/ — skipping to avoid overwrite`);
          continue;
        }

        fs.writeFileSync(destPath, JSON.stringify(data, null, 2) + '\n');
        fs.unlinkSync(srcPath);
        filesUpdated++;
      } catch (e) {
        console.log(`    ❌ Error processing ${file}: ${e.message}`);
      }
    }

    // Remove empty orphan directory
    const remaining = fs.readdirSync(orphanDir);
    if (remaining.length === 0) {
      fs.rmdirSync(orphanDir);
      dirsRenamed++;
      console.log(`  ✅ ${orphanId} → ${targetId}: ${files.length} files moved, directory removed`);
    } else {
      console.log(`  ⚠️  ${orphanId}: ${files.length - remaining.length} files moved, ${remaining.length} files remaining in orphan dir`);
    }
  }

  console.log(`\nDone: ${filesUpdated} files updated, ${dirsRenamed} directories cleaned up`);
  console.log('\nNext step: rebuild reviews.json');
  console.log('  node scripts/rebuild-all-reviews.js\n');
}

main();
