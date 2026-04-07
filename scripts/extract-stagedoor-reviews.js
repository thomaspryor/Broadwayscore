#!/usr/bin/env node

/**
 * Extract reviews from Stagedoor critic archives into review-text files
 *
 * Reads: data/aggregator-archive/stagedoor/{show-id}.json
 * Writes: data/review-texts/{show-id}/{outletId}--{critic-slug}.json
 *
 * Follows the DTLI extraction pattern:
 * - normalizeOutlet() for canonical outlet IDs
 * - generateReviewFilename() for filenames
 * - findExistingReviewFile() for dedup/merge
 * - Never overwrites existing data with less content
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet: canonicalNormalizeOutlet,
  getOutletDisplayName,
  normalizeCritic,
  findExistingReviewFile,
  generateReviewFilename,
} = require('./lib/review-normalization');

const archiveDir = path.join(__dirname, '../data/aggregator-archive/stagedoor');
const outputDir = path.join(__dirname, '../data/review-texts');

// CLI args
const dryRun = process.argv.includes('--dry-run');
const showFilter = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];

/**
 * Save a review file, merging with existing if present.
 * Never overwrites existing data with strictly less content.
 */
function saveReview(review) {
  const showDir = path.join(outputDir, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const filename = generateReviewFilename(review.outletId, review.criticName);
  let filepath = path.join(showDir, filename);

  // Check for existing file (handles legacy outlet ID variants)
  const existingFile = findExistingReviewFile(showDir, review.outletId, review.criticName);
  if (existingFile && existingFile.data) {
    filepath = existingFile.path;
    const existing = existingFile.data;

    // Merge: preserve existing non-Stagedoor fields, update Stagedoor-specific ones
    review = {
      ...existing,
      // Update Stagedoor-specific fields
      stagedoorExcerpt: review.stagedoorExcerpt || existing.stagedoorExcerpt || null,
      originalScore: existing.originalScore || review.originalScore, // Don't overwrite existing P0 scores
      // Preserve all existing data
      fullText: existing.fullText || null,
      isFullReview: existing.isFullReview || false,
      dtliExcerpt: existing.dtliExcerpt || null,
      dtliThumb: existing.dtliThumb || null,
      showScoreExcerpt: existing.showScoreExcerpt || null,
      bwwExcerpt: existing.bwwExcerpt || null,
      bwwThumb: existing.bwwThumb || null,
      nycTheatreExcerpt: existing.nycTheatreExcerpt || null,
      lboRoundupExcerpt: existing.lboRoundupExcerpt || null,
      url: existing.url || review.url,
      publishDate: existing.publishDate || review.publishDate,
      assignedScore: existing.assignedScore || null,
      llmScore: existing.llmScore || null,
      llmMetadata: existing.llmMetadata || null,
      ensembleData: existing.ensembleData || null,
      source: existing.source || review.source,
    };
  }

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
  return filepath;
}

// Main
if (!fs.existsSync(archiveDir)) {
  console.error(`Stagedoor archive directory not found: ${archiveDir}`);
  process.exit(1);
}

const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
if (showFilter) {
  const filtered = files.filter(f => f.replace('.json', '') === showFilter);
  if (filtered.length === 0) {
    console.error(`Show not found in archives: ${showFilter}`);
    process.exit(1);
  }
  files.length = 0;
  files.push(...filtered);
}

console.log(`📰 Extracting Stagedoor critic reviews`);
console.log(`   Archives: ${files.length}`);
console.log(`   Dry run: ${dryRun}\n`);

let totalReviews = 0;
let totalShows = 0;
let newFiles = 0;
let mergedFiles = 0;
let unknownOutlets = [];

for (const file of files) {
  const archive = JSON.parse(fs.readFileSync(path.join(archiveDir, file), 'utf8'));
  const showId = archive.ourShowId;
  const reviews = archive.criticReviews || [];

  if (reviews.length === 0) continue;

  totalShows++;
  console.log(`[${totalShows}] ${archive.title} (${showId}) — ${reviews.length} critics`);

  for (const r of reviews) {
    // Normalize outlet name to canonical ID
    const outletId = canonicalNormalizeOutlet(r.outlet);
    const outletName = getOutletDisplayName(outletId) || r.outlet;

    if (outletId === 'unknown' || outletId === r.outlet.toLowerCase().replace(/\s+/g, '-')) {
      unknownOutlets.push(r.outlet);
    }

    // Stagedoor doesn't provide critic names — use null
    const criticName = null;

    const review = {
      showId,
      outletId,
      outlet: outletName,
      criticName,
      url: null, // Don't use aggregator URL — outlet URL must come from SERP/recollect
      stagedoorUrl: `https://stagedoor.com${archive.stagedoorUrl}`,
      publishDate: null, // Stagedoor doesn't provide review dates
      stagedoorExcerpt: r.excerpt || null,
      aggregatorStars: `${r.stars}/5 stars`, // Stagedoor's rating, not the outlet's own
      scoreSource: 'stagedoor-star-rating',
      fullText: null,
      isFullReview: false,
      assignedScore: null,
      source: 'stagedoor',
    };

    if (dryRun) {
      const existing = findExistingReviewFile(path.join(outputDir, showId), outletId, criticName);
      console.log(`  ${existing ? '🔄' : '🆕'} ${outletId} — ${r.stars}/5 — "${(r.excerpt || '').slice(0, 50)}..."`);
    } else {
      const existing = findExistingReviewFile(path.join(outputDir, showId), outletId, criticName);
      saveReview(review);
      if (existing) { mergedFiles++; } else { newFiles++; }
      console.log(`  ${existing ? '🔄' : '🆕'} ${outletId} — ${r.stars}/5`);
    }

    totalReviews++;
  }
}

console.log('\n─── Summary ───');
console.log(`  Shows:    ${totalShows}`);
console.log(`  Reviews:  ${totalReviews}`);
if (!dryRun) {
  console.log(`  New:      ${newFiles}`);
  console.log(`  Merged:   ${mergedFiles}`);
}

if (unknownOutlets.length > 0) {
  const unique = [...new Set(unknownOutlets)];
  console.log(`\n  ⚠️  Unknown outlets (${unique.length}) — may need adding to outlet-registry.json:`);
  unique.forEach(o => console.log(`     ${o}`));
}
