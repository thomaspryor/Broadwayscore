#!/usr/bin/env node

/**
 * cleanup-data-integrity.js
 *
 * Comprehensive data cleanup based on audit-data-integrity.js findings.
 * Handles six cleanup areas:
 *
 * 1A. Unflag false-positive wrongProduction reviews (restores to scoring)
 * 1B. Fix thestage → stagebuddy outlet misidentifications
 * 1C. Delete cross-contaminated review files (wrong show entirely)
 * 2D. Deduplicate revival-overlap files (same URL in multiple revival dirs)
 * 2E. Merge queen-of-versailles duplicate show entries
 * F.  Fix 404/error page fullText (null out garbage)
 *
 * Usage:
 *   node scripts/cleanup-data-integrity.js --dry-run    # Preview changes
 *   node scripts/cleanup-data-integrity.js --apply       # Execute changes
 *   node scripts/cleanup-data-integrity.js --apply --task=1A  # Execute one task
 */

const fs = require('fs');
const path = require('path');
const { verifyFullTextContent } = require('./lib/content-quality');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const TASK_FILTER = args.find(a => a.startsWith('--task='))?.split('=')[1]?.toUpperCase();

if (DRY_RUN) {
  console.log('DRY RUN — no changes will be made. Use --apply to execute.\n');
}

// Load shows.json
const showsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
const showsData = showsRaw.shows || showsRaw;
const showById = {};
if (Array.isArray(showsData)) {
  for (const s of showsData) showById[s.id] = s;
} else {
  for (const [id, s] of Object.entries(showsData)) showById[id] = s;
}

const stats = {
  '1A_unflagged': 0,
  '1B_renamed': 0,
  '1C_deleted': 0,
  '2D_deduped': 0,
  '2E_merged': 0,
  'F_nulled': 0,
};

// ============================================================
// Task 1A: Unflag false-positive wrongProduction reviews
// ============================================================
if (!TASK_FILTER || TASK_FILTER === '1A') {
  console.log('=== Task 1A: Unflag false-positive wrongProduction reviews ===\n');

  // Scan all review-text files for wrongProduction: true
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  let checked = 0;
  let unflagged = 0;

  for (const showDir of showDirs) {
    const show = showById[showDir];
    if (!show) continue;

    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (!data.wrongProduction) continue;
      checked++;

      const note = (data.wrongProductionNote || '').toLowerCase();

      // Skip manual off-Broadway flags — these are human-verified
      if (note.includes('off-broadway') || note.includes('off broadway') ||
          note.includes('public theater') || note.includes('playwrights horizons') ||
          note.includes('lucille lortel') || note.includes('park avenue armory') ||
          note.includes('park central') || note.includes('nytw')) {
        continue;
      }

      // Skip the stranger-things BBC review (possible London production)
      if (showDir === 'stranger-things-2024' && file.includes('bbc')) {
        continue;
      }

      // For reviews with fullText, verify content matches show
      if (data.fullText && data.fullText.length > 200) {
        const result = verifyFullTextContent(data.fullText, show);
        if (result.verdict === 'confident_match' || result.verdict === 'probable_match') {
          console.log(`  UNFLAG: ${showDir}/${file} (score ${result.score}, ${result.verdict})`);
          console.log(`    Reason: ${result.positiveSignals.join(', ')}`);

          if (!DRY_RUN) {
            delete data.wrongProduction;
            if (data.wrongProductionNote) {
              data.unflaggedNote = `Previously flagged: ${data.wrongProductionNote}`;
              delete data.wrongProductionNote;
            }
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          }
          unflagged++;
          stats['1A_unflagged']++;
        }
      } else if (!data.fullText || data.fullText.length < 50) {
        // No fullText — check by category
        // "URL year" flags are known unreliable (per CLAUDE.md)
        if (note.includes('url year') || note.includes('url contains year')) {
          // Check if another production of the same title exists
          const baseTitle = show.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          let otherExists = false;
          const allShows = Array.isArray(showsData) ? showsData : Object.values(showsData);
          for (const s of allShows) {
            if (s.id !== show.id && s.title.toLowerCase().replace(/[^a-z0-9]/g, '') === baseTitle) {
              otherExists = true;
              break;
            }
          }

          if (!otherExists) {
            console.log(`  UNFLAG: ${showDir}/${file} (URL-year flag, no competing production)`);
            if (!DRY_RUN) {
              delete data.wrongProduction;
              if (data.wrongProductionNote) {
                data.unflaggedNote = `Previously flagged: ${data.wrongProductionNote}`;
                delete data.wrongProductionNote;
              }
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            }
            unflagged++;
            stats['1A_unflagged']++;
          }
        }
        // "no note" flags with no fullText and no competing production — unflag
        else if (!note || note === '') {
          const baseTitle = show.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          let otherExists = false;
          const allShows = Array.isArray(showsData) ? showsData : Object.values(showsData);
          for (const s of allShows) {
            if (s.id !== show.id && s.title.toLowerCase().replace(/[^a-z0-9]/g, '') === baseTitle) {
              otherExists = true;
              break;
            }
          }

          if (!otherExists && data.assignedScore) {
            // Has a score but no note and no competing production — likely false positive
            console.log(`  UNFLAG: ${showDir}/${file} (no note, has score, no competing production)`);
            if (!DRY_RUN) {
              delete data.wrongProduction;
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            }
            unflagged++;
            stats['1A_unflagged']++;
          }
        }
      }
    }
  }

  console.log(`\n  Checked ${checked} wrongProduction files, unflagged ${unflagged}\n`);
}

