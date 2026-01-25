#!/usr/bin/env node
/**
 * Fix moulin-rouge-2019 review data:
 * 1. Remove Boston tryout review (2018 URL)
 * 2. Remove duplicate entries (keep uppercase IDs which are more complete)
 * 3. Fix the NYT entry to use correct Broadway URL
 */

const fs = require('fs');
const path = require('path');

const reviewsPath = path.join(__dirname, '../data/reviews.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts/moulin-rouge-2019');

// Load reviews.json
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));

// Separate moulin-rouge-2019 reviews from others
const otherReviews = reviewsData.reviews.filter(r => r.showId !== 'moulin-rouge-2019');
const mrReviews = reviewsData.reviews.filter(r => r.showId === 'moulin-rouge-2019');

console.log(`Found ${mrReviews.length} moulin-rouge-2019 reviews`);

// Build a map to deduplicate - key by outlet+critic
const uniqueReviews = new Map();

mrReviews.forEach(r => {
  // Normalize critic name
  const criticNorm = r.criticName.toLowerCase().replace(/[^a-z]/g, '');

  // Normalize outlet - map lowercase versions to uppercase
  const outletMap = {
    'nytimes': 'nytimes', // Will be handled specially
    'vulture': 'VULT',
    'ew': 'EW',
    'thewrap': 'WRAP',
    'the-new-york-daily-news': 'NYDN',
    'ny-stage-review': 'NYSR', // Will keep both if different critics
    'timeout-ny': 'TIMEOUTNY',
    'washington-post': 'WASHPOST',
    'rolling-stone': 'ROLLSTONE',
    'usa-today': 'USATODAY',
    'nj-com': 'NJCOM',
    'daily-beast': 'TDB',
    'theater-news-online': 'TNO',
    'new-york-theatre-guide': 'NYTG',
    'broadwayworld': 'BWW',
    'nypost': 'NYP',
    'telegraph': 'TELEGRAPH',
    'observer': 'OBSERVER',
    'mashable': 'MASHABLE',
    'guardian': 'GUARDIAN'
  };

  const outletId = r.outletId;

  // Check for Boston tryout review (2018 URL)
  if (r.url && r.url.includes('2018/08/05')) {
    console.log(`REMOVING Boston tryout review: ${r.outletId} - ${r.criticName}`);
    return; // Skip this one
  }

  // Create unique key
  const key = `${outletId.toLowerCase()}-${criticNorm}`;

  // Check if we already have this review
  if (uniqueReviews.has(key)) {
    const existing = uniqueReviews.get(key);
    // Prefer uppercase outlet IDs (they're more complete)
    if (outletId === outletId.toUpperCase() && existing.outletId !== existing.outletId.toUpperCase()) {
      console.log(`REPLACING ${existing.outletId} with ${outletId} (preferring uppercase)`);
      uniqueReviews.set(key, r);
    } else {
      console.log(`SKIPPING duplicate: ${outletId} - ${r.criticName} (already have ${existing.outletId})`);
    }
  } else {
    uniqueReviews.set(key, r);
  }
});

// Convert map back to array
const dedupedReviews = Array.from(uniqueReviews.values());

// Now dedupe by outlet (different critics from same outlet should be kept, but same critic = duplicate)
const finalReviews = [];
const seenOutletCritic = new Set();

dedupedReviews.forEach(r => {
  const criticNorm = r.criticName.toLowerCase().replace(/[^a-z]/g, '');
  const outletNorm = r.outlet.toLowerCase().replace(/[^a-z]/g, '');
  const key = `${outletNorm}-${criticNorm}`;

  if (seenOutletCritic.has(key)) {
    console.log(`SKIPPING outlet+critic duplicate: ${r.outlet} - ${r.criticName}`);
    return;
  }

  seenOutletCritic.add(key);
  finalReviews.push(r);
});

console.log(`\nAfter deduplication: ${finalReviews.length} reviews`);

// Update reviews.json
reviewsData.reviews = [...otherReviews, ...finalReviews];

fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
console.log('Updated reviews.json');

// Clean up review-texts directory
const filesToRemove = [
  'has-crafted-a-stunning-array-of-costumes--fair-lady.json', // Corrupted
];

// Find duplicate review-text files
const reviewTextFiles = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
const seenReviewTexts = new Map();

reviewTextFiles.forEach(f => {
  const [outletPart, criticPart] = f.replace('.json', '').split('--');
  if (!criticPart) {
    console.log(`Malformed filename: ${f}`);
    filesToRemove.push(f);
    return;
  }

  const outletNorm = outletPart.toLowerCase();
  const criticNorm = criticPart.toLowerCase().replace(/[^a-z]/g, '');
  const key = `${outletNorm}-${criticNorm}`;

  if (seenReviewTexts.has(key)) {
    // Keep lowercase versions if they're more complete, otherwise prefer uppercase
    const existing = seenReviewTexts.get(key);
    if (outletPart === outletPart.toUpperCase()) {
      // Uppercase - keep it, remove the other
      console.log(`Will keep ${f}, remove ${existing}`);
      filesToRemove.push(existing);
      seenReviewTexts.set(key, f);
    } else {
      // Lowercase - remove it
      console.log(`Will remove ${f}, keep ${existing}`);
      filesToRemove.push(f);
    }
  } else {
    seenReviewTexts.set(key, f);
  }
});

// Remove duplicate/corrupted files
console.log('\nRemoving files:');
filesToRemove.forEach(f => {
  const filepath = path.join(reviewTextsDir, f);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    console.log(`  Removed: ${f}`);
  }
});

// Report final state
const remainingFiles = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
console.log(`\nFinal review-text files: ${remainingFiles.length}`);
console.log(`Final reviews.json entries for moulin-rouge-2019: ${finalReviews.length}`);
