#!/usr/bin/env node

/**
 * Post-Garbage Score Invalidation Script
 *
 * Finds reviews where:
 * 1. garbageFullText exists (garbage was detected AFTER scoring)
 * 2. llmScore exists (was scored based on the garbage text)
 *
 * These reviews need their LLM scores invalidated since the scores
 * were based on invalid content.
 *
 * Actions:
 * - Move llmScore to _invalidatedLlmScore
 * - If originalScoreNormalized exists, use that as assignedScore
 * - Otherwise, flag for manual review or excerpt-based rescoring
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose') || args.includes('-v');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Post-Garbage Score Invalidation Script

Usage: node fix-garbage-scores.js [options]

Options:
  --dry-run     Show what would change without making changes
  --verbose     Show detailed output
  --show=ID     Only process specific show
  --help        Show this help

This script finds reviews where LLM scores were based on garbage text
(404 pages, paywalls, etc.) and invalidates those scores.
`);
  process.exit(0);
}

/**
 * Check if garbageFullText contains ACTUAL garbage (404, paywall)
 * vs just being a short excerpt that was incorrectly flagged.
 * Short excerpts are OK - the LLM scored them as excerpts, which is valid.
 */
function isTrueGarbage(garbageText, garbageReason) {
  if (!garbageText) return false;

  const lower = garbageText.toLowerCase();
  const reason = (garbageReason || '').toLowerCase();

  // 404/Error page patterns
  const is404 = lower.includes('page not found') ||
                lower.includes('404') ||
                lower.includes('no longer exists') ||
                lower.includes('page you are looking for') ||
                lower.includes('doesn\'t exist') ||
                lower.includes('has been removed') ||
                lower.includes('content unavailable') ||
                reason.includes('error') ||
                reason.includes('404');

  // Paywall patterns (actual paywall pages, not just "subscriber" in footer)
  const isPaywall = (lower.includes('subscribe to continue') ||
                     lower.includes('sign in to continue') ||
                     lower.includes('subscribers only') ||
                     lower.includes('premium content') ||
                     lower.includes('paywall') ||
                     lower.includes('become a member to')) &&
                    garbageText.length < 2000; // Short paywall page, not full article with paywall footer

  // Multi-show detection (indicates 404/index page listing multiple shows)
  const multiShowPatterns = ['purlie', 'ghosts', 'stereophonic', 'cabaret', 'maybe happy ending'];
  const showsFound = multiShowPatterns.filter(s => lower.includes(s));
  const isMultiShow = showsFound.length >= 3;

  return is404 || isPaywall || isMultiShow;
}

function scanReviewFiles() {
  const results = {
    scanned: 0,
    trueGarbageWithLlmScore: [],     // Actual 404/paywall that was scored (NEED INVALIDATION)
    falsePositiveGarbage: [],         // Short excerpts incorrectly flagged (OK - LLM used excerpts)
    garbageWithValidLlmScore: [],     // LLM scored AFTER garbage fix with clean text (OK)
    garbageNoLlmScore: [],
    noGarbage: 0,
    fixed: 0,
    errors: []
  };

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
    const fullPath = path.join(REVIEW_TEXTS_DIR, f);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const showId of showDirs) {
    // Apply show filter if specified
    if (showFilter && showId !== showFilter) continue;

    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const reviewFiles = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    for (const filename of reviewFiles) {
      const filePath = path.join(showDir, filename);
      results.scanned++;

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        // Check if this review had garbage that was detected
        if (data.garbageFullText) {
          if (data.llmScore) {
            // Check if there's clean fullText now
            const hasCleanFullText = data.fullText && data.fullText.length > 100 &&
                                     data.fullText !== data.garbageFullText;

            if (hasCleanFullText) {
              // LLM was scored with clean text - OK
              results.garbageWithValidLlmScore.push({
                filePath, showId, filename,
                garbageReason: data.garbageReason,
                llmScore: data.llmScore.score
              });
            } else {
              // No clean fullText - was LLM shown true garbage or just excerpts?
              const trueGarbage = isTrueGarbage(data.garbageFullText, data.garbageReason);

              if (trueGarbage) {
                // ACTUAL garbage was scored - NEED INVALIDATION
                results.trueGarbageWithLlmScore.push({
                  filePath,
                  showId,
                  filename,
                  garbageReason: data.garbageReason,
                  garbageLength: data.garbageFullText.length,
                  llmScore: data.llmScore.score,
                  originalScoreNormalized: data.originalScoreNormalized,
                  hasExcerpts: !!(data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt),
                  garbageFixedAt: data.garbageFixedAt,
                  scoredAt: data.llmMetadata?.scoredAt
                });
              } else {
                // Short excerpt incorrectly flagged - LLM used excerpts, which is fine
                results.falsePositiveGarbage.push({
                  filePath, showId, filename,
                  garbageReason: data.garbageReason,
                  garbageLength: data.garbageFullText.length,
                  llmScore: data.llmScore.score
                });
              }
            }
          } else {
            results.garbageNoLlmScore.push({
              filePath, showId, filename,
              garbageReason: data.garbageReason
            });
          }
        } else {
          results.noGarbage++;
        }
      } catch (err) {
        results.errors.push({ filePath, error: err.message });
      }
    }
  }

  return results;
}