// ============================================================
// Task 1B: Fix thestage → stagebuddy outlet misidentifications
// ============================================================
if (!TASK_FILTER || TASK_FILTER === '1B') {
  console.log('=== Task 1B: Fix thestage → stagebuddy outlet misidentifications ===\n');

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  let renamed = 0;

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.startsWith('thestage--') && f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      // Check if URL points to stagebuddy.com
      if (data.url && data.url.includes('stagebuddy.com')) {
        const newFile = file.replace('thestage--', 'stagebuddy--');
        const newPath = path.join(dirPath, newFile);

        console.log(`  RENAME: ${showDir}/${file} → ${newFile}`);
        console.log(`    outletId: thestage → stagebuddy`);
        console.log(`    URL: ${data.url.substring(0, 80)}`);

        if (!DRY_RUN) {
          data.outletId = 'stagebuddy';
          data.outlet = 'Stage Buddy';
          fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
          fs.unlinkSync(filePath);
        }
        renamed++;
        stats['1B_renamed']++;
      }
    }
  }

  console.log(`\n  Renamed ${renamed} files\n`);
}

// ============================================================
// Task 1C: Delete cross-contaminated review files
// ============================================================
if (!TASK_FILTER || TASK_FILTER === '1C') {
  console.log('=== Task 1C: Delete cross-contaminated review files ===\n');

  // Build URL → files map across all shows
  const urlToFiles = {};
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (data.url && !data.isRoundupArticle) {
        const normalizedUrl = normalizeUrl(data.url);
        if (!urlToFiles[normalizedUrl]) urlToFiles[normalizedUrl] = [];
        urlToFiles[normalizedUrl].push({
          showDir,
          file,
          filePath,
          publishDate: data.publishDate,
          showId: data.showId || showDir,
        });
      }
    }
  }

  // Known cross-contamination clusters (different shows entirely)
  // These are shows whose titles partially overlap, causing false URL sharing
  const CROSS_CONTAM_PAIRS = [
    // [wrong dir, correct dir pattern] — delete from wrong dir
    ['dog-day-afternoon-2026', 'topdog-underdog-2022'],
    ['ann-2013', 'sylvia-2015'],
    ['race-2009', 'disgraced-2014'],
    ['summer-2018', 'summer-1976-2023'],
    ['wit-2012', 'the-velocity-of-autumn-2014'],
    ['hair-2011', 'jajas-african-hair-braiding-2023'],
    ['harvey-2012', 'casa-valentina-2014'],
  ];

  let deleted = 0;

  for (const [url, fileEntries] of Object.entries(urlToFiles)) {
    if (fileEntries.length < 2) continue;

    const showDirsInvolved = [...new Set(fileEntries.map(f => f.showDir))];
    if (showDirsInvolved.length < 2) continue;

    // Check if this is a known cross-contamination pair
    for (const [wrongDir, correctDir] of CROSS_CONTAM_PAIRS) {
      if (showDirsInvolved.includes(wrongDir) && showDirsInvolved.includes(correctDir)) {
        // Delete the file in the wrong directory
        const wrongEntry = fileEntries.find(f => f.showDir === wrongDir);
        if (wrongEntry) {
          console.log(`  DELETE: ${wrongEntry.showDir}/${wrongEntry.file} (belongs to ${correctDir})`);
          if (!DRY_RUN) {
            fs.unlinkSync(wrongEntry.filePath);
          }
          deleted++;
          stats['1C_deleted']++;
        }
      }
    }
  }

  // Also check: files where the showId field doesn't match the directory
  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      // If showId doesn't match directory and file has wrongShow or wrongProduction
      if (data.wrongShow === true) {
        console.log(`  DELETE: ${showDir}/${file} (flagged wrongShow)`);
        if (!DRY_RUN) {
          fs.unlinkSync(filePath);
        }
        deleted++;
        stats['1C_deleted']++;
      }
    }
  }

  console.log(`\n  Deleted ${deleted} cross-contaminated files\n`);
}

