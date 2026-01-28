#!/usr/bin/env node
/**
 * Backfill Original Scores
 *
 * Extracts original scores from:
 * 1. Archived HTML files in data/archives/reviews/
 * 2. Existing fullText in review JSON files
 * 3. Review excerpts (dtliExcerpt, bwwExcerpt, showScoreExcerpt)
 *
 * Usage:
 *   node scripts/backfill-original-scores.js [--dry-run] [--show=show-id]
 */

const fs = require('fs');
const path = require('path');
const { extractScore, extractDesignation } = require('./lib/score-extractors');

const DRY_RUN = process.argv.includes('--dry-run');
const SHOW_FILTER = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];

const REVIEW_DIR = 'data/review-texts';
const ARCHIVES_DIR = 'data/archives/reviews';

const stats = {
  totalReviews: 0,
  alreadyHadScore: 0,
  newScoresExtracted: 0,
  newDesignationsExtracted: 0,
  scoresFromArchive: 0,
  scoresFromFullText: 0,
  scoresFromExcerpt: 0,
  errors: 0,
  byOutlet: {},
};

/**
 * Find archived HTML for a review
 */
function findArchivedHtml(showId, outletId, criticName) {
  const archiveDir = path.join(ARCHIVES_DIR, showId);
  if (!fs.existsSync(archiveDir)) return null;

  // Generate possible filenames
  const outletSlug = (outletId || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const criticSlug = (criticName || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');

  const files = fs.readdirSync(archiveDir);

  // Try exact match first
  const exactPattern = `${outletSlug}--${criticSlug}`;
  let htmlFile = files.find(f => f.startsWith(exactPattern) && f.endsWith('.html'));

  // Try outlet-only match
  if (!htmlFile) {
    htmlFile = files.find(f => f.startsWith(`${outletSlug}--`) && f.endsWith('.html'));
  }

  if (htmlFile) {
    return fs.readFileSync(path.join(archiveDir, htmlFile), 'utf8');
  }

  return null;
}

/**
 * Process a single review file
 */
function processReview(filePath, showId) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    stats.totalReviews++;

    // Skip if already has originalScore
    if (data.originalScore) {
      stats.alreadyHadScore++;
      return false;
    }

    const outletId = data.outletId || path.basename(filePath).split('--')[0];
    const criticName = data.criticName || data.critic || 'unknown';

    // Try to find archived HTML
    const html = findArchivedHtml(showId, outletId, criticName);

    // Combine all text sources
    const textSources = [
      data.fullText || '',
      data.dtliExcerpt || '',
      data.bwwExcerpt || '',
      data.showScoreExcerpt || ''
    ].filter(t => t.length > 0);

    const combinedText = textSources.join('\n\n');

    // Try score extraction
    let scoreResult = null;
    let scoreSource = null;

    // Try HTML first (most reliable for structured data)
    if (html) {
      scoreResult = extractScore(html, '', outletId);
      if (scoreResult) scoreSource = 'archive';
    }

    // Try fullText
    if (!scoreResult && data.fullText && data.fullText.length > 200) {
      scoreResult = extractScore('', data.fullText, outletId);
      if (scoreResult) scoreSource = 'fullText';
    }

    // Try excerpts as last resort
    if (!scoreResult && combinedText.length > 50) {
      scoreResult = extractScore('', combinedText, outletId);
      if (scoreResult) scoreSource = 'excerpt';
    }

    // Track designation extraction separately
    let designation = null;
    if (!data.designation) {
      designation = extractDesignation(html || '', combinedText, outletId);
    }

    // Update if we found anything
    let updated = false;

    if (scoreResult) {
      stats.newScoresExtracted++;
      if (scoreSource === 'archive') stats.scoresFromArchive++;
      else if (scoreSource === 'fullText') stats.scoresFromFullText++;
      else stats.scoresFromExcerpt++;

      // Track by outlet
      if (!stats.byOutlet[outletId]) {
        stats.byOutlet[outletId] = { found: 0, total: 0 };
      }
      stats.byOutlet[outletId].found++;

      if (!DRY_RUN) {
        data.originalScore = scoreResult.originalScore;
        data.originalScoreNormalized = scoreResult.normalizedScore;
        data.scoreSource = scoreResult.source;
        data.scoreExtractedFrom = scoreSource;
      }
      updated = true;

      console.log(`  ✓ ${outletId}/${criticName}: ${scoreResult.originalScore} (${scoreResult.normalizedScore}/100) [${scoreSource}]`);
    }

    if (designation) {
      stats.newDesignationsExtracted++;

      if (!DRY_RUN) {
        data.designation = designation;
      }
      updated = true;

      console.log(`  ✓ ${outletId}/${criticName}: designation=${designation}`);
    }

    if (updated && !DRY_RUN) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    // Track outlet totals
    if (!stats.byOutlet[outletId]) {
      stats.byOutlet[outletId] = { found: 0, total: 0 };
    }
    stats.byOutlet[outletId].total++;

    return updated;

  } catch (e) {
    stats.errors++;
    console.error(`  ✗ Error processing ${filePath}: ${e.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  BACKFILL ORIGINAL SCORES                                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(DRY_RUN ? '(DRY RUN - no changes will be made)\n' : '\n');

  // Get all show directories
  let shows = fs.readdirSync(REVIEW_DIR).filter(f =>
    fs.statSync(path.join(REVIEW_DIR, f)).isDirectory()
  );

  if (SHOW_FILTER) {
    shows = shows.filter(s => s === SHOW_FILTER);
    console.log(`Filtering to show: ${SHOW_FILTER}\n`);
  }

  let updatedCount = 0;

  for (const show of shows.sort()) {
    const showDir = path.join(REVIEW_DIR, show);
    const files = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    if (files.length === 0) continue;

    console.log(`\n${show} (${files.length} reviews):`);

    for (const file of files) {
      const filePath = path.join(showDir, file);
      if (processReview(filePath, show)) {
        updatedCount++;
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total reviews scanned: ${stats.totalReviews}`);
  console.log(`Already had originalScore: ${stats.alreadyHadScore}`);
  console.log(`New scores extracted: ${stats.newScoresExtracted}`);
  console.log(`  - From archive HTML: ${stats.scoresFromArchive}`);
  console.log(`  - From fullText: ${stats.scoresFromFullText}`);
  console.log(`  - From excerpts: ${stats.scoresFromExcerpt}`);
  console.log(`New designations extracted: ${stats.newDesignationsExtracted}`);
  console.log(`Errors: ${stats.errors}`);

  // Top outlets with scores
  const outletResults = Object.entries(stats.byOutlet)
    .filter(([_, s]) => s.found > 0)
    .sort((a, b) => b[1].found - a[1].found)
    .slice(0, 15);

  if (outletResults.length > 0) {
    console.log('\nTop outlets with extracted scores:');
    for (const [outlet, s] of outletResults) {
      const pct = ((s.found / s.total) * 100).toFixed(1);
      console.log(`  ${outlet}: ${s.found}/${s.total} (${pct}%)`);
    }
  }

  if (DRY_RUN) {
    console.log('\n(DRY RUN - no files were modified)');
  } else {
    console.log(`\nUpdated ${updatedCount} review files.`);
  }
}

main().catch(console.error);
