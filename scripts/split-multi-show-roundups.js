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
const { splitMultiShowArticle, loadShows } = require('./lib/multi-show-splitter');

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

  const showIdSet = new Set(shows.map(s => s.id));
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

      const text = data.fullText;
      if (!text || text.length < 800) continue;

      const sections = splitMultiShowArticle(text, shows);
      if (sections.length < 2) continue;

      // Filter to sections whose showId is in shows.json (sanity).
      const validSections = sections.filter(s => showIdSet.has(s.showId));
      if (validSections.length < 2) continue;

      stats.splittable++;
      console.log(`\n[${showId}/${file}] ${validSections.length} sections detected`);
      for (const sec of validSections) {
        console.log(`  - ${sec.showId} (${sec.showTitle}) ${sec.anchorKind} chars=${sec.sectionText.length}`);
      }

      const ownSection = validSections.find(s => s.showId === showId);
      const otherSections = validSections.filter(s => s.showId !== showId);

      // 1. Rewrite parent file's fullText to its own section (if found).
      if (ownSection) {
        const updated = rewriteParent(data, ownSection, otherSections.map(s => s.showId));
        if (APPLY) {
          fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n');
        }
        stats.parentsRewritten++;
        console.log(`  ✓ parent rewrite: fullText ${text.length}→${ownSection.sectionText.length} chars, ${data.wrongShow ? 'wrongShow cleared, ' : ''}children=${otherSections.length}`);
      } else {
        // No section for the file's own showId — the file is misattributed.
        // Still mark processed and keep wrongShow=true; the existing rejection
        // is correct.
        if (APPLY) {
          data.multiShowSplitProcessed = new Date().toISOString();
          data.multiShowSplitNote = 'no section for own showId — split skipped, file remains misattributed';
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
        console.log(`  ⚠ no section for own showId (${showId}) — parent left as-is; only siblings will be created`);
      }

      // 2. Create child files for other shows.
      for (const sec of otherSections) {
        const childDir = path.join(REVIEW_TEXTS_DIR, sec.showId);
        const childPath = path.join(childDir, file);

        // Don't overwrite an existing review for that show by the same critic.
        if (fs.existsSync(childPath)) {
          stats.childrenSkippedExist++;
          console.log(`  ✗ child exists, skip: ${sec.showId}/${file}`);
          continue;
        }

        const child = buildChild(data, sec, showId);
        if (APPLY) {
          fs.mkdirSync(childDir, { recursive: true });
          fs.writeFileSync(childPath, JSON.stringify(child, null, 2) + '\n');
        }
        stats.childrenCreated++;
        console.log(`  ✓ child created: ${sec.showId}/${file} (${sec.sectionText.length} chars)`);
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
  return fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    if (d.startsWith('_')) return false; // _pending etc.
    try {
      return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

function rewriteParent(data, ownSection, childShowIds) {
  const out = { ...data };
  out.fullText = ownSection.sectionText;
  out.wordCount = ownSection.sectionText.split(/\s+/).filter(Boolean).length;
  out.textWordCount = out.wordCount;
  out.multiShowSplitProcessed = new Date().toISOString();
  out.multiShowSplitParent = true;
  out.multiShowSplitChildShowIds = childShowIds;
  out.multiShowSplitAnchorKind = ownSection.anchorKind;
  out.multiShowSplitOriginalLength = (data.fullText || '').length;

  // Clear wrongShow if it was set for being a multi-show roundup — the file's
  // text is now just its own show's section. Preserve any manual review state.
  if (out.wrongShow === true && !out.wrongShowManualClear && !out.wrongShowOverride) {
    delete out.wrongShow;
    delete out.wrongShowReason;
    delete out.rejectedAt;
    delete out.rejectedBy;
    delete out.rejectionReason;
    delete out.rejectionReasoning;
    out.wrongShowClearedBy = 'multi-show-splitter';
    out.wrongShowClearedAt = new Date().toISOString();
  }

  // The file is now SINGLE-show after trimming — clear isMultiShowReview so
  // the LLM-scoring trim/skip path doesn't re-trim already-trimmed text.
  if (out.isMultiShowReview === true) {
    delete out.isMultiShowReview;
    delete out.multiShowReason;
    out.multiShowReviewClearedBy = 'multi-show-splitter';
  }

  // contentTier was likely 'invalid' from a wrongShow rejection — the trimmed
  // text is a valid single-show section now. Reset to 'complete' so rebuild
  // includes it. Only override invalid-with-wrong-show-reason — preserve
  // genuine 'truncated'/'stub'/manual-quality verdicts.
  if (out.contentTier === 'invalid' && /wrong\s*show|multi[\s-]?show/i.test(out.contentTierReason || '')) {
    out.contentTier = 'complete';
    out.contentTierReason = 'multi-show-split: trimmed to own show section';
  }

  // Always re-score after a split — the trimmed text is materially different
  // from whatever was scored before (or unscored).
  out.needsRescore = true;
  out.needsRescoreReason = 'multi-show-split: text trimmed to own section';
  // Clear any stale ensemble/llm scores derived from the un-trimmed text.
  delete out.ensembleData;
  delete out.llmScore;

  return out;
}

function buildChild(parentData, section, parentShowId) {
  const child = {
    showId: section.showId,
    outletId: parentData.outletId,
    outlet: parentData.outlet,
    criticName: parentData.criticName,
    url: parentData.url,
    publishDate: parentData.publishDate,
    fullText: section.sectionText,
    source: 'multi-show-split',
    contentTier: 'complete',
    contentTierReason: `Split from multi-show roundup originally filed under ${parentShowId}`,
    wordCount: section.sectionText.split(/\s+/).filter(Boolean).length,
    isFullReview: true,
    textStatus: 'complete',
    textQuality: 'full',
    multiShowSplitChild: true,
    multiShowSplitParentShowId: parentShowId,
    multiShowSplitAnchorKind: section.anchorKind,
    multiShowSplitProcessed: new Date().toISOString(),
    needsRescore: true,
    needsRescoreReason: 'multi-show-split: new child file, awaiting scoring',
  };
  child.textWordCount = child.wordCount;
  return child;
}

main();