// ============================================================
// Task 2D: Deduplicate revival-overlap files
// ============================================================
if (!TASK_FILTER || TASK_FILTER === '2D') {
  console.log('=== Task 2D: Deduplicate revival-overlap review files ===\n');

  // Build URL → files map
  const urlToFiles = {};
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  for (const showDir of showDirs) {
    const show = showById[showDir];
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (data.url && !data.isRoundupArticle) {
        const normalizedUrl = normalizeUrl(data.url);
        if (!urlToFiles[normalizedUrl]) urlToFiles[normalizedUrl] = [];
        urlToFiles[normalizedUrl].push({
          showDir,
          file,
          filePath,
          publishDate: data.publishDate,
          openingDate: show ? show.openingDate : null,
          showTitle: show ? show.title : showDir,
        });
      }
    }
  }

  let deduped = 0;

  for (const [url, fileEntries] of Object.entries(urlToFiles)) {
    if (fileEntries.length < 2) continue;

    const showDirsInvolved = [...new Set(fileEntries.map(f => f.showDir))];
    if (showDirsInvolved.length < 2) continue;

    // Check if these are revivals of the same show (same base title, different year)
    const baseNames = showDirsInvolved.map(d => d.replace(/-\d{4}$/, ''));
    const uniqueBaseNames = [...new Set(baseNames)];

    // Only handle revival duplicates here (same base name)
    if (uniqueBaseNames.length !== 1) continue;

    // Determine which directory is correct based on publish date
    // The review belongs to whichever production was running when it was published
    const entryWithDate = fileEntries.find(f => f.publishDate);
    if (!entryWithDate) {
      // No publish date — keep in the later production directory (more likely correct)
      const sorted = fileEntries.sort((a, b) => {
        const yearA = parseInt(a.showDir.match(/-(\d{4})$/)?.[1] || '0');
        const yearB = parseInt(b.showDir.match(/-(\d{4})$/)?.[1] || '0');
        return yearB - yearA;
      });

      // Delete from all but the latest directory
      for (let i = 1; i < sorted.length; i++) {
        console.log(`  DELETE: ${sorted[i].showDir}/${sorted[i].file} (revival dup, keeping in ${sorted[0].showDir})`);
        if (!DRY_RUN) {
          fs.unlinkSync(sorted[i].filePath);
        }
        deduped++;
        stats['2D_deduped']++;
      }
      continue;
    }

    const pubDate = new Date(entryWithDate.publishDate);

    // Find the production whose opening date is closest to (but before) the publish date
    let bestDir = null;
    let bestDiff = Infinity;

    for (const entry of fileEntries) {
      if (!entry.openingDate) continue;
      const openDate = new Date(entry.openingDate);
      const diff = pubDate - openDate;

      // Review should be published around or after opening
      // Best match: smallest non-negative diff (published closest after opening)
      if (diff >= -30 * 24 * 60 * 60 * 1000 && diff < bestDiff) { // Allow 30 days before opening (preview period)
        bestDiff = diff;
        bestDir = entry.showDir;
      }
    }

    // Fallback: if no good match, use the latest production
    if (!bestDir) {
      const sorted = fileEntries.sort((a, b) => {
        const yearA = parseInt(a.showDir.match(/-(\d{4})$/)?.[1] || '0');
        const yearB = parseInt(b.showDir.match(/-(\d{4})$/)?.[1] || '0');
        return yearB - yearA;
      });
      bestDir = sorted[0].showDir;
    }

    // Delete from all but the best directory
    for (const entry of fileEntries) {
      if (entry.showDir !== bestDir) {
        console.log(`  DELETE: ${entry.showDir}/${entry.file} (revival dup, keeping in ${bestDir})`);
        if (!DRY_RUN) {
          fs.unlinkSync(entry.filePath);
        }
        deduped++;
        stats['2D_deduped']++;
      }
    }
  }

  console.log(`\n  Deduplicated ${deduped} revival-overlap files\n`);
}

