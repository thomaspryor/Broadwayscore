#!/usr/bin/env node

/**
 * cleanup-known-issues.js
 *
 * Fixes four known data integrity issues:
 *
 * 1. Wrong-content reviews with isFullReview:true that the collector skips (17 files)
 * 2. All-Out/Bug cross-contamination (29 files to delete)
 * 3. Cats/Jellicle Ball wrong-directory reviews (35 files to delete, 12 to flag)
 * 4. Interested Bystander roundup tagging (33 files)
 *
 * Usage: node scripts/cleanup-known-issues.js --dry-run
 *        node scripts/cleanup-known-issues.js --apply
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DRY_RUN = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');

if (!DRY_RUN && !APPLY) {
  console.log('Usage: node scripts/cleanup-known-issues.js --dry-run | --apply');
  process.exit(1);
}

const stats = {
  wrongContentNulled: 0,
  allOutBugDeleted: 0,
  catsDeleted: 0,
  catsFlagged: 0,
  roundupTagged: 0,
  errors: []
};

// === Issue 1: Wrong-content reviews the collector would skip ===
// These have isFullReview:true, contentTier:"complete", but fullText is about wrong show
const WRONG_CONTENT_FILES = [
  'american-son-2018/variety--marilyn-stasio.json',
  'arcadia-2011/variety--marilyn-stasio.json',
  'assassins-2012/variety--marilyn-stasio.json',
  'burn-the-floor-2009/variety--david-rooney.json',
  'carousel-2018/variety--marilyn-stasio.json',
  'clybourne-park-2012/variety--marilyn-stasio.json',
  'cyrano-de-bergerac-2007/variety--charles-isherwood.json',
  'doubt-2024/theatermania--andy-propst.json',
  'driving-miss-daisy-2010/variety--joe-dziemianowicz.json',
  'fool-for-love-2015/variety--marilyn-stasio.json',
  'how-to-succeed-2011/variety--marilyn-stasio.json',
  'mj-2022/usatoday--david-rooney.json',
  'on-a-clear-day-2011/variety--marilyn-stasio.json',
  'race-2009/variety--marilyn-stasio.json',
  'sondheim-on-sondheim-2010/variety--charles-isherwood.json',
  'the-homecoming-2007/variety--david-rooney.json',
  'the-roommate-2024/variety--charles-isherwood.json'
];

function fixWrongContent() {
  console.log('\n=== Issue 1: Null wrong-content reviews (collector-skipped) ===');

  for (const relPath of WRONG_CONTENT_FILES) {
    const filePath = path.join(REVIEW_TEXTS_DIR, relPath);
    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP (not found): ${relPath}`);
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (!data.fullText || data.fullText.length < 100) {
        console.log(`  SKIP (already null/short): ${relPath}`);
        continue;
      }

      console.log(`  ${DRY_RUN ? 'WOULD NULL' : 'NULLING'}: ${relPath} (${data.fullText.length} chars)`);

      if (APPLY) {
        data.wrongFullText = data.fullText;
        data.fullText = null;
        data.isFullReview = false;
        data.contentTier = 'needs-rescrape';
        data.contentMismatchNote = 'Wrong content detected by audit - fullText is about different show';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }
      stats.wrongContentNulled++;
    } catch (err) {
      stats.errors.push(`Issue1: ${relPath}: ${err.message}`);
    }
  }

  console.log(`  Total: ${stats.wrongContentNulled} files`);
}

// === Issue 2: All-Out/Bug cross-contamination ===
function fixAllOutBug() {
  console.log('\n=== Issue 2: All-Out/Bug cleanup ===');

  // 2a: Delete 17 Bug reviews from all-out-2025/ (keep only nyt-theater--jonathan-mandell.json)
  const allOutDir = path.join(REVIEW_TEXTS_DIR, 'all-out-2025');
  if (fs.existsSync(allOutDir)) {
    const files = fs.readdirSync(allOutDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      if (file === 'nyt-theater--jonathan-mandell.json') {
        console.log(`  KEEP: all-out-2025/${file}`);
        continue;
      }
      console.log(`  ${DRY_RUN ? 'WOULD DELETE' : 'DELETING'}: all-out-2025/${file}`);
      if (APPLY) {
        fs.unlinkSync(path.join(allOutDir, file));
      }
      stats.allOutBugDeleted++;
    }
  }

  // 2b: Delete entire bug-2025/ directory (orphan - no shows.json entry)
  const bug2025Dir = path.join(REVIEW_TEXTS_DIR, 'bug-2025');
  if (fs.existsSync(bug2025Dir)) {
    const files = fs.readdirSync(bug2025Dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      console.log(`  ${DRY_RUN ? 'WOULD DELETE' : 'DELETING'}: bug-2025/${file}`);
      if (APPLY) {
        fs.unlinkSync(path.join(bug2025Dir, file));
      }
      stats.allOutBugDeleted++;
    }
    if (APPLY) {
      // Remove directory if empty
      const remaining = fs.readdirSync(bug2025Dir);
      if (remaining.length === 0) {
        fs.rmdirSync(bug2025Dir);
        console.log('  REMOVED: bug-2025/ directory');
      }
    }
  }

  console.log(`  Total deleted: ${stats.allOutBugDeleted} files`);
}

// === Issue 3: Cats/Jellicle Ball cleanup ===
function fixCats() {
  console.log('\n=== Issue 3: Cats/Jellicle Ball cleanup ===');

  // 3a: cats-1982/ - keep only nytimes--frank-rich.json (and any other legitimate 1982 reviews)
  const cats1982Dir = path.join(REVIEW_TEXTS_DIR, 'cats-1982');
  const KEEP_IN_1982 = new Set(['nytimes--frank-rich.json']);

  if (fs.existsSync(cats1982Dir)) {
    const files = fs.readdirSync(cats1982Dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      // Check if it's a Jellicle Ball review by reading its URL
      const filePath = path.join(cats1982Dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const url = (data.url || '').toLowerCase();
        const isJellicleBall = url.includes('jellicle') || url.includes('jellice') ||
          url.includes('/2024/06/') ||
          (data.publishDate && data.publishDate.startsWith('2024'));

        if (KEEP_IN_1982.has(file) || !isJellicleBall) {
          console.log(`  KEEP: cats-1982/${file}`);
          continue;
        }

        console.log(`  ${DRY_RUN ? 'WOULD DELETE' : 'DELETING'}: cats-1982/${file}`);
        if (APPLY) {
          fs.unlinkSync(filePath);
        }
        stats.catsDeleted++;
      } catch (err) {
        stats.errors.push(`Cats1982: ${file}: ${err.message}`);
      }
    }
  }

  // 3b: cats-2016/ - delete all Jellicle Ball files, keep legitimate 2016 reviews
  const cats2016Dir = path.join(REVIEW_TEXTS_DIR, 'cats-2016');
  if (fs.existsSync(cats2016Dir)) {
    const files = fs.readdirSync(cats2016Dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(cats2016Dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const url = (data.url || '').toLowerCase();
        const publishDate = data.publishDate || '';
        const isJellicleBall = url.includes('jellicle') || url.includes('jellice') ||
          url.includes('/2024/06/') ||
          publishDate.startsWith('2024-06');

        if (!isJellicleBall) {
          console.log(`  KEEP: cats-2016/${file}`);
          continue;
        }

        console.log(`  ${DRY_RUN ? 'WOULD DELETE' : 'DELETING'}: cats-2016/${file}`);
        if (APPLY) {
          fs.unlinkSync(filePath);
        }
        stats.catsDeleted++;
      } catch (err) {
        stats.errors.push(`Cats2016: ${file}: ${err.message}`);
      }
    }
  }

  // 3c: Delete entire cats-the-jellicle-ball/ directory (orphan)
  const catsJBDir = path.join(REVIEW_TEXTS_DIR, 'cats-the-jellicle-ball');
  if (fs.existsSync(catsJBDir)) {
    const files = fs.readdirSync(catsJBDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      console.log(`  ${DRY_RUN ? 'WOULD DELETE' : 'DELETING'}: cats-the-jellicle-ball/${file}`);
      if (APPLY) {
        fs.unlinkSync(path.join(catsJBDir, file));
      }
      stats.catsDeleted++;
    }
    if (APPLY) {
      const remaining = fs.readdirSync(catsJBDir);
      if (remaining.length === 0) {
        fs.rmdirSync(catsJBDir);
        console.log('  REMOVED: cats-the-jellicle-ball/ directory');
      }
    }
  }

  // 3d: Flag reviews in cats-the-jellicle-ball-2026/ as off-Broadway
  const catsJB2026Dir = path.join(REVIEW_TEXTS_DIR, 'cats-the-jellicle-ball-2026');
  if (fs.existsSync(catsJB2026Dir)) {
    const files = fs.readdirSync(catsJB2026Dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(catsJB2026Dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const url = (data.url || '').toLowerCase();

        // All current reviews are from the off-Broadway run (June 2024).
        // Broadway previews don't start until March 2026, so every review
        // currently in this directory is pre-Broadway.
        const isOffBroadway = !data.publishDate ||
          data.publishDate.startsWith('2024') ||
          url.includes('/2024/') ||
          url.includes('off-broadway') ||
          url.includes('perelman');

        if (!isOffBroadway) {
          console.log(`  KEEP (Broadway review): cats-the-jellicle-ball-2026/${file}`);
          continue;
        }

        if (data.wrongProduction === true) {
          console.log(`  SKIP (already flagged): cats-the-jellicle-ball-2026/${file}`);
          continue;
        }

        console.log(`  ${DRY_RUN ? 'WOULD FLAG' : 'FLAGGING'}: cats-the-jellicle-ball-2026/${file}`);
        if (APPLY) {
          data.wrongProduction = true;
          data.wrongProductionNote = 'Off-Broadway run at Perelman Performing Arts Center, June 2024';
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
        stats.catsFlagged++;
      } catch (err) {
        stats.errors.push(`CatsJB2026: ${file}: ${err.message}`);
      }
    }
  }

  console.log(`  Total deleted: ${stats.catsDeleted} files`);
  console.log(`  Total flagged off-Broadway: ${stats.catsFlagged} files`);
}

// === Issue 4: Interested Bystander roundup tagging ===
function fixInterestedBystander() {
  console.log('\n=== Issue 4: Tag Interested Bystander as roundup articles ===');

  // Scan all review-text directories for interested-bystander files
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR);

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath).filter(f =>
      f.includes('interested-bystander') && f.endsWith('.json')
    );

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (data.isRoundupArticle === true) {
          continue; // Already tagged
        }

        console.log(`  ${DRY_RUN ? 'WOULD TAG' : 'TAGGING'}: ${showDir}/${file}`);
        if (APPLY) {
          data.isRoundupArticle = true;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
        stats.roundupTagged++;
      } catch (err) {
        stats.errors.push(`Bystander: ${showDir}/${file}: ${err.message}`);
      }
    }
  }

  console.log(`  Total tagged: ${stats.roundupTagged} files`);
}

// === Run all fixes ===
console.log(`\n${'='.repeat(60)}`);
console.log(`  Known Issues Cleanup — ${DRY_RUN ? 'DRY RUN' : 'APPLYING CHANGES'}`);
console.log(`${'='.repeat(60)}`);

fixWrongContent();
fixAllOutBug();
fixCats();
fixInterestedBystander();

console.log(`\n${'='.repeat(60)}`);
console.log('  SUMMARY');
console.log(`${'='.repeat(60)}`);
console.log(`  Wrong content nulled:         ${stats.wrongContentNulled}`);
console.log(`  All-Out/Bug files deleted:    ${stats.allOutBugDeleted}`);
console.log(`  Cats files deleted:           ${stats.catsDeleted}`);
console.log(`  Cats files flagged off-Bway:  ${stats.catsFlagged}`);
console.log(`  Roundup articles tagged:      ${stats.roundupTagged}`);
console.log(`  Total changes:                ${stats.wrongContentNulled + stats.allOutBugDeleted + stats.catsDeleted + stats.catsFlagged + stats.roundupTagged}`);

if (stats.errors.length > 0) {
  console.log(`\n  ERRORS (${stats.errors.length}):`);
  for (const err of stats.errors) {
    console.log(`    ${err}`);
  }
}

if (DRY_RUN) {
  console.log('\n  This was a dry run. Use --apply to make changes.');
}
