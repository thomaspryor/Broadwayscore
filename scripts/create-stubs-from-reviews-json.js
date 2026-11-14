#!/usr/bin/env node
/**
 * Create stub review-text files for reviews that exist in reviews.json
 * but have no corresponding file in data/review-texts/.
 *
 * This enables the URL rediscovery pipeline to find URLs for these reviews
 * and the wayback recovery pipeline to fetch their content.
 *
 * Usage:
 *   node scripts/create-stubs-from-reviews-json.js [options]
 *
 * Environment variables:
 *   OUTLET_FILTER=x,y     Only process specific outlets (comma-separated outletIds)
 *   DRY_RUN=true          Show what would be created, don't write
 *   MAX_STUBS=100         Limit number of stubs to create
 */

const fs = require('fs');
const path = require('path');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { findExistingReviewFile, generateReviewFilename } = require('./lib/review-normalization');

const CONFIG = {
  reviewsJsonPath: path.join(__dirname, '..', 'data', 'reviews.json'),
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  outletFilter: process.env.OUTLET_FILTER ? process.env.OUTLET_FILTER.split(',').map(s => s.trim().toLowerCase()) : [],
  dryRun: process.env.DRY_RUN === 'true',
  maxStubs: parseInt(process.env.MAX_STUBS || '0') || Infinity,
};

function main() {
  console.log('Creating stub review-text files from reviews.json...\n');

  const reviewsData = JSON.parse(fs.readFileSync(CONFIG.reviewsJsonPath, 'utf8'));
  const reviews = reviewsData.reviews || [];
  console.log(`  Total reviews in reviews.json: ${reviews.length}`);

  if (CONFIG.outletFilter.length > 0) {
    console.log(`  Outlet filter: ${CONFIG.outletFilter.join(', ')}`);
  }

  let created = 0, skippedExists = 0, skippedFiltered = 0, skippedGuarded = 0;
  const byOutlet = {};

  for (const review of reviews) {
    if (!review.showId) continue;

    // Apply outlet filter
    const outletId = (review.outletId || '').toLowerCase();
    const outlet = (review.outlet || '').toLowerCase();
    if (CONFIG.outletFilter.length > 0) {
      const matches = CONFIG.outletFilter.some(f =>
        outletId.includes(f) || outlet.includes(f)
      );
      if (!matches) { skippedFiltered++; continue; }
    }

    // Check limit
    if (created >= CONFIG.maxStubs) break;

    // Skip when a file already exists under the review's OWN outlet identity.
    // The shared writer's URL-based outlet refinement can re-home the identity
    // (e.g. an AP wire review with an abcnews.go.com URL → 'abc-news'), which
    // would CREATE a duplicate stub next to the existing ap--*.json file.
    // Two checks: fuzzy variant match, AND the exact generated filename —
    // findExistingReviewFile skips flagged files (wrongProduction/duplicateOf),
    // and a stub must never be recreated beside its flagged original.
    // Read-only pre-checks; all writes still route through
    // createOrMergeReviewFile below.
    const showDir = path.join(CONFIG.reviewTextsDir, review.showId);
    const exactName = generateReviewFilename(review.outlet || review.outletId, review.criticName);
    if (fs.existsSync(path.join(showDir, exactName)) ||
        findExistingReviewFile(showDir, review.outlet || review.outletId, review.criticName || null)) {
      skippedExists++;
      continue;
    }

    // Determine incomplete reason
    let incompleteReason = 'no_text';
    if (!review.url) incompleteReason = 'no_url';

    // Route through the shared save-time chokepoint (card 38b637c5) so every
    // guard applies (junk/unregistered outlet, domain validation, cross-market
    // reroute, cross-show URL ownership, sanitizeCriticName). onMerge aborts on
    // any existing file — this script only CREATES stubs, never enriches
    // (previous fs.existsSync skip, now with fuzzy variant matching).
    const res = createOrMergeReviewFile(review.showId, {
      outlet: review.outlet || review.outletId,
      criticName: review.criticName || 'Unknown',
      url: review.url || null,
      source: 'stub-from-reviews-json',
      fields: {
        publishDate: review.publishDate || null,
        incompleteReason,
        fullText: '',
        contentTier: 'stub',
        createdAt: new Date().toISOString(),
      },
    }, { dryRun: CONFIG.dryRun, reviewTextsDir: CONFIG.reviewTextsDir, onMerge: () => false });

    if (res.action !== 'new') {
      if (res.reason === 'onMerge-aborted' || res.reason === 'no-changes') skippedExists++;
      else { skippedGuarded++; if (CONFIG.dryRun) console.log(`  [GUARD] ${review.showId} ${review.outlet || review.outletId}: ${res.reason}`); }
      continue;
    }

    // Cross-market reroute can land the stub under a sibling show — surface it
    // so the summary can't silently mask a still-missing file for THIS show.
    if (res.filepath && !res.filepath.includes(`/${review.showId}/`)) {
      console.log(`  [REROUTED] ${review.showId} → ${path.basename(path.dirname(res.filepath))}/${path.basename(res.filepath)}`);
    }
    if (CONFIG.dryRun) {
      console.log(`  [DRY] Would create: ${review.showId}/${path.basename(res.filepath || '')}`);
    }

    created++;
    const key = review.outlet || review.outletId || 'unknown';
    byOutlet[key] = (byOutlet[key] || 0) + 1;
  }

  console.log(`\n  Created: ${created} stub files`);
  console.log(`  Skipped (exists): ${skippedExists}`);
  console.log(`  Skipped (filtered): ${skippedFiltered}`);
  console.log(`  Skipped (write guards): ${skippedGuarded}`);
  console.log('\n  By outlet:');
  Object.entries(byOutlet).sort((a, b) => b[1] - a[1]).forEach(([o, c]) => {
    console.log(`    ${o}: ${c}`);
  });

  if (CONFIG.dryRun) console.log('\n  *** DRY RUN — no files written ***');
}

main();