function invalidateScore(filePath, review) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Move llmScore to _invalidatedLlmScore
  data._invalidatedLlmScore = {
    ...data.llmScore,
    invalidatedReason: data.garbageReason || 'Garbage text detected after scoring',
    invalidatedAt: new Date().toISOString()
  };
  delete data.llmScore;

  // Also invalidate ensembleData if present
  if (data.ensembleData) {
    data._invalidatedEnsembleData = {
      ...data.ensembleData,
      invalidatedAt: new Date().toISOString()
    };
    delete data.ensembleData;
  }

  // If we have an explicit original score, use that
  if (data.originalScoreNormalized !== null && data.originalScoreNormalized !== undefined) {
    data.assignedScore = data.originalScoreNormalized;
    data.scoreSource = 'explicit-after-garbage-invalidation';
    if (verbose) {
      console.log(`    Using explicit score: ${data.originalScoreNormalized}`);
    }
  } else if (review.hasExcerpts) {
    // Flag for excerpt-based rescoring
    data.needsRescore = true;
    data.rescoreReason = 'LLM score invalidated (based on garbage text), excerpts available';
    if (verbose) {
      console.log(`    Flagged for rescore (has excerpts)`);
    }
  } else {
    // No explicit score, no excerpts - needs manual review
    data.needsManualReview = true;
    data.manualReviewReason = 'LLM score invalidated (based on garbage text), no excerpts available';
    if (verbose) {
      console.log(`    Flagged for manual review (no excerpts)`);
    }
  }

  // Save updated file
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function main() {
  console.log('Post-Garbage Score Invalidation Script');
  console.log('=====================================\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  const results = scanReviewFiles();

  console.log(`Scanned ${results.scanned} review files\n`);

  if (results.errors.length > 0) {
    console.log(`Errors reading ${results.errors.length} files:`);
    for (const err of results.errors.slice(0, 5)) {
      console.log(`  ${err.filePath}: ${err.error}`);
    }
    if (results.errors.length > 5) {
      console.log(`  ... and ${results.errors.length - 5} more`);
    }
    console.log('');
  }

  console.log('Summary:');
  console.log(`  ${results.trueGarbageWithLlmScore.length} reviews with TRUE garbage scores (404/paywall) - NEED INVALIDATION`);
  console.log(`  ${results.falsePositiveGarbage.length} reviews with false positive "garbage" (short excerpts) - OK, scored on excerpts`);
  console.log(`  ${results.garbageWithValidLlmScore.length} reviews with garbage REPLACED by clean text - OK`);
  console.log(`  ${results.garbageNoLlmScore.length} reviews with garbage but no LLM score`);
  console.log(`  ${results.noGarbage} reviews without garbage text\n`);

  if (results.trueGarbageWithLlmScore.length === 0) {
    console.log('No reviews need score invalidation. All LLM scores are valid.');
    return;
  }

  console.log('Reviews needing score invalidation:');
  console.log('-----------------------------------');

  for (const review of results.trueGarbageWithLlmScore) {
    console.log(`\n${review.showId}/${review.filename}`);
    console.log(`  Garbage reason: ${review.garbageReason}`);
    console.log(`  Garbage length: ${review.garbageLength} chars`);
    console.log(`  Invalid LLM score: ${review.llmScore}`);
    if (review.garbageFixedAt) console.log(`  Garbage fixed at: ${review.garbageFixedAt}`);
    if (review.scoredAt) console.log(`  Scored at: ${review.scoredAt}`);
    console.log(`  Explicit score: ${review.originalScoreNormalized ?? 'none'}`);
    console.log(`  Has excerpts: ${review.hasExcerpts ? 'yes' : 'no'}`);

    if (!dryRun) {
      invalidateScore(review.filePath, review);
      results.fixed++;
      console.log(`  -> INVALIDATED`);
    } else {
      console.log(`  -> Would invalidate (dry run)`);
    }
  }

  console.log('\n-----------------------------------');
  if (dryRun) {
    console.log(`\nDry run complete. ${results.trueGarbageWithLlmScore.length} reviews would be fixed.`);
    console.log('Run without --dry-run to apply changes.');
  } else {
    console.log(`\nFixed ${results.fixed} reviews.`);
  }

  // Summary by action
  const hasExplicit = r => r.originalScoreNormalized !== null && r.originalScoreNormalized !== undefined;
  const noExplicit = r => r.originalScoreNormalized === null || r.originalScoreNormalized === undefined;

  const withExplicit = results.trueGarbageWithLlmScore.filter(hasExplicit);
  const needsRescore = results.trueGarbageWithLlmScore.filter(r => noExplicit(r) && r.hasExcerpts);
  const needsManual = results.trueGarbageWithLlmScore.filter(r => noExplicit(r) && !r.hasExcerpts);

  console.log('\nBreakdown:');
  console.log(`  ${withExplicit.length} will use explicit critic scores`);
  console.log(`  ${needsRescore.length} need excerpt-based rescore (no explicit score)`);
  console.log(`  ${needsManual.length} need manual review (no explicit score, no excerpts)`);
}

main();
