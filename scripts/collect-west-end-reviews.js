#!/usr/bin/env node
/**
 * West End Review Collection
 *
 * Creates review-text files from a pre-gathered JSON input file.
 * The input file contains reviews with star ratings for West End shows.
 *
 * Usage:
 *   node scripts/collect-west-end-reviews.js [--input FILE] [--show SHOW_ID]
 *
 * Input format (JSON array):
 * [
 *   {
 *     "showId": "hamilton-west-end-2021",
 *     "outlet": "The Guardian",
 *     "outletId": "guardian",
 *     "criticName": "Michael Billington",
 *     "stars": 5,
 *     "maxStars": 5,
 *     "excerpt": "...",
 *     "url": "https://...",
 *     "publishDate": "2017-12-21",
 *     "source": "lbo-roundup"
 *   }
 * ]
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic } = require('./lib/review-normalization');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { isLondonMarket } = require('./lib/venue-classification');
const { buildOutletMaps } = require('./lib/outlet-region-map');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'west-end-reviews-input.json');

// Load outlet registry for region guard
const outletRegistryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const outletRegistry = fs.existsSync(outletRegistryPath)
  ? JSON.parse(fs.readFileSync(outletRegistryPath, 'utf8'))
  : { outlets: {} };
// outletRegionMap: id + lowercased aliases -> region.
// DUAL_MARKET_OUTLET_IDS: outlets that genuinely cover BOTH Broadway and West End markets
// (isDualMarket:true in outlet-registry.json).
// TIER_1_2_OUTLET_IDS: Tier 1/2 outlets, allowed since they legitimately review WE shows
// (cross-market guard targets Tier 3 only).
// Single source of truth: lib/outlet-region-map.js (also used by validate-data.js,
// audit-review-contamination.js, cross-market-guard.js — BRO-254 consolidated this
// file's independent copy onto it after that copy's alias-casing bug shipped once).
const { outletRegionMap, dualMarket: DUAL_MARKET_OUTLET_IDS, tier12Outlets: TIER_1_2_OUTLET_IDS } = buildOutletMaps(outletRegistry);

// Parse args
const args = process.argv.slice(2);
let inputFile = DEFAULT_INPUT;
let showFilter = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input' && args[i + 1]) inputFile = args[++i];
  if (args[i] === '--show' && args[i + 1]) showFilter = args[++i];
}

/**
 * Convert star rating to 0-100 score.
 * Handles fractional stars (e.g., 3.5/5 = 70).
 */
function convertStarRating(stars, maxStars = 5) {
  const numStars = parseFloat(stars);
  const numMax = parseFloat(maxStars);
  if (isNaN(numStars) || isNaN(numMax) || numMax === 0) return null;
  return Math.round((numStars / numMax) * 100);
}

