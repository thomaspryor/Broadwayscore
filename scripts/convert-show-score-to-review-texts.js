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
  generateReviewFilename,
  getOutletDisplayName,
  resolveOutletFromCritic,
  resolveOutletFromUrl,
} = require('./lib/review-normalization');

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

      const outletId = normalizeOutlet(resolvedOutlet);
      const criticId = normalizeCritic(review.author || 'unknown');

      // Check for existing file using fuzzy matching (handles alias differences)
      const existing = findExistingReviewFile(showDir, resolvedOutlet, review.author);

      if (existing) {
        // Existing file found — enrich with showScoreExcerpt if missing
        if (!existing.data.showScoreExcerpt && review.excerpt) {
          existing.data.showScoreExcerpt = review.excerpt;
          existing.data.showScoreUrl = data.showScoreUrl;
          if (!existing.data.url && review.url) {
            existing.data.url = review.url;
          }
          fs.writeFileSync(existing.path, JSON.stringify(existing.data, null, 2));
          totalUpdated++;
        } else {
          totalSkipped++;
        }
        continue;
      }

      // No existing file — create new one
      if (!fs.existsSync(showDir)) {
        fs.mkdirSync(showDir, { recursive: true });
      }

      const filename = generateReviewFilename(resolvedOutlet, review.author || 'unknown');
      const filePath = path.join(showDir, filename);

      const reviewData = {
        showId,
        outletId,
        outlet: getOutletDisplayName(outletId) || resolvedOutlet,
        criticName: review.author || null,
        url: review.url || null,
        publishDate: review.date || null,
        fullText: null,
        isFullReview: false,
        showScoreExcerpt: review.excerpt || null,
        showScoreUrl: data.showScoreUrl,
        originalScore: null,
        assignedScore: null,
        source: 'show-score',
        dtliThumb: null
      };

      fs.writeFileSync(filePath, JSON.stringify(reviewData, null, 2));
      console.log(`  Created: ${filename}`);
      totalCreated++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Created: ${totalCreated}`);
  console.log(`Updated (added excerpt): ${totalUpdated}`);
  console.log(`Skipped (already exists): ${totalSkipped}`);
}

main();
