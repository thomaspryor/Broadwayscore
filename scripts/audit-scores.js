#!/usr/bin/env node
/**
 * Comprehensive scoring audit script
 * Identifies: wrong conversions, sentiment placeholders, duplicates, score mismatches
 */

const fs = require('fs');
const path = require('path');

const data = require('../data/reviews.json');
const reviews = data.reviews;

// Rating conversion rules
const STAR_CONVERSIONS = {
  '5/5': { min: 85, max: 100, target: 92 },
  '4/5': { min: 75, max: 88, target: 82 },
  '3/5': { min: 55, max: 72, target: 63 },
  '2/5': { min: 35, max: 55, target: 45 },
  '1/5': { min: 0, max: 35, target: 20 },
  '0/5': { min: 0, max: 20, target: 10 }
};

const LETTER_CONVERSIONS = {
  'A+': { min: 95, max: 100, target: 97 },
  'A': { min: 90, max: 96, target: 93 },
  'A-': { min: 87, max: 92, target: 89 },
  'B+': { min: 82, max: 88, target: 85 },
  'B': { min: 75, max: 84, target: 80 },
  'B-': { min: 70, max: 78, target: 74 },
  'C+': { min: 62, max: 72, target: 67 },
  'C': { min: 55, max: 65, target: 60 },
  'C-': { min: 48, max: 58, target: 53 },
  'D+': { min: 40, max: 50, target: 45 },
  'D': { min: 30, max: 42, target: 36 },
  'D-': { min: 20, max: 35, target: 28 },
  'F': { min: 0, max: 25, target: 15 }
};

const THUMB_CONVERSIONS = {
  'Up': { min: 70, max: 100 },
  'Flat': { min: 45, max: 65 },
  'Meh': { min: 45, max: 65 },
  'Down': { min: 0, max: 50 }
};

const SENTIMENT_CONVERSIONS = {
  'Rave': { min: 85, max: 100, target: 92 },
  'Positive': { min: 70, max: 88, target: 78 },
  'Mixed': { min: 45, max: 65, target: 55 },
  'Negative': { min: 20, max: 49, target: 35 },
  'Pan': { min: 0, max: 25, target: 15 }
};

const issues = {
  wrongConversions: [],
  sentimentPlaceholders: [],
  duplicates: [],
  scoreMismatches: [],
  noScore: []
};

function normalizeRating(rating) {
  if (!rating) return null;
  return rating.trim().toUpperCase();
}

function checkStarRating(rating, score) {
  // Match patterns like "2/5", "2 stars", etc.
  const match = rating.match(/^(\d(?:\.\d)?)\s*(?:\/\s*5|stars?|\/5)/i);
  if (match) {
    const stars = parseFloat(match[1]);
    const key = `${Math.round(stars)}/5`;
    const expected = STAR_CONVERSIONS[key];
    if (expected && (score < expected.min || score > expected.max)) {
      return { rating: key, expected, actual: score };
    }
  }
  return null;
}

function checkLetterGrade(rating, score) {
  const upper = rating.toUpperCase().replace(/\s+/g, '');
  for (const [grade, expected] of Object.entries(LETTER_CONVERSIONS)) {
    if (upper === grade || upper === grade.replace(/\+/g, 'PLUS').replace(/-/g, 'MINUS')) {
      if (score < expected.min || score > expected.max) {
        return { rating: grade, expected, actual: score };
      }
    }
  }
  return null;
}

function checkSentimentPlaceholder(rating) {
  return rating && rating.startsWith('Sentiment:');
}

