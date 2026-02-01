#!/usr/bin/env node

/**
 * Migrate Review Content Tiers
 *
 * Updates all review files to use the new 5-tier content taxonomy:
 * - T1: complete  - Full review successfully scraped
 * - T2: truncated - Partial text due to paywall/bot detection
 * - T3: excerpt   - Only aggregator quotes available
 * - T4: stub      - Has metadata but no text content
 * - T5: invalid   - Garbage/wrong show/corrupted
 *
 * This replaces the confusing textQuality/textStatus/isFullReview fields
 * with a single authoritative contentTier field.
 *
 * Usage:
 *   node scripts/migrate-content-tiers.js [--dry-run] [--show=show-id]
 */

const fs = require('fs');
const path = require('path');
const { classifyContentTier, countWords } = require('./lib/content-quality');

const REVIEW_TEXTS_DIR = 'data/review-texts';

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];

function loadAllReviews() {
  const reviews = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  for (const showId of showDirs) {
    if (showFilter && showId !== showFilter) continue;

    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const filepath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        reviews.push({
          ...data,
          _filepath: filepath,
          _showId: showId,
          _filename: file
        });
      } catch (e) {
        console.error(`Error reading ${filepath}:`, e.message);
      }
    }
  }

  return reviews;
}

function migrateReview(review) {
  // Classify into new tier
  const classification = classifyContentTier(review);

  // Build the updated review
  const updated = { ...review };

  // Add new fields
  updated.contentTier = classification.contentTier;
  updated.wordCount = classification.wordCount;

  // Keep truncationSignals if there are any (useful for debugging)
  if (classification.truncationSignals.length > 0) {
    updated.truncationSignals = classification.truncationSignals;
  } else {
    delete updated.truncationSignals;
  }

  // Remove deprecated fields (but keep for now as _deprecated_* for safety)
  const deprecatedFields = ['textQuality', 'textStatus', 'isFullReview', 'textWordCount'];
  for (const field of deprecatedFields) {
    if (updated[field] !== undefined) {
      // Store old value for reference during transition
      // updated[`_deprecated_${field}`] = updated[field];
      delete updated[field];
    }
  }

  // Remove internal fields before saving
  delete updated._filepath;
  delete updated._showId;
  delete updated._filename;

  return {
    updated,
    changes: {
      contentTier: classification.contentTier,
      tierReason: classification.tierReason,
      wordCount: classification.wordCount
    }
  };
}

function main() {
  console.log('Content Tier Migration');
  console.log('======================');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  if (showFilter) console.log(`Filter: ${showFilter}`);
  console.log('');

  const reviews = loadAllReviews();
  console.log(`Loaded ${reviews.length} reviews\n`);

  // Track statistics
  const stats = {
    complete: 0,
    truncated: 0,
    excerpt: 0,
    stub: 0,
    invalid: 0
  };

  const tierExamples = {
    complete: [],
    truncated: [],
    excerpt: [],
    stub: [],
    invalid: []
  };

  let updated = 0;

  for (const review of reviews) {
    const { updated: newReview, changes } = migrateReview(review);

    stats[changes.contentTier]++;

    // Store examples (up to 3 per tier)
    if (tierExamples[changes.contentTier].length < 3) {
      tierExamples[changes.contentTier].push({
        file: review._filename,
        show: review._showId,
        reason: changes.tierReason,
        wordCount: changes.wordCount
      });
    }

    // Write the updated file
    if (!dryRun) {
      fs.writeFileSync(review._filepath, JSON.stringify(newReview, null, 2) + '\n');
    }
    updated++;
  }

  // Print results
  console.log('Tier Distribution:');
  console.log('------------------');
  console.log(`  T1 complete:  ${stats.complete.toString().padStart(5)} (${(stats.complete / reviews.length * 100).toFixed(1)}%)`);
  console.log(`  T2 truncated: ${stats.truncated.toString().padStart(5)} (${(stats.truncated / reviews.length * 100).toFixed(1)}%)`);
  console.log(`  T3 excerpt:   ${stats.excerpt.toString().padStart(5)} (${(stats.excerpt / reviews.length * 100).toFixed(1)}%)`);
  console.log(`  T4 stub:      ${stats.stub.toString().padStart(5)} (${(stats.stub / reviews.length * 100).toFixed(1)}%)`);
  console.log(`  T5 invalid:   ${stats.invalid.toString().padStart(5)} (${(stats.invalid / reviews.length * 100).toFixed(1)}%)`);
  console.log('');

  console.log('Examples per tier:');
  console.log('------------------');
  for (const [tier, examples] of Object.entries(tierExamples)) {
    if (examples.length > 0) {
      console.log(`\n${tier.toUpperCase()}:`);
      for (const ex of examples) {
        console.log(`  - ${ex.show}/${ex.file}`);
        console.log(`    ${ex.reason} (${ex.wordCount} words)`);
      }
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`Would update ${updated} files. Run without --dry-run to apply changes.`);
  } else {
    console.log(`Updated ${updated} files.`);
  }

  // Write summary to audit file
  const summary = {
    migrationDate: new Date().toISOString(),
    totalReviews: reviews.length,
    distribution: stats,
    percentages: {
      complete: (stats.complete / reviews.length * 100).toFixed(1) + '%',
      truncated: (stats.truncated / reviews.length * 100).toFixed(1) + '%',
      excerpt: (stats.excerpt / reviews.length * 100).toFixed(1) + '%',
      stub: (stats.stub / reviews.length * 100).toFixed(1) + '%',
      invalid: (stats.invalid / reviews.length * 100).toFixed(1) + '%'
    },
    examples: tierExamples
  };

  if (!dryRun) {
    fs.mkdirSync('data/audit', { recursive: true });
    fs.writeFileSync(
      'data/audit/content-tier-migration.json',
      JSON.stringify(summary, null, 2)
    );
    console.log('\nSummary written to data/audit/content-tier-migration.json');
  }
}

main();
