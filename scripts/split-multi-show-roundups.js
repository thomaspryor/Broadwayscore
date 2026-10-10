#!/usr/bin/env node
/**
 * split-multi-show-roundups.js
 *
 * Walks data/review-texts/ for files flagged isMultiShowReview=true and splits
 * them into per-show review records using lib/multi-show-splitter.
 *
 * For each multi-show file:
 *   - Detect all show sections (≥500 chars each) via photo-credit anchor
 *     scanning + tailrun anchor matching against shows.json titles.
 *   - For the section that matches the file's OWN showId: rewrite the file's
 *     fullText to just that section, clear wrongShow flag (if set), set
 *     isMultiShowSplitParent=true.
 *   - For sections matching OTHER shows: write a parallel file at
 *     data/review-texts/{otherShowId}/{baseName} with sectionText as fullText
 *     and isMultiShowSplitChild=true. Skip if that file already exists.
 *
 * Idempotent: files with multiShowSplitProcessed already set are skipped on
 * subsequent runs.
 *
 * Usage:
 *   node scripts/split-multi-show-roundups.js              # dry-run (default), flagged files only
 *   node scripts/split-multi-show-roundups.js --scan-all   # dry-run, scan EVERY review file
 *   node scripts/split-multi-show-roundups.js --apply      # write changes (flagged-only)
 *   node scripts/split-multi-show-roundups.js --apply --scan-all
 *   node scripts/split-multi-show-roundups.js --show=ID    # one show only
 *
 * E2E sequence (manual until CI-wired):
 *   1. node scripts/split-multi-show-roundups.js --scan-all                    # dry-run audit
 *   2. node scripts/split-multi-show-roundups.js --scan-all --apply            # write child files
 *   3. cd data/review-texts && git add -A && git commit -m "split multi-show" && git push
 *   4. gh workflow run llm-ensemble-score.yml                                  # score new children
 *   5. gh workflow run rebuild-fast.yml                                        # land in reviews.json
 *   6. gh workflow run "Deploy to Vercel"                                      # publish
 *
 * Notion: 352637c5-416f-819c (multi-show roundup parser)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadShows } = require('./lib/multi-show-splitter');
const { applyMultiShowFanoutToFile } = require('./lib/multi-show-review-fanout');
const { listShowDirs: listShowDirsSafe } = require('./lib/list-show-dirs');

// ============================================================================
// CLI
// ============================================================================

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const VERBOSE = args.has('--verbose') || args.has('-v');
// --scan-all: run splitter against EVERY file, not just isMultiShowReview-flagged
// ones. Catches manually-ingested multi-show articles (e.g. /ingest UI brings
// in a Vulture roundup but doesn't auto-flag it). Slower (~14k files vs ~85).
const SCAN_ALL = args.has('--scan-all');
let onlyShow = null;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--show=')) onlyShow = a.slice(7);
}

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const shows = loadShows();
  if (!shows.length) {
    console.error('Error: failed to load shows.json');
    process.exit(2);
  }

  const showDirs = listShowDirs();
  if (onlyShow) {
    if (!showDirs.includes(onlyShow)) {
      console.error(`Error: show dir not found: ${onlyShow}`);
      process.exit(2);
    }
  }

  const targetDirs = onlyShow ? [onlyShow] : showDirs;
  const stats = {
    scanned: 0,
    flagged: 0,
    splittable: 0,
    parentsRewritten: 0,
    childrenCreated: 0,
    childrenSkippedExist: 0,
    alreadyProcessed: 0,
  };

  console.log(`${APPLY ? '[APPLY]' : '[DRY-RUN]'} ${SCAN_ALL ? '(scan-all)' : '(flagged-only)'} Scanning ${targetDirs.length} show dirs in ${REVIEW_TEXTS_DIR}`);
  if (!APPLY) console.log('  (no files will be written — pass --apply to write)');
  if (!SCAN_ALL) console.log('  (only files with isMultiShowReview=true — pass --scan-all to scan every file)');

  for (const showId of targetDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      stats.scanned++;
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      const isFlagged = data.isMultiShowReview === true;
      if (!isFlagged && !SCAN_ALL) continue;
      if (isFlagged) stats.flagged++;

      if (data.multiShowSplitProcessed) {
        stats.alreadyProcessed++;
        continue;
      }

      // BRO-4431: one implementation shared with collect-review-texts.js and
      // ingest-review-from-url.js (caption + intro strategies, child-stub fill).
      const fan = applyMultiShowFanoutToFile(filePath, { shows, reviewTextsDir: REVIEW_TEXTS_DIR, dryRun: !APPLY });
      if (!fan.applied) continue;

      stats.splittable++;
      stats.parentsRewritten++;
      console.log(`\n[${showId}/${file}] multi-show (${fan.strategy}): parent trimmed to own section`);
      for (const c of fan.children) {
        if (c.action === 'skip') {
          stats.childrenSkippedExist++;
          console.log(`  ✗ child exists, skip: ${c.showId}/${file}`);
        } else {
          stats.childrenCreated++;
          console.log(`  ✓ child ${c.action === 'fill' ? 'filled' : 'created'}: ${c.showId}/${file} (${c.chars} chars)`);
        }
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`isMultiShowReview=true: ${stats.flagged}`);
  console.log(`Already processed: ${stats.alreadyProcessed}`);
  console.log(`Splittable (≥2 valid sections): ${stats.splittable}`);
  console.log(`Parents rewritten: ${stats.parentsRewritten}`);
  console.log(`Children created: ${stats.childrenCreated}`);
  console.log(`Children skipped (already exist): ${stats.childrenSkippedExist}`);
  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to write changes.');
  } else if (stats.parentsRewritten || stats.childrenCreated) {
    console.log('\nReminder: data/review-texts is a separate private repo. Commit + push there:');
    console.log('  cd data/review-texts && git add -A && git commit -m "split multi-show roundups" && git push');
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function listShowDirs() {
  return listShowDirsSafe(REVIEW_TEXTS_DIR).filter(d => !d.startsWith('_')); // _pending etc.
}

main();