// Analyze each review
reviews.forEach(review => {
  const { showId, outlet, criticName, assignedScore, originalRating, dtliThumb, bwwThumb } = review;

  // Check for no score
  if (assignedScore == null) {
    issues.noScore.push({ showId, outlet, criticName, originalRating });
    return;
  }

  // Check for sentiment placeholders
  if (checkSentimentPlaceholder(originalRating)) {
    issues.sentimentPlaceholders.push({
      showId, outlet, criticName,
      originalRating, assignedScore,
      dtliThumb, bwwThumb
    });
    return;
  }

  // Check star rating conversions
  if (originalRating) {
    const starCheck = checkStarRating(originalRating, assignedScore);
    if (starCheck) {
      issues.wrongConversions.push({
        showId, outlet, criticName,
        ...starCheck,
        severity: Math.abs(assignedScore - starCheck.expected.target) > 20 ? 'HIGH' : 'MEDIUM'
      });
    }

    // Check letter grade conversions
    const letterCheck = checkLetterGrade(originalRating, assignedScore);
    if (letterCheck) {
      issues.wrongConversions.push({
        showId, outlet, criticName,
        ...letterCheck,
        severity: Math.abs(assignedScore - letterCheck.expected.target) > 20 ? 'HIGH' : 'MEDIUM'
      });
    }

    // Check Negative/Pan sentiment
    const lowerRating = originalRating.toLowerCase();
    if (lowerRating === 'negative' && assignedScore > 49) {
      issues.wrongConversions.push({
        showId, outlet, criticName,
        rating: 'Negative',
        expected: SENTIMENT_CONVERSIONS.Negative,
        actual: assignedScore,
        severity: 'HIGH'
      });
    }
    if (lowerRating === 'pan' && assignedScore > 25) {
      issues.wrongConversions.push({
        showId, outlet, criticName,
        rating: 'Pan',
        expected: SENTIMENT_CONVERSIONS.Pan,
        actual: assignedScore,
        severity: 'HIGH'
      });
    }
  }

  // Check score vs DTLI/BWW thumb mismatch
  if (dtliThumb === 'Down' && assignedScore > 55) {
    issues.scoreMismatches.push({
      showId, outlet, criticName,
      assignedScore, dtliThumb, bwwThumb,
      issue: `DTLI=Down but score=${assignedScore}`
    });
  }
  if (bwwThumb === 'Down' && assignedScore > 55) {
    issues.scoreMismatches.push({
      showId, outlet, criticName,
      assignedScore, dtliThumb, bwwThumb,
      issue: `BWW=Down but score=${assignedScore}`
    });
  }
});

// Find duplicates (same show + outlet + critic)
const seen = new Map();
reviews.forEach((review, idx) => {
  const key = `${review.showId}|${review.outlet?.toLowerCase()}|${review.criticName?.toLowerCase() || ''}`;
  if (seen.has(key)) {
    issues.duplicates.push({
      showId: review.showId,
      outlet: review.outlet,
      criticName: review.criticName,
      indices: [seen.get(key), idx]
    });
  } else {
    seen.set(key, idx);
  }
});

// Also check for same outlet without critic name
const outletSeen = new Map();
reviews.forEach((review, idx) => {
  const key = `${review.showId}|${(review.outlet || review.outletId)?.toLowerCase()}`;
  if (outletSeen.has(key)) {
    // Only flag if we haven't already found a duplicate with critic name
    const existing = outletSeen.get(key);
    const isDuplicate = issues.duplicates.some(d =>
      d.showId === review.showId &&
      d.outlet?.toLowerCase() === review.outlet?.toLowerCase()
    );
    if (!isDuplicate && !review.criticName && !reviews[existing].criticName) {
      issues.duplicates.push({
        showId: review.showId,
        outlet: review.outlet,
        criticName: '(no critic)',
        indices: [existing, idx]
      });
    }
  } else {
    outletSeen.set(key, idx);
  }
});

// Output results
console.log('=== SCORING AUDIT REPORT ===\n');

console.log('## 1. WRONG RATING CONVERSIONS');
console.log(`Found ${issues.wrongConversions.length} conversion errors\n`);
const highSeverity = issues.wrongConversions.filter(i => i.severity === 'HIGH');
console.log(`HIGH SEVERITY (${highSeverity.length}):`);
highSeverity.forEach(i => {
  console.log(`  ${i.showId} | ${i.outlet} | ${i.rating} → ${i.actual} (should be ${i.expected.min}-${i.expected.max})`);
});
console.log();

console.log('## 2. SENTIMENT PLACEHOLDERS');
console.log(`Found ${issues.sentimentPlaceholders.length} reviews with LLM-generated sentiment placeholders\n`);
// Group by show
const byShow = {};
issues.sentimentPlaceholders.forEach(i => {
  byShow[i.showId] = (byShow[i.showId] || 0) + 1;
});
Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([showId, count]) => {
  console.log(`  ${showId}: ${count} reviews`);
});
console.log();

console.log('## 3. DUPLICATE REVIEWS');
console.log(`Found ${issues.duplicates.length} duplicate reviews\n`);
issues.duplicates.forEach(d => {
  console.log(`  ${d.showId} | ${d.outlet} | ${d.criticName || '(no critic)'}`);
});
console.log();

console.log('## 4. SCORE/THUMB MISMATCHES');
console.log(`Found ${issues.scoreMismatches.length} score/aggregator mismatches\n`);
issues.scoreMismatches.slice(0, 10).forEach(m => {
  console.log(`  ${m.showId} | ${m.outlet} | ${m.issue}`);
});
console.log();

console.log('## 5. MISSING SCORES');
console.log(`Found ${issues.noScore.length} reviews without scores\n`);

// Save full report
const reportPath = path.join(__dirname, '../data/audit/score-audit-report.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(issues, null, 2));
console.log(`\nFull report saved to: ${reportPath}`);

// Key shows validation
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