// ============================================================
// Task 2E: Merge queen-of-versailles duplicate show entries
// ============================================================
if (!TASK_FILTER || TASK_FILTER === '2E') {
  console.log('=== Task 2E: Merge queen-of-versailles duplicate entries ===\n');

  const oldDir = path.join(REVIEW_TEXTS_DIR, 'queen-of-versailles');
  const newDir = path.join(REVIEW_TEXTS_DIR, 'queen-versailles-2025');

  if (fs.existsSync(oldDir) && fs.existsSync(newDir)) {
    const oldFiles = fs.readdirSync(oldDir).filter(f => f.endsWith('.json'));
    const newFiles = new Set(fs.readdirSync(newDir).filter(f => f.endsWith('.json')));

    let moved = 0;
    let skipped = 0;

    for (const file of oldFiles) {
      if (newFiles.has(file)) {
        // File exists in both — compare and keep the one with more data
        const oldData = JSON.parse(fs.readFileSync(path.join(oldDir, file), 'utf8'));
        const newData = JSON.parse(fs.readFileSync(path.join(newDir, file), 'utf8'));

        const oldScore = (oldData.fullText ? oldData.fullText.length : 0) + (oldData.assignedScore ? 100 : 0);
        const newScore = (newData.fullText ? newData.fullText.length : 0) + (newData.assignedScore ? 100 : 0);

        if (oldScore > newScore) {
          console.log(`  OVERWRITE: queen-of-versailles/${file} → queen-versailles-2025/${file} (old has more data)`);
          if (!DRY_RUN) {
            oldData.showId = 'queen-versailles-2025';
            fs.writeFileSync(path.join(newDir, file), JSON.stringify(oldData, null, 2));
            fs.unlinkSync(path.join(oldDir, file));
          }
          moved++;
        } else {
          console.log(`  SKIP: ${file} (new dir already has better data)`);
          if (!DRY_RUN) {
            fs.unlinkSync(path.join(oldDir, file));
          }
          skipped++;
        }
      } else {
        // File only in old dir — move to new dir
        console.log(`  MOVE: queen-of-versailles/${file} → queen-versailles-2025/${file}`);
        if (!DRY_RUN) {
          const data = JSON.parse(fs.readFileSync(path.join(oldDir, file), 'utf8'));
          data.showId = 'queen-versailles-2025';
          fs.writeFileSync(path.join(newDir, file), JSON.stringify(data, null, 2));
          fs.unlinkSync(path.join(oldDir, file));
        }
        moved++;
      }
    }

    // Remove old directory if empty
    if (!DRY_RUN) {
      const remaining = fs.readdirSync(oldDir);
      if (remaining.length === 0) {
        fs.rmdirSync(oldDir);
        console.log(`  Removed empty directory: queen-of-versailles/`);
      }
    }

    stats['2E_merged'] = moved + skipped;
    console.log(`\n  Moved ${moved}, skipped ${skipped} duplicate files\n`);
  } else {
    console.log(`  Skipped: one or both directories do not exist\n`);
    if (!fs.existsSync(oldDir)) console.log(`    Missing: queen-of-versailles/`);
    if (!fs.existsSync(newDir)) console.log(`    Missing: queen-versailles-2025/`);
  }
}

// ============================================================
// Task F: Fix 404/error page fullText + improve title matching
// ============================================================
if (!TASK_FILTER || TASK_FILTER === 'F') {
  console.log('=== Task F: Null 404/error page fullText ===\n');

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);

  let nulled = 0;

  const ERROR_PATTERNS = [
    "it seems we can't find what you're looking for",
    'page not found',
    '404 not found',
    'the page you requested could not be found',
    'this page is no longer available',
    'we could not find the page',
    'sorry, the page you were looking for',
    'perhaps searching can help',
    'the content you are looking for is no longer available',
  ];

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

      if (!data.fullText || data.fullText.length > 500) continue;

      const textLower = data.fullText.toLowerCase();

      for (const pattern of ERROR_PATTERNS) {
        if (textLower.includes(pattern)) {
          console.log(`  NULL: ${showDir}/${file} (error page: "${pattern}")`);
          if (!DRY_RUN) {
            data.garbageFullText = data.fullText;
            data.fullText = null;
            data.garbageReason = `Error/404 page content`;
            data.contentTier = data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt ? 'excerpt' : 'needs-rescrape';
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          }
          nulled++;
          stats['F_nulled']++;
          break;
        }
      }
    }
  }

  console.log(`\n  Nulled ${nulled} error/404 page fullText entries\n`);
}

// ============================================================
// Summary
// ============================================================
console.log('\n=== Summary ===\n');
console.log(`  1A: ${stats['1A_unflagged']} wrongProduction false positives unflagged`);
console.log(`  1B: ${stats['1B_renamed']} thestage → stagebuddy files renamed`);
console.log(`  1C: ${stats['1C_deleted']} cross-contaminated files deleted`);
console.log(`  2D: ${stats['2D_deduped']} revival-overlap files deduplicated`);
console.log(`  2E: ${stats['2E_merged']} queen-of-versailles files merged`);
console.log(`  F:  ${stats['F_nulled']} error/404 fullText entries nulled`);

const total = Object.values(stats).reduce((a, b) => a + b, 0);
console.log(`\n  Total changes: ${total}`);

if (DRY_RUN) {
  console.log('\n  This was a DRY RUN. Use --apply to execute changes.');
}

// ---- Helpers ----

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    trackingParams.forEach(p => parsed.searchParams.delete(p));
    const search = parsed.searchParams.toString();
    const base = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
    return search ? `${base}?${search}` : base;
  } catch {
    return url.toLowerCase();
  }
}
