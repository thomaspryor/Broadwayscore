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

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'west-end-reviews-input.json');

// Parse args
const args = process.argv.slice(2);
let inputFile = DEFAULT_INPUT;
let showFilter = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input' && args[i + 1]) inputFile = args[++i];
  if (args[i] === '--show' && args[i + 1]) showFilter = args[++i];
}

function slugify(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''\u2019]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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

    const assignedScore = convertStarRating(stars, maxStars);
    if (assignedScore === null) {
      console.warn(`Skipping review with invalid star rating: ${showId} ${outletId} ${stars}/${maxStars}`);
      skipped++;
      continue;
    }

    const criticSlug = criticName ? slugify(criticName) : 'unknown';
    const fileName = `${outletId}--${criticSlug}.json`;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const filePath = path.join(showDir, fileName);

    // Skip if file already exists
    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }

    // Create show directory
    if (!fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }

    const reviewData = {
      showId,
      outletId,
      outlet: outlet || outletId,
      criticName,
      url: url || null,
      publishDate: publishDate || null,
      fullText: null,
      isFullReview: false,
      originalScore: `${stars}/${maxStars}`,
      assignedScore,
      scoreSource: 'explicit-rating',
      source: source || 'web-search',
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
    };

    fs.writeFileSync(filePath, JSON.stringify(reviewData, null, 2) + '\n');
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

main();
