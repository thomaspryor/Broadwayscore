#!/usr/bin/env node
/**
 * Fix critic name duplicates
 *
 * Merges review files where we have duplicates like:
 *   - nytimes--jesse-green.json and nytimes--jesse.json (same review)
 *   - nypost--johnny-oleksinski.json and nypost--johnny.json (same review)
 *
 * Strategy:
 *   1. Keep the canonical file (full name version)
 *   2. Merge data from the partial name version (keep fullText, scores if better)
 *   3. Delete the partial name file
 *
 * Usage:
 *   node scripts/fix-critic-name-duplicates.js --dry-run
 *   node scripts/fix-critic-name-duplicates.js
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Known critic name variations to merge
// Format: { canonical: 'full-name', variants: ['partial-name', ...] }
const CRITIC_VARIANTS = {
  'jesse-green': ['jesse'],
  'johnny-oleksinski': ['johnny', 'johnny-oleksinki'],
  'allison-considine': ['allison'],
  'charles-isherwood': ['charles'],
  'chris-jones': ['chris'],
  'maya-phillips': ['maya'],
  'sara-holdren': ['sara'],
  'emlyn-travis': ['emlyn'],
  'matt-windman': ['matt'],
  'adam-feldman': ['adam'],
  'helen-shaw': ['helen'],
  'jackson-mchenry': ['jackson'],
  'robert-hofler': ['robert'],
  'frank-scheck': ['frank'],
  'thom-geier': ['thom'],
  'david-rooney': ['david'],
  'alexis-soloski': ['alexis'],
  'elysa-gardner': ['elysa'],
  'brian-scott-lipton': ['brain-scott-lipton', 'brian'], // Note: typo variant
  'victor-gluck': ['victor'],
  'joseph-pisano': ['joseph'],
  'diana-snyder': ['diana', 'diane-snyder', 'diane'],
  'greg-evans': ['greg'],
  'shania-russell': ['shania']
};

// Build reverse lookup
const VARIANT_TO_CANONICAL = {};
for (const [canonical, variants] of Object.entries(CRITIC_VARIANTS)) {
  for (const variant of variants) {
    VARIANT_TO_CANONICAL[variant] = canonical;
  }
}

function mergeReviewData(canonicalData, variantData) {
  const merged = { ...canonicalData };

  // Prefer fullText from whichever has it (or longer one)
  if (!merged.fullText && variantData.fullText) {
    merged.fullText = variantData.fullText;
    merged.isFullReview = variantData.isFullReview;
    merged.textWordCount = variantData.textWordCount;
    merged.textFetchedAt = variantData.textFetchedAt;
    merged.fetchMethod = variantData.fetchMethod;
  } else if (merged.fullText && variantData.fullText) {
    if (variantData.fullText.length > merged.fullText.length) {
      merged.fullText = variantData.fullText;
      merged.isFullReview = variantData.isFullReview;
      merged.textWordCount = variantData.textWordCount;
      merged.textFetchedAt = variantData.textFetchedAt;
      merged.fetchMethod = variantData.fetchMethod;
    }
  }

  // Prefer llmScore if canonical doesn't have one
  if (!merged.llmScore && variantData.llmScore) {
    merged.llmScore = variantData.llmScore;
    merged.llmMetadata = variantData.llmMetadata;
    merged.ensembleData = variantData.ensembleData;
  }

  // Prefer assignedScore if canonical doesn't have one
  if (merged.assignedScore == null && variantData.assignedScore != null) {
    merged.assignedScore = variantData.assignedScore;
  }

  // Merge excerpts
  const excerptFields = ['dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt'];
  for (const field of excerptFields) {
    if (!merged[field] && variantData[field]) {
      merged[field] = variantData[field];
    }
  }

  // Merge thumbs
  const thumbFields = ['dtliThumb', 'bwwThumb'];
  for (const field of thumbFields) {
    if (!merged[field] && variantData[field]) {
      merged[field] = variantData[field];
    }
  }

  // Use better URL if variant has one and canonical doesn't
  if (!merged.url && variantData.url) {
    merged.url = variantData.url;
  }

  // Track that we merged
  merged.mergedFrom = merged.mergedFrom || [];
  merged.mergedFrom.push({
    filename: variantData._sourceFilename,
    mergedAt: new Date().toISOString()
  });

  return merged;
}

function findDuplicatePairs(showDir) {
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  const pairs = [];

  // Group files by outlet
  const byOutlet = {};
  for (const file of files) {
    const match = file.match(/^([^-]+)--(.+)\.json$/);
    if (match) {
      const [, outlet, critic] = match;
      if (!byOutlet[outlet]) byOutlet[outlet] = [];
      byOutlet[outlet].push({ file, critic });
    }
  }

  // Find pairs where one critic is a variant of another
  for (const [outlet, reviews] of Object.entries(byOutlet)) {
    for (const review of reviews) {
      const canonical = VARIANT_TO_CANONICAL[review.critic];
      if (canonical) {
        // This is a variant - look for the canonical version
        const canonicalReview = reviews.find(r => r.critic === canonical);
        if (canonicalReview) {
          pairs.push({
            outlet,
            canonical: canonicalReview,
            variant: review
          });
        }
      }
    }
  }

  return pairs;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING FIXES ===');
  console.log('');

  const stats = {
    showsChecked: 0,
    pairsFound: 0,
    merged: 0,
    errors: []
  };

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    stats.showsChecked++;

    const pairs = findDuplicatePairs(showDir);
    if (pairs.length === 0) continue;

    console.log(`\n${show}:`);

    for (const pair of pairs) {
      stats.pairsFound++;

      const canonicalPath = path.join(showDir, pair.canonical.file);
      const variantPath = path.join(showDir, pair.variant.file);

      try {
        const canonicalData = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
        const variantData = JSON.parse(fs.readFileSync(variantPath, 'utf8'));
        variantData._sourceFilename = pair.variant.file;

        // Check if they have the same URL (definitely same review)
        const sameUrl = canonicalData.url && variantData.url &&
          canonicalData.url.split('?')[0] === variantData.url.split('?')[0];

        // Check if either has fullText
        const canonicalHasText = canonicalData.fullText && canonicalData.fullText.length > 200;
        const variantHasText = variantData.fullText && variantData.fullText.length > 200;

        console.log(`  ${pair.outlet}--${pair.variant.critic}.json -> ${pair.canonical.critic}`);
        console.log(`    Same URL: ${sameUrl ? 'YES' : 'NO'}`);
        console.log(`    Canonical has fullText: ${canonicalHasText ? 'YES' : 'NO'} (${canonicalData.fullText?.length || 0} chars)`);
        console.log(`    Variant has fullText: ${variantHasText ? 'YES' : 'NO'} (${variantData.fullText?.length || 0} chars)`);

        if (!dryRun) {
          const merged = mergeReviewData(canonicalData, variantData);
          fs.writeFileSync(canonicalPath, JSON.stringify(merged, null, 2));
          fs.unlinkSync(variantPath);
          console.log(`    -> Merged and deleted variant`);
        } else {
          console.log(`    -> WOULD merge and delete variant`);
        }

        stats.merged++;
      } catch (err) {
        console.log(`  ERROR: ${pair.variant.file} - ${err.message}`);
        stats.errors.push({ show, file: pair.variant.file, error: err.message });
      }
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Shows checked: ${stats.showsChecked}`);
  console.log(`Duplicate pairs found: ${stats.pairsFound}`);
  console.log(`Merged: ${stats.merged}`);
  console.log(`Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors:');
    stats.errors.forEach(e => console.log(`  - ${e.show}/${e.file}: ${e.error}`));
  }
}

main();
