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
const { safeWriteReview } = require('./lib/review-write-guard');
const { evaluateShowMentionGuard, pickShowTitleForHeuristic } = require('./lib/review-guards');

const { pickFingerprintOwners, duplicateTextTarget } = require('./lib/fingerprint-owner');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-review-flags.js — Backfill Review Quality Flags (1D).

Usage:
  node scripts/backfill-review-flags.js [options]
  node scripts/backfill-review-flags.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

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

  // First pass: fingerprint every file (for 1C dedup). Owners are picked by
  // pickFingerprintOwners so a same-URL dedup loser never owns (BRO-4188).
  const fpEntries = [];
  const fileMeta = new Map(); // filename -> { duplicateOf, duplicateTextOf }
  for (const file of files) {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fileMeta.set(file, { duplicateOf: data.duplicateOf, duplicateTextOf: data.duplicateTextOf });
      if (data.fullText && data.fullText.length >= 100) {
        const fp = computeContentFingerprint(data.fullText);
        if (fp) fpEntries.push({ file, fingerprint: fp, duplicateOf: data.duplicateOf, duplicateTextOf: data.duplicateTextOf });
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
  const fingerprintMap = pickFingerprintOwners(fpEntries); // fingerprint → owner filename

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

      // 1A: Show title mention check
      // Uses the shared evaluateShowMentionGuard so the threshold + alreadyScored
      // behavior stays in sync with collect-review-texts.js. The guard refuses to
      // fire on short paywalled excerpts and refuses to set the flag when an
      // aggregator score is already on the file.
      {
        const show = showsData[showId];
        const showTitle = pickShowTitleForHeuristic(showId, show);
        const fullTextWordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
        // Plain check on purpose (BRO-5395): url evidence for this flag was
        // rolled back after the corpus audit (audit-multishow-titlecase.js
        // --rule=flag, 52 clears) found other-production reviews it would admit
        // (a 2025 Barbican Seagull under the 2026 Globe show, 2011 London
        // Clybourne Park under the 2012 Broadway show, a Just for One Day
        // review under One Day the Musical).
        const showCheck = validateShowMentioned(fullText, showTitle, showId);
        const guard = evaluateShowMentionGuard(data, fullText, fullTextWordCount, showCheck);

        if (guard.action === 'null-text') {
          // Unscored review whose substantive text doesn't mention the show
          if (!data.showNotMentioned) {
            data.showNotMentioned = true;
            modified = true;
          }
          flags.push(`showNotMentioned: ${guard.reason}`);
          stats.showNotMentioned++;
        } else if (guard.action === 'flag-needs-review') {
          // Already-scored review — repair stale damage AND flag for human review
          if (!data.needsReview) {
            data.needsReview = true;
            data.needsReviewReason = `Heuristic: show not mentioned in text (${guard.reason}) but already scored — needs human verification`;
            modified = true;
          }
          if (data.showNotMentioned) {
            delete data.showNotMentioned;
            delete data._showNotMentionedDiscoveryAttempted;
            modified = true;
          }
          if (!data.fullText && data.wrongFullText) {
            data.fullText = data.wrongFullText;
            delete data.wrongFullText;
            modified = true;
          }
          flags.push(`scored-but-title-missing: ${guard.reason}`);
        } else if (data.showNotMentioned) {
          // showCheck passed OR context too thin → clear stale flag
          delete data.showNotMentioned;
          modified = true;
        }
      }

      // 1B: Byline cross-check (exclude cast/creative names to avoid false positives)
      const show = showsData[showId];
      const excludeNames = [
        ...((show && show.cast) || []).map(c => c.name),
        ...((show && show.creativeTeam) || []).map(c => c.name)
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
      }

      // 1C: Content hash dedup
      const fingerprint = computeContentFingerprint(fullText);
      if (fingerprint) {
        const owner = fingerprintMap.get(fingerprint);
        const existingOwner = duplicateTextTarget(file, owner, fileMeta.get(owner));
        if (existingOwner) {
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
      }

      // Write if modified
      if (modified && !DRY_RUN) {
        if (safeWriteReview(filePath, data, { force: true })?.wrote !== false) stats.filesModified++;
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
