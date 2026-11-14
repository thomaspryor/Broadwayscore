#!/usr/bin/env node
/**
 * Convert Show Score extracted data to review-text files
 *
 * This takes the critic reviews from show-score.json and creates
 * individual review files in data/review-texts/{show-id}/
 *
 * Uses the canonical normalizeOutlet/normalizeCritic from review-normalization.js
 * to avoid creating duplicate files with non-standard outlet IDs.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  findExistingReviewFile,
  getOutletDisplayName,
  resolveOutletFromCritic,
  resolveOutletFromUrl,
} = require('./lib/review-normalization');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');

const showScorePath = path.join(__dirname, '../data/show-score.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts');

function main() {
  console.log('Converting Show Score data to review-text files...\n');

  if (!fs.existsSync(showScorePath)) {
    console.log('ERROR: show-score.json not found. Run extract-show-score-reviews.js first.');
    process.exit(1);
  }

  const showScoreData = JSON.parse(fs.readFileSync(showScorePath, 'utf8'));
  const shows = showScoreData.shows || {};

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;

  for (const [showId, data] of Object.entries(shows)) {
    if (!data.criticReviews || data.criticReviews.length === 0) {
      continue;
    }

    console.log(`Processing: ${showId} (${data.criticReviews.length} critic reviews)`);

    const showDir = path.join(reviewTextsDir, showId);

    for (const review of data.criticReviews) {
      let resolvedOutlet = review.outlet;

      // If outlet is null/empty, try to resolve from critic registry or URL
      if (!resolvedOutlet) {
        // Strategy 1: Look up critic in registry to find their primary outlet
        if (review.author) {
          const resolved = resolveOutletFromCritic(review.author);
          if (resolved) {
            resolvedOutlet = resolved.displayName;
            console.log(`  Resolved outlet from critic "${review.author}": ${resolvedOutlet}${resolved.isFreelancer ? ' (freelancer)' : ''}`);
          }
        }

        // Strategy 2: Try to resolve outlet from the review URL domain
        if (!resolvedOutlet && review.url) {
          const urlResolved = resolveOutletFromUrl(review.url);
          if (urlResolved) {
            resolvedOutlet = urlResolved.displayName;
            console.log(`  Resolved outlet from URL "${review.url}": ${resolvedOutlet}`);
          }
        }

        // If still null, skip — but log a warning so we know about it
        if (!resolvedOutlet) {
          const criticInfo = review.author ? ` (critic: ${review.author})` : '';
          const urlInfo = review.url ? ` (url: ${review.url})` : '';
          console.warn(`  WARNING: Skipping review with null outlet${criticInfo}${urlInfo} — not in critic registry`);
          totalSkipped++;
          continue;
        }
      }

      // Convert star rating to aggregatorStars (Show Score stars are aggregator data, not outlet-direct)
      let aggregatorStars = null;
      if (review.starRating != null) {
        if (review.starRating > 5) {
          aggregatorStars = `${review.starRating}/100`;
        } else {
          aggregatorStars = `${review.starRating}/${review.starMax || 5}`;
        }
      }

      // Pre-state read (read-only): the shared writer's default merge sets a
      // field whenever the stored value is falsy, but this importer's original
      // contract is stricter — aggregator stars must never land on a file that
      // already carries an outlet-direct originalScore. Capture the pre-state
      // and include the star fields only when the original conditions hold.
      const preExisting = findExistingReviewFile(showDir, resolvedOutlet, review.author);
      const starsAllowed = aggregatorStars != null && (
        !preExisting || (!preExisting.data.aggregatorStars && !preExisting.data.originalScore)
      );

      // Route through the shared save-time chokepoint (card 38b637c5) so every
      // guard applies (junk outlet, domain validation, cross-market reroute,
      // cross-show URL ownership, roundup detection, URL-change invariant).
      // Merge path = the writer's default field merge (fills empty fields,
      // upgrades URL under the cross-show guard) — same enrichment contract as
      // the old inline code, with guards.
      const res = createOrMergeReviewFile(showId, {
        outlet: resolvedOutlet,
        criticName: review.author || 'Unknown',
        url: review.url || null,
        source: 'show-score',
        fields: {
          publishDate: review.date || null,
          showScoreExcerpt: review.excerpt || null,
          showScoreUrl: data.showScoreUrl,
          ...(starsAllowed ? { aggregatorStars, scoreSource: 'show-score-stars' } : {}),
          ...(preExisting ? {} : { fullText: null, isFullReview: false, originalScore: null, assignedScore: null, dtliThumb: null }),
        },
      }, { reviewTextsDir });

      if (res.action === 'new') {
        console.log(`  Created: ${path.basename(res.filepath || '')}`);
        totalCreated++;
      } else if (res.action === 'updated') {
        totalUpdated++;
      } else {
        totalSkipped++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Created: ${totalCreated}`);
  console.log(`Updated (added excerpt): ${totalUpdated}`);
  console.log(`Skipped (already exists): ${totalSkipped}`);
}

if (require.main === module) {
  main();
}
