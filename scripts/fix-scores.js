#!/usr/bin/env node
/**
 * Fix all scoring issues identified in the audit
 * 1. Fix wrong rating conversions
 * 2. Remove sentiment placeholders
 * 3. Remove duplicate reviews
 * 4. Fix score/thumb mismatches
 */

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '../data/reviews.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
let reviews = data.reviews;

// Rating conversion rules
const STAR_TO_SCORE = {
  5: 92, 4: 82, 3: 63, 2: 45, 1: 25, 0: 10
};

const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 89,
  'B+': 85, 'B': 80, 'B-': 74,
  'C+': 67, 'C': 60, 'C-': 53,
  'D+': 45, 'D': 36, 'D-': 28,
  'F': 15
};

const SENTIMENT_TO_SCORE = {
  'rave': 92,
  'positive': 78,
  'mixed': 55,
  'negative': 35,
  'pan': 18
};

let fixes = {
  conversions: 0,
  placeholdersRemoved: 0,
  duplicatesRemoved: 0,
  thumbMismatches: 0
};

console.log('=== FIXING SCORING ISSUES ===\n');

// STEP 1: Fix wrong rating conversions
console.log('## Step 1: Fixing wrong rating conversions\n');

reviews.forEach((r, idx) => {
  if (!r.originalRating) return;

  const rating = r.originalRating.trim();
  let newScore = null;

  // Star ratings (e.g., "2/5", "3 stars")
  const starMatch = rating.match(/^(\d(?:\.\d)?)\s*(?:\/\s*5|stars?|\/5)/i);
  if (starMatch) {
    const stars = Math.round(parseFloat(starMatch[1]));
    newScore = STAR_TO_SCORE[stars];
    if (newScore && Math.abs(r.assignedScore - newScore) > 15) {
      console.log(`  [STAR] ${r.showId} | ${r.outlet}: ${rating} | ${r.assignedScore} → ${newScore}`);
      r.assignedScore = newScore;
      r.bucket = newScore >= 85 ? 'Rave' : newScore >= 70 ? 'Positive' : newScore >= 50 ? 'Mixed' : newScore >= 35 ? 'Negative' : 'Pan';
      fixes.conversions++;
    }
    return;
  }

  // Letter grades (e.g., "B+", "C-")
  const letterMatch = rating.match(/^([A-D][+-]?|F)$/i);
  if (letterMatch) {
    newScore = LETTER_TO_SCORE[letterMatch[1].toUpperCase()];
    if (newScore && Math.abs(r.assignedScore - newScore) > 15) {
      console.log(`  [LETTER] ${r.showId} | ${r.outlet}: ${rating} | ${r.assignedScore} → ${newScore}`);
      r.assignedScore = newScore;
      r.bucket = newScore >= 85 ? 'Rave' : newScore >= 70 ? 'Positive' : newScore >= 50 ? 'Mixed' : newScore >= 35 ? 'Negative' : 'Pan';
      fixes.conversions++;
    }
    return;
  }

  // Sentiment words (Negative, Pan)
  const lower = rating.toLowerCase();
  if (lower === 'negative' && r.assignedScore > 49) {
    console.log(`  [SENTIMENT] ${r.showId} | ${r.outlet}: Negative | ${r.assignedScore} → 35`);
    r.assignedScore = 35;
    r.bucket = 'Negative';
    fixes.conversions++;
    return;
  }
  if (lower === 'pan' && r.assignedScore > 25) {
    console.log(`  [SENTIMENT] ${r.showId} | ${r.outlet}: Pan | ${r.assignedScore} → 18`);
    r.assignedScore = 18;
    r.bucket = 'Pan';
    fixes.conversions++;
    return;
  }
});

// STEP 2: Remove sentiment placeholders
console.log('\n## Step 2: Removing "Sentiment:" placeholder reviews\n');

const beforeCount = reviews.length;
reviews = reviews.filter(r => {
  if (r.originalRating && r.originalRating.startsWith('Sentiment:')) {
    console.log(`  Removing: ${r.showId} | ${r.outlet} | ${r.originalRating}`);
    fixes.placeholdersRemoved++;
    return false;
  }
  return true;
});
console.log(`  Removed ${fixes.placeholdersRemoved} reviews with sentiment placeholders`);

// STEP 3: Remove duplicates (keep first occurrence)
console.log('\n## Step 3: Removing duplicate reviews\n');

const seen = new Set();
reviews = reviews.filter((r, idx) => {
  // Create unique key: showId + outlet (normalized) + criticName (if present)
  const key = `${r.showId}|${(r.outlet || r.outletId || '').toLowerCase()}|${(r.criticName || '').toLowerCase()}`;
  if (seen.has(key)) {
    console.log(`  Removing duplicate: ${r.showId} | ${r.outlet} | ${r.criticName || '(no critic)'}`);
    fixes.duplicatesRemoved++;
    return false;
  }
  seen.add(key);
  return true;
});
console.log(`  Removed ${fixes.duplicatesRemoved} duplicate reviews`);

// STEP 4: Fix score/thumb mismatches
console.log('\n## Step 4: Fixing score/thumb mismatches\n');

reviews.forEach(r => {
  // If DTLI or BWW says Down but score > 55, lower it
  if ((r.dtliThumb === 'Down' || r.bwwThumb === 'Down') && r.assignedScore > 55) {
    console.log(`  ${r.showId} | ${r.outlet}: score ${r.assignedScore} → 42 (thumb=Down)`);
    r.assignedScore = 42;
    r.bucket = 'Negative';
    r.thumb = 'Down';
    fixes.thumbMismatches++;
  }
});

// Update data and save
data.reviews = reviews;
data._meta.lastUpdated = new Date().toISOString().split('T')[0];
data._meta.notes = 'Cleaned: removed sentiment placeholders, fixed wrong conversions, removed duplicates';

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

console.log('\n=== SUMMARY ===');
console.log(`Rating conversions fixed: ${fixes.conversions}`);
console.log(`Sentiment placeholders removed: ${fixes.placeholdersRemoved}`);
console.log(`Duplicates removed: ${fixes.duplicatesRemoved}`);
console.log(`Thumb mismatches fixed: ${fixes.thumbMismatches}`);
console.log(`\nReviews: ${beforeCount} → ${reviews.length}`);

// Validate key shows
console.log('\n=== KEY SHOW VALIDATION ===\n');

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
