#!/usr/bin/env node
/**
 * Rebuild reviews.json for a specific show using review-texts data
 * Uses DTLI/BWW thumbs and LLM scores to get accurate scores
 */

const fs = require('fs');
const path = require('path');

const SHOWS_TO_FIX = ['queen-versailles-2025', 'stereophonic-2024'];

const THUMB_TO_SCORE = { 'Up': 78, 'Meh': 55, 'Flat': 55, 'Down': 35 };
const STAR_TO_SCORE = { 5: 92, 4: 82, 3: 63, 2: 45, 1: 25, 0: 10 };
const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 89,
  'B+': 85, 'B': 80, 'B-': 74,
  'C+': 67, 'C': 60, 'C-': 53,
  'D+': 45, 'D': 36, 'D-': 28,
  'F': 15
};

// Load reviews.json
const reviewsPath = path.join(__dirname, '../data/reviews.json');
const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
let reviews = data.reviews;

function normalizeOutlet(outlet) {
  return (outlet || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getScoreFromRating(rating) {
  if (!rating) return null;
  const r = rating.toString();

  const starMatch = r.match(/^(\d(?:\.\d)?)\s*(?:\/\s*5|stars?)/i);
  if (starMatch) {
    return STAR_TO_SCORE[Math.round(parseFloat(starMatch[1]))];
  }

  const letterMatch = r.match(/^([A-D][+-]?|F)$/i);
  if (letterMatch) {
    return LETTER_TO_SCORE[letterMatch[1].toUpperCase()];
  }

  return null;
}

function getBestScore(textData) {
  // Priority: LLM > originalScore > dtliThumb > bwwThumb > current

  if (textData.llmScore && textData.llmScore.score) {
    return { score: textData.llmScore.score, source: 'LLM' };
  }

  if (textData.originalScore) {
    const score = getScoreFromRating(textData.originalScore);
    if (score) return { score, source: `originalScore=${textData.originalScore}` };
  }

  if (textData.dtliThumb) {
    return { score: THUMB_TO_SCORE[textData.dtliThumb] || 55, source: `dtliThumb=${textData.dtliThumb}` };
  }

  if (textData.bwwThumb) {
    return { score: THUMB_TO_SCORE[textData.bwwThumb] || 55, source: `bwwThumb=${textData.bwwThumb}` };
  }

  return null;
}

function scoreToBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 50) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

function scoreToThumb(score) {
  if (score >= 70) return 'Up';
  if (score >= 50) return 'Flat';
  return 'Down';
}

let totalFixes = 0;

SHOWS_TO_FIX.forEach(showId => {
  console.log(`\n=== REBUILDING ${showId.toUpperCase()} ===\n`);

  const showDir = path.join(__dirname, '../data/review-texts', showId);
  if (!fs.existsSync(showDir)) {
    console.log('  Show directory not found, skipping');
    return;
  }

  // Build map of review-texts data
  const textDataMap = new Map();
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      const outletKey = normalizeOutlet(data.outlet || data.outletId);
      const criticKey = normalizeOutlet(data.criticName || '');

      // Store by outlet + critic for deduplication
      const key = `${outletKey}|${criticKey}`;

      const bestScore = getBestScore(data);
      if (bestScore) {
        // Only keep if better data than what we have
        if (!textDataMap.has(key) || (data.llmScore && !textDataMap.get(key).llmScore)) {
          textDataMap.set(key, { ...data, ...bestScore });
        }
      }
    } catch (e) {
      // skip
    }
  });

  // Remove existing reviews for this show
  const otherReviews = reviews.filter(r => r.showId !== showId);
  const existingCount = reviews.length - otherReviews.length;

  // Create new reviews from text data
  const newReviews = [];
  const seenOutlets = new Set();

  textDataMap.forEach((data, key) => {
    const outletNorm = normalizeOutlet(data.outlet || data.outletId);

    // Skip if we already have this outlet (to avoid duplicates)
    if (seenOutlets.has(outletNorm)) {
      return;
    }
    seenOutlets.add(outletNorm);

    const score = data.score;
    const review = {
      showId: showId,
      outletId: data.outletId || outletNorm,
      outlet: data.outlet || data.outletId,
      assignedScore: score,
      bucket: scoreToBucket(score),
      thumb: scoreToThumb(score),
      criticName: data.criticName || null,
      url: data.url || null,
      publishDate: data.publishDate || null,
      originalRating: data.originalScore || null,
      pullQuote: data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || null,
      dtliThumb: data.dtliThumb || null,
      bwwThumb: data.bwwThumb || null
    };

    newReviews.push(review);
    console.log(`  ${review.outlet}: ${score} (${data.source})`);
  });

  // Add new reviews
  reviews = [...otherReviews, ...newReviews];

  console.log(`\n  Replaced ${existingCount} reviews with ${newReviews.length} reviews`);
  totalFixes += newReviews.length;

  // Calculate new average
  const avg = newReviews.reduce((sum, r) => sum + r.assignedScore, 0) / newReviews.length;
  console.log(`  New average: ${avg.toFixed(1)}`);
});

// Save
data.reviews = reviews;
data._meta.lastUpdated = new Date().toISOString().split('T')[0];
data._meta.notes = 'Rebuilt from review-texts with thumb/LLM data';
fs.writeFileSync(reviewsPath, JSON.stringify(data, null, 2));

console.log(`\n=== SUMMARY ===`);
console.log(`Total reviews rebuilt: ${totalFixes}`);

// Final validation
console.log('\n=== FINAL VALIDATION ===\n');

function getShowAverage(showId) {
  const showReviews = reviews.filter(r => r.showId === showId && r.assignedScore != null);
  if (showReviews.length === 0) return null;
  const avg = showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length;
  return { avg: avg.toFixed(1), count: showReviews.length };
}

const qov = getShowAverage('queen-versailles-2025');
console.log(`Queen of Versailles: ${qov?.avg} (${qov?.count} reviews) - TARGET: 45-55`);
console.log(`  Status: ${qov && parseFloat(qov.avg) >= 45 && parseFloat(qov.avg) <= 55 ? '✓ PASS' : '✗ FAIL'}`);

const stereo = getShowAverage('stereophonic-2024');
console.log(`Stereophonic: ${stereo?.avg} (${stereo?.count} reviews) - TARGET: 85-95`);
console.log(`  Status: ${stereo && parseFloat(stereo.avg) >= 85 && parseFloat(stereo.avg) <= 95 ? '✓ PASS' : '✗ FAIL'}`);