function main() {
  if (!fs.existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    console.error('Create the input file with review data first.');
    process.exitCode = 1;
    return;
  }

  const reviews = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  console.log(`Loaded ${reviews.length} reviews from ${inputFile}`);

  // Load show opening dates for pre-opening validation
  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const showOpenDates = {};
  if (fs.existsSync(showsPath)) {
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    for (const s of showsData.shows || []) {
      const earliest = s.previewsStartDate || s.openingDate;
      if (earliest) showOpenDates[s.id] = earliest;
    }
  }

  const filtered = showFilter
    ? reviews.filter(r => r.showId === showFilter)
    : reviews;

  if (showFilter) {
    console.log(`Filtered to ${filtered.length} reviews for ${showFilter}`);
  }

  let created = 0;
  let skipped = 0;
  let skippedPreOpening = 0;
  const showCounts = {};

  for (const review of filtered) {
    const { showId, outlet, outletId, criticName, stars, maxStars = 5, excerpt, url, publishDate, source } = review;

    if (!showId || !outletId) {
      console.warn(`Skipping incomplete review: ${JSON.stringify(review).substring(0, 100)}`);
      skipped++;
      continue;
    }

    // Skip reviews published before the show opened (wrong production)
    if (publishDate && showOpenDates[showId]) {
      const pubDate = new Date(publishDate);
      const openDate = new Date(showOpenDates[showId]);
      const daysBefore = Math.ceil((openDate - pubDate) / (1000 * 60 * 60 * 24));
      if (daysBefore > 14) {
        console.warn(`Skipping pre-opening review: ${showId} ${outletId} published ${daysBefore} days before opening`);
        skippedPreOpening++;
        continue;
      }
    }

    // Region guard: reject non-London outlets (unless dual-market or Tier 1/2)
    const normalizedOutletId = (outletId || '').toLowerCase();
    if (!DUAL_MARKET_OUTLET_IDS.has(normalizedOutletId) && !TIER_1_2_OUTLET_IDS.has(normalizedOutletId)) {
      const region = outletRegionMap[normalizedOutletId];
      if (region !== 'london') {
        console.warn(`Skipping non-London outlet for WE show: ${showId} ${outletId} (region: ${region || 'none'})`);
        skipped++;
        continue;
      }
    }

    const assignedScore = convertStarRating(stars, maxStars);
    if (assignedScore === null) {
      console.warn(`Skipping review with invalid star rating: ${showId} ${outletId} ${stars}/${maxStars}`);
      skipped++;
      continue;
    }

    const canonicalOutletId = normalizeOutlet(outletId);
    const criticSlug = normalizeCritic(criticName);
    const fileName = `${canonicalOutletId}--${criticSlug}.json`;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const filePath = path.join(showDir, fileName);

    // Skip if any existing file maps to the same canonical outlet+critic
    // (handles all outlet ID variants, not just the input ID)
    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }
    if (fs.existsSync(showDir)) {
      const existingFiles = fs.readdirSync(showDir);
      const hasDupe = existingFiles.some(f => {
        const m = f.match(/^(.+?)--(.+)\.json$/);
        return m && normalizeOutlet(m[1]) === canonicalOutletId && m[2] === criticSlug;
      });
      if (hasDupe) {
        skipped++;
        continue;
      }
    }

    // Route through the shared save-time chokepoint (card 38b637c5) so every
    // guard applies (junk outlet, domain validation, cross-market reroute,
    // cross-show URL ownership, roundup detection). onMerge aborts — this
    // importer only CREATES files; the exact-name + canonical-variant
    // pre-checks above already enforced its skip-if-exists contract.
    const res = createOrMergeReviewFile(showId, {
      outlet: outlet || canonicalOutletId,
      outletId: canonicalOutletId,
      criticName: criticName || 'Unknown',
      url: url || null,
      source: source || 'web-search',
      fields: {
        publishDate: publishDate || null,
        fullText: null,
        isFullReview: false,
        originalScore: `${stars}/${maxStars}`,
        assignedScore,
        scoreSource: 'explicit-rating',
        showScoreExcerpt: excerpt || null,
        dtliExcerpt: null,
        dtliThumb: null,
        bwwExcerpt: null,
        contentTier: excerpt ? 'excerpt' : 'stub',
        contentTierReason: excerpt
          ? `Excerpt from ${source || 'review roundup'}`
          : 'Star rating only, no excerpt',
        addedAt: new Date().toISOString(),
        incompleteReason: 'not_attempted',
        incompleteDetail: 'Has URL but never scraped',
      },
    }, { onMerge: () => false, reviewTextsDir: REVIEW_TEXTS_DIR });

    if (res.action !== 'new') {
      console.warn(`Skipping ${showId} ${canonicalOutletId}: ${res.reason || res.action}`);
      skipped++;
      continue;
    }
    created++;
    showCounts[showId] = (showCounts[showId] || 0) + 1;
  }

  console.log('');
  console.log(`Created: ${created} review files`);
  console.log(`Skipped: ${skipped} (existing or incomplete)`);
  if (skippedPreOpening > 0) console.log(`Skipped pre-opening: ${skippedPreOpening} (published before show opened)`);
  console.log(`Shows with reviews: ${Object.keys(showCounts).length}`);
  console.log('');

  // Summary per show
  const sorted = Object.entries(showCounts).sort((a, b) => b[1] - a[1]);
  for (const [showId, count] of sorted) {
    console.log(`  ${showId}: ${count} reviews`);
  }
}

if (require.main === module) {
  main();
}
