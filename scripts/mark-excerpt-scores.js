#!/usr/bin/env node
/**
 * Mark Excerpt-Based Scores
 *
 * This script identifies reviews that were scored using excerpts only (no fullText)
 * and marks them with appropriate metadata for tracking purposes.
 *
 * The LLM scoring system already handles excerpt-based scoring well, but this adds:
 * - textSource: "excerpt_ensemble" | "fullText" to clearly track source
 * - excerptOnlyScore: true flag for excerpt-scored reviews
 * - lowerConfidenceWeight: suggested weight reduction for scoring (optional)
 *
 * Usage:
 *   node scripts/mark-excerpt-scores.js            # Dry run (show what would change)
 *   node scripts/mark-excerpt-scores.js --apply    # Apply changes
 *   node scripts/mark-excerpt-scores.js --stats    # Just show statistics
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';

// Parse CLI arguments
const args = process.argv.slice(2);
const CLI = {
  apply: args.includes('--apply'),
  statsOnly: args.includes('--stats'),
};

// Statistics
const stats = {
  total: 0,
  hasLlmScore: 0,
  scoredOnFullText: 0,
  scoredOnExcerpts: 0,
  scoredOnMultipleExcerpts: 0,
  scoredOnSingleExcerpt: 0,
  alreadyMarked: 0,
  updated: 0,
};

/**
 * Process all review files
 */
function processReviews() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`Review texts directory not found: ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  const updates = [];

  for (const showId of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const filePath = path.join(showDir, file);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        stats.total++;

        // Skip reviews without LLM scores
        if (!data.llmScore) continue;
        stats.hasLlmScore++;

        // Determine text source
        const hasFullText = data.fullText && data.fullText.length > 500;
        const excerpts = [
          data.dtliExcerpt,
          data.bwwExcerpt,
          data.showScoreExcerpt
        ].filter(Boolean);

        if (hasFullText) {
          stats.scoredOnFullText++;

          // Mark as fullText source if not already marked
          if (data.textSource !== 'fullText') {
            data.textSource = 'fullText';
            data.excerptOnlyScore = false;
            updates.push({ filePath, data, type: 'fullText' });
          } else {
            stats.alreadyMarked++;
          }
        } else {
          stats.scoredOnExcerpts++;

          if (excerpts.length >= 2) {
            stats.scoredOnMultipleExcerpts++;
          } else {
            stats.scoredOnSingleExcerpt++;
          }

          // Mark as excerpt source if not already marked
          if (data.textSource !== 'excerpt_ensemble') {
            data.textSource = 'excerpt_ensemble';
            data.excerptOnlyScore = true;
            data.excerptCount = excerpts.length;
            data.combinedExcerptLength = excerpts.join(' ').length;

            // Optional: suggest reduced weight for single-excerpt scores
            if (excerpts.length === 1) {
              data.scoreWeightSuggestion = 0.8; // 80% weight
            } else {
              data.scoreWeightSuggestion = 0.9; // 90% weight for multi-excerpt
            }

            updates.push({ filePath, data, type: 'excerpt' });
          } else {
            stats.alreadyMarked++;
          }
        }
      } catch (e) {
        // Skip parse errors
      }
    }
  }

  return updates;
}

/**
 * Print statistics
 */
function printStats() {
  console.log('');
  console.log('='.repeat(60));
  console.log('EXCERPT-BASED SCORING STATISTICS');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Total review files:       ${stats.total}`);
  console.log(`With LLM scores:          ${stats.hasLlmScore}`);
  console.log('');
  console.log('Scored on fullText:       ' + stats.scoredOnFullText);
  console.log('Scored on excerpts:       ' + stats.scoredOnExcerpts);
  console.log('  - Multiple excerpts:    ' + stats.scoredOnMultipleExcerpts);
  console.log('  - Single excerpt:       ' + stats.scoredOnSingleExcerpt);
  console.log('');
  console.log('Already marked:           ' + stats.alreadyMarked);
  console.log('');

  // Calculate percentages
  if (stats.hasLlmScore > 0) {
    const fullTextPct = ((stats.scoredOnFullText / stats.hasLlmScore) * 100).toFixed(1);
    const excerptPct = ((stats.scoredOnExcerpts / stats.hasLlmScore) * 100).toFixed(1);
    console.log(`Score source breakdown:`);
    console.log(`  - fullText:    ${fullTextPct}%`);
    console.log(`  - excerpts:    ${excerptPct}%`);
  }
}

/**
 * Main function
 */
function main() {
  console.log('Mark Excerpt-Based Scores');
  console.log('='.repeat(60));

  const updates = processReviews();
  printStats();

  if (CLI.statsOnly) {
    return;
  }

  console.log('');
  console.log(`Files to update: ${updates.length}`);

  if (updates.length === 0) {
    console.log('No updates needed.');
    return;
  }

  if (!CLI.apply) {
    console.log('');
    console.log('DRY RUN - no files modified. Use --apply to save changes.');
    console.log('');
    console.log('Sample updates:');
    updates.slice(0, 5).forEach(u => {
      console.log(`  ${u.filePath} -> textSource: ${u.type}`);
    });
    return;
  }

  // Apply updates
  console.log('');
  console.log('Applying updates...');

  for (const update of updates) {
    try {
      fs.writeFileSync(update.filePath, JSON.stringify(update.data, null, 2));
      stats.updated++;
    } catch (e) {
      console.error(`Error writing ${update.filePath}: ${e.message}`);
    }
  }

  console.log(`Updated ${stats.updated} files.`);
}

main();
