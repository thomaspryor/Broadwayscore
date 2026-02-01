#!/usr/bin/env node
/**
 * Backfill Review Quality Flags (1D)
 *
 * One-time script that reads all review-text JSON files and applies
 * Phase 1 post-scrape validation checks:
 * - 1A: validateShowMentioned() → sets showNotMentioned
 * - 1B: extractByline() + matchesCritic() → sets misattributedFullText
 * - 1C: computeContentFingerprint() → sets duplicateTextOf
 *
 * Usage:
 *   node scripts/backfill-review-flags.js              # Apply flags
 *   node scripts/backfill-review-flags.js --dry-run    # Report only, no file changes
 *   node scripts/backfill-review-flags.js --show=slug  # Single show only
 */

const fs = require('fs');
const path = require('path');
const { validateShowMentioned, extractByline, matchesCritic, computeContentFingerprint } = require('./lib/content-quality');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Load shows.json for title lookup
let showsData = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const shows = raw.shows || raw;
  shows.forEach(s => { showsData[s.id] = s; });
} catch (e) {
  console.warn('Could not load shows.json, using showId-derived titles');
}

const stats = {
  totalFiles: 0,
  showNotMentioned: 0,
  misattributed: 0,
  duplicateText: 0,
  filesModified: 0,
  errors: 0,
};

const flaggedReviews = [];

console.log('=== BACKFILL REVIEW QUALITY FLAGS ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (writing flags)'}`);
if (SHOW_FILTER) console.log(`Filter: ${SHOW_FILTER}`);
console.log('');

// Get show directories
const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .filter(d => !SHOW_FILTER || d.name === SHOW_FILTER || d.name.startsWith(SHOW_FILTER))
  .map(d => d.name);

if (SHOW_FILTER && showDirs.length === 0) {
  console.error(`No show directory found matching "${SHOW_FILTER}"`);
  process.exit(1);
}

console.log(`Processing ${showDirs.length} show directories...\n`);

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  // Build fingerprint map for this show (for 1C dedup)
  const fingerprintMap = new Map(); // fingerprint → filename

  // First pass: build fingerprint map
  for (const file of files) {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.fullText && data.fullText.length >= 100) {
        const fp = computeContentFingerprint(data.fullText);
        if (fp) {
          if (fingerprintMap.has(fp)) {
            // This is a duplicate - record it
            // The first file keeps the fingerprint, subsequent ones get flagged
          } else {
            fingerprintMap.set(fp, file);
          }
        }
      }
    } catch (e) {
      // Skip unreadable files
    }
  }

  // Second pass: apply checks
  for (const file of files) {
    stats.totalFiles++;
    const filePath = path.join(showDir, file);

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let modified = false;
      const flags = [];

      // Skip if no fullText
      if (!data.fullText || data.fullText.length < 100) continue;

      const fullText = data.fullText;

      // 1A: Show title mention check (only for texts >500 chars)
      if (fullText.length > 500) {
        const show = showsData[showId];
        const showTitle = show ? show.title : showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
        const showCheck = validateShowMentioned(fullText, showTitle, showId);

        if (!showCheck.valid && showCheck.confidence === 'high') {
          if (!data.showNotMentioned) {
            data.showNotMentioned = true;
            modified = true;
          }
          flags.push(`showNotMentioned: ${showCheck.reason}`);
          stats.showNotMentioned++;
        } else if (data.showNotMentioned) {
          // Clear stale flag
          delete data.showNotMentioned;
          modified = true;
        }
      }

      // 1B: Byline cross-check (exclude cast/creative names to avoid false positives)
      const showForByline = showsData[showId];
      const excludeNames = [
        ...((showForByline && showForByline.cast) || []).map(c => c.name),
        ...((showForByline && showForByline.creativeTeam) || []).map(c => c.name)
      ];
      const bylineResult = extractByline(fullText, { excludeNames });
      if (bylineResult.found) {
        const expectedCritic = data.criticName || '';
        if (expectedCritic && !matchesCritic(bylineResult.name, expectedCritic)) {
          if (!data.misattributedFullText) {
            data.misattributedFullText = true;
            data.extractedByline = bylineResult.name;
            data.expectedCritic = expectedCritic;
            modified = true;
          }
          flags.push(`misattributed: found "${bylineResult.name}", expected "${expectedCritic}"`);
          stats.misattributed++;
        } else if (data.misattributedFullText) {
          // Clear stale flag
          delete data.misattributedFullText;
          delete data.extractedByline;
          delete data.expectedCritic;
          modified = true;
        }
      } else if (data.misattributedFullText) {
        // No byline found at all — clear stale flag
        delete data.misattributedFullText;
        delete data.extractedByline;
        delete data.expectedCritic;
        modified = true;
      }

      // 1C: Content hash dedup
      const fingerprint = computeContentFingerprint(fullText);
      if (fingerprint) {
        const existingOwner = fingerprintMap.get(fingerprint);
        if (existingOwner && existingOwner !== file) {
          if (!data.duplicateTextOf || data.duplicateTextOf !== existingOwner) {
            data.duplicateTextOf = existingOwner;
            modified = true;
          }
          flags.push(`duplicateTextOf: ${existingOwner}`);
          stats.duplicateText++;
        } else if (data.duplicateTextOf) {
          // Clear stale flag
          delete data.duplicateTextOf;
          modified = true;
        }
        // Register this file if not already in map
        if (!fingerprintMap.has(fingerprint)) {
          fingerprintMap.set(fingerprint, file);
        }
      }

      // Write if modified
      if (modified && !DRY_RUN) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        stats.filesModified++;
      } else if (modified) {
        stats.filesModified++;
      }

      // Log flagged reviews
      if (flags.length > 0) {
        flaggedReviews.push({ showId, file, flags });
      }

    } catch (e) {
      stats.errors++;
      console.error(`  Error processing ${showId}/${file}: ${e.message}`);
    }
  }
}

// Print results
console.log('\n=== RESULTS ===\n');
console.log(`Total files scanned: ${stats.totalFiles}`);
console.log(`Files ${DRY_RUN ? 'that would be' : ''} modified: ${stats.filesModified}`);
console.log('');
console.log('Flags found:');
console.log(`  showNotMentioned: ${stats.showNotMentioned}`);
console.log(`  misattributedFullText: ${stats.misattributed}`);
console.log(`  duplicateTextOf: ${stats.duplicateText}`);
console.log(`  errors: ${stats.errors}`);

if (flaggedReviews.length > 0) {
  console.log(`\n=== FLAGGED REVIEWS (${flaggedReviews.length}) ===\n`);
  for (const { showId, file, flags } of flaggedReviews) {
    console.log(`  ${showId}/${file}`);
    for (const flag of flags) {
      console.log(`    - ${flag}`);
    }
  }
}

if (DRY_RUN) {
  console.log('\n[DRY RUN] No files were modified. Re-run without --dry-run to apply changes.');
}

console.log('\n=== DONE ===');
