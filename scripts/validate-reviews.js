#!/usr/bin/env node
/**
 * Comprehensive Review Validation System
 *
 * Validates review data quality across 16 checks:
 * 1. Show Identity Validation
 * 2. Production Validation (CRITICAL)
 * 3. Review Date Clustering
 * 4. Metadata Completeness
 * 5. Metadata Accuracy
 * 6. Aggregator Coverage (placeholder)
 * 7. Score Distribution Analysis
 * 8. Duplicate Review Detection
 * 9. Rating Conversion Validation (CRITICAL)
 * 10. Outlet Tier Validation
 * 11. Designation Validation
 * 12. Review Text Cross-Validation
 * 13. Closed Show Temporal Validation
 * 14. Archive.org URL Flagging
 * 15. Preview vs Opening Reviews
 * 16. Multi-Production Detection
 */

const fs = require('fs');
const path = require('path');

// Load data
const reviewsData = require('../data/reviews.json');
const showsData = require('../data/shows.json');

const reviews = reviewsData.reviews;
const shows = showsData.shows;

// Create show lookup
const showsById = new Map(shows.map(s => [s.id, s]));

// Rating conversion rules (from scoring.ts)
const LETTER_GRADE_MAP = {
  'A+': 100, 'A': 95, 'A-': 90,
  'B+': 85, 'B': 80, 'B-': 75,
  'C+': 70, 'C': 65, 'C-': 60,
  'D+': 55, 'D': 50, 'D-': 45,
  'F': 30
};

const BUCKET_SCORE_MAP = {
  'Rave': 90, 'Positive': 82, 'mixed-positive': 72,
  'mixed-neutral': 65, 'Mixed': 65, 'mixed-negative': 58,
  'Negative': 48, 'Pan': 30
};

const THUMB_SCORE_MAP = { 'Up': 80, 'Flat': 60, 'Down': 35 };

// Star rating ranges (with tolerance)
const STAR_RANGES = {
  '5/5': { min: 88, max: 100 },
  '4/5': { min: 72, max: 88 },
  '3/5': { min: 52, max: 72 },
  '2/5': { min: 32, max: 52 },
  '1/5': { min: 10, max: 35 },
  '4/4': { min: 90, max: 100 },
  '3/4': { min: 68, max: 82 },
  '2/4': { min: 42, max: 58 },
  '1/4': { min: 15, max: 35 }
};

// Letter grade ranges (with tolerance)
const LETTER_RANGES = {
  'A+': { min: 95, max: 100 }, 'A': { min: 90, max: 98 }, 'A-': { min: 85, max: 93 },
  'B+': { min: 80, max: 88 }, 'B': { min: 75, max: 85 }, 'B-': { min: 70, max: 78 },
  'C+': { min: 65, max: 73 }, 'C': { min: 58, max: 68 }, 'C-': { min: 52, max: 63 },
  'D+': { min: 48, max: 58 }, 'D': { min: 42, max: 53 }, 'D-': { min: 38, max: 48 },
  'F': { min: 0, max: 40 }
};

// Outlet tier definitions (from outlets.ts)
const OUTLET_TIERS = {
  'NYT': 1, 'VULT': 1, 'VARIETY': 1, 'THR': 1, 'GUARDIAN': 1, 'WASHPOST': 1,
  'AP': 1, 'NEWYORKER': 1, 'TIMEOUTNY': 1,
  'TMAN': 2, 'NYP': 2, 'DEADLINE': 2, 'EW': 2, 'CHTRIB': 2, 'USATODAY': 2,
  'NYDN': 2, 'WRAP': 2, 'TDB': 2, 'OBSERVER': 2, 'INDIEWIRE': 2, 'SLANT': 2,
  'NYTHTR': 2, 'NYTG': 2, 'NYSR': 2, 'THLY': 2, 'BWAYNEWS': 2, 'LATIMES': 2, 'WSJ': 2,
  'BWW': 3, 'AMNY': 3, 'CITI': 3, 'CSCE': 3, 'FRONTMEZZ': 3, 'THERECS': 3,
  'OMC': 3, 'STGCIN': 3, 'STGCNMA': 3, 'BACKSTAGE': 3, 'NEWSDAY': 3, 'NY1': 3, 'HUFFPOST': 3, 'JITNEY': 3
};

// Results storage
const results = {
  critical: [],
  warnings: [],
  info: [],
  passed: []
};

// Helper functions
function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(date1, date2) {
  if (!date1 || !date2) return null;
  const d1 = parseDate(date1);
  const d2 = parseDate(date2);
  if (!d1 || !d2) return null;
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

function getReviewTextPath(showId) {
  return path.join(__dirname, '..', 'data', 'review-texts', showId);
}

function hasReviewTexts(showId) {
  const textPath = getReviewTextPath(showId);
  return fs.existsSync(textPath) && fs.readdirSync(textPath).filter(f => f.endsWith('.json')).length > 0;
}

function loadReviewText(showId, outletId, criticName) {
  const textPath = getReviewTextPath(showId);
  if (!fs.existsSync(textPath)) return null;

  // Try to find matching file
  const files = fs.readdirSync(textPath).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(textPath, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (content.outletId === outletId ||
          (content.criticName && criticName &&
           content.criticName.toLowerCase() === criticName.toLowerCase())) {
        return content;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

// Negative sentiment words for cross-validation
const NEGATIVE_WORDS = ['disappointing', 'dull', 'boring', 'flat', 'tedious', 'fails', 'mediocre',
  'uninspired', 'weak', 'lifeless', 'misses', 'lackluster', 'bland', 'forgettable', 'tiresome'];
const POSITIVE_WORDS = ['brilliant', 'stunning', 'masterful', 'extraordinary', 'magnificent',
  'phenomenal', 'exceptional', 'triumph', 'remarkable', 'outstanding', 'must-see', 'unmissable'];

// ============================================
// VALIDATION CHECKS
// ============================================

// Track per-show validation results
const showValidation = new Map();

function initShowValidation(showId) {
  if (!showValidation.has(showId)) {
    showValidation.set(showId, { passed: 0, failed: 0, warnings: 0, issues: [] });
  }
}

function recordIssue(showId, severity, check, message, review = null) {
  initShowValidation(showId);
  const sv = showValidation.get(showId);

  const issue = {
    check,
    message,
    showId,
    review: review ? {
      outlet: review.outlet,
      critic: review.criticName,
      date: review.publishDate,
      score: review.assignedScore,
      url: review.url
    } : null
  };

  if (severity === 'critical') {
    results.critical.push(issue);
    sv.failed++;
  } else if (severity === 'warning') {
    results.warnings.push(issue);
    sv.warnings++;
  } else {
    results.info.push(issue);
  }
  sv.issues.push({ severity, ...issue });
}

// Check 1: Show Identity Validation
function checkShowIdentity(review, show) {
  if (!show) {
    recordIssue(review.showId, 'critical', '1-identity',
      `Review references unknown show ID: ${review.showId}`, review);
    return false;
  }

  // Check if review text mentions show title (if text exists)
  const reviewText = loadReviewText(review.showId, review.outletId, review.criticName);
  if (reviewText && reviewText.fullText && reviewText.fullText.length > 100) {
    const titleWords = show.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const text = reviewText.fullText.toLowerCase();
    const hasTitle = titleWords.some(word => text.includes(word));
    if (!hasTitle && show.title.length > 5) {
      recordIssue(review.showId, 'warning', '1-identity',
        `Review text doesn't mention show title "${show.title}"`, review);
      return false;
    }
  }
  return true;
}

// Check 2: Production Validation (CRITICAL)
function checkProductionValidation(review, show) {
  if (!show) return false;

  const openingDate = parseDate(show.openingDate);
  const reviewDate = parseDate(review.publishDate);

  if (!reviewDate) return true; // Can't validate without date

  // Check if review is way before opening (wrong production?)
  if (openingDate) {
    const daysBefore = daysBetween(review.publishDate, show.openingDate);

    // Flag reviews more than 6 months before opening
    if (daysBefore > 180) {
      recordIssue(review.showId, 'critical', '2-production',
        `Review dated ${daysBefore} days BEFORE opening (${review.publishDate} vs opening ${show.openingDate}) - LIKELY WRONG PRODUCTION`, review);
      return false;
    }

    // Flag reviews more than 1 year before opening
    if (daysBefore > 365) {
      recordIssue(review.showId, 'critical', '2-production',
        `Review dated ${daysBefore} days before opening - DEFINITELY WRONG PRODUCTION`, review);
      return false;
    }
  }

  // Check review text for Off-Broadway, West End, tour markers
  const reviewText = loadReviewText(review.showId, review.outletId, review.criticName);
  if (reviewText && reviewText.fullText) {
    const text = reviewText.fullText.toLowerCase();
    const wrongProductionMarkers = [
      { pattern: /off-broadway/i, label: 'Off-Broadway' },
      { pattern: /off broadway/i, label: 'Off-Broadway' },
      { pattern: /west end/i, label: 'West End' },
      { pattern: /national tour/i, label: 'Tour' },
      { pattern: /touring production/i, label: 'Tour' },
      { pattern: /regional\s+(?:production|theater|premiere)/i, label: 'Regional' }
    ];

    for (const marker of wrongProductionMarkers) {
      if (marker.pattern.test(text)) {
        // Exception: if the show is comparing to previous production, that's OK
        const isComparison = /(?:previously|before|when it was|original)\s+(?:on|at|the)/i.test(text);
        if (!isComparison) {
          recordIssue(review.showId, 'warning', '2-production',
            `Review text contains "${marker.label}" - may be wrong production`, review);
        }
      }
    }
  }

  return true;
}

// Check 3: Review Date Clustering
function checkDateClustering(showId, showReviews, show) {
  if (!show || showReviews.length < 3) return true;

  const openingDate = parseDate(show.openingDate);
  if (!openingDate) return true;

  const reviewsWithDates = showReviews.filter(r => parseDate(r.publishDate));
  if (reviewsWithDates.length === 0) return true;

  // Count reviews within 3 months of opening
  const within3Months = reviewsWithDates.filter(r => {
    const days = Math.abs(daysBetween(r.publishDate, show.openingDate));
    return days !== null && days <= 90;
  });

  const clusterRatio = within3Months.length / reviewsWithDates.length;

  if (clusterRatio < 0.8 && reviewsWithDates.length >= 5) {
    recordIssue(showId, 'warning', '3-date-cluster',
      `Only ${Math.round(clusterRatio * 100)}% of reviews within 3 months of opening (expected 80%+). May include wrong production reviews.`);
  }

  // Flag individual outliers (>1 year from opening)
  for (const review of reviewsWithDates) {
    const days = daysBetween(review.publishDate, show.openingDate);
    if (days !== null && Math.abs(days) > 365) {
      recordIssue(showId, 'warning', '3-date-cluster',
        `Review dated ${Math.abs(days)} days ${days < 0 ? 'after' : 'before'} opening`, review);
    }
  }

  return true;
}

// Check 4: Metadata Completeness
function checkMetadataCompleteness(review) {
  const required = ['showId', 'outlet', 'url', 'assignedScore'];
  const missing = required.filter(f => !review[f] && review[f] !== 0);

  if (missing.length > 0) {
    recordIssue(review.showId, 'warning', '4-completeness',
      `Missing required fields: ${missing.join(', ')}`, review);
    return false;
  }

  // Check for empty strings
  if (review.outlet === '' || review.url === '') {
    recordIssue(review.showId, 'warning', '4-completeness',
      `Empty string in required field`, review);
    return false;
  }

  // Validate score range
  if (review.assignedScore < 0 || review.assignedScore > 100) {
    recordIssue(review.showId, 'critical', '4-completeness',
      `Score out of range: ${review.assignedScore}`, review);
    return false;
  }

  return true;
}

// Check 5: Metadata Accuracy
function checkMetadataAccuracy(review, show, allUrls) {
  // Check for duplicate URLs
  const url = review.url?.toLowerCase();
  if (url && allUrls.has(url)) {
    const existing = allUrls.get(url);
    if (existing.showId !== review.showId) {
      recordIssue(review.showId, 'critical', '5-accuracy',
        `Duplicate URL found (also in ${existing.showId})`, review);
    }
  }
  if (url) allUrls.set(url, review);

  // Check review date not in future
  const reviewDate = parseDate(review.publishDate);
  if (reviewDate && reviewDate > new Date()) {
    recordIssue(review.showId, 'warning', '5-accuracy',
      `Review date is in the future: ${review.publishDate}`, review);
    return false;
  }

  // Check review not too early (>90 days before opening)
  if (show && review.publishDate && show.openingDate) {
    const daysBefore = daysBetween(review.publishDate, show.openingDate);
    if (daysBefore > 90) {
      recordIssue(review.showId, 'warning', '5-accuracy',
        `Review ${daysBefore} days before opening (preview review or wrong production?)`, review);
    }
  }

  // Check critic name format (should be title case)
  if (review.criticName) {
    const words = review.criticName.split(/\s+/);
    const hasBadCase = words.some(w => w.length > 2 && w === w.toLowerCase());
    if (hasBadCase) {
      recordIssue(review.showId, 'info', '5-accuracy',
        `Critic name may have inconsistent case: "${review.criticName}"`, review);
    }
  }

  return true;
}

// Check 6: Aggregator Coverage (placeholder)
function checkAggregatorCoverage(showId, showReviews) {
  // Placeholder - would compare against DTLI/Show-Score/BWW data
  // Skip for now as per requirements
  return true;
}

// Check 7: Score Distribution Analysis
function checkScoreDistribution(showId, showReviews) {
  if (showReviews.length < 5) return true;

  const scores = showReviews.map(r => r.assignedScore).filter(s => s != null);
  if (scores.length < 5) return true;

  // Check for suspicious uniformity (>90% in same 20-point band)
  const bands = [0, 20, 40, 60, 80, 100];
  for (let i = 0; i < bands.length - 1; i++) {
    const inBand = scores.filter(s => s >= bands[i] && s < bands[i + 1]).length;
    if (inBand / scores.length > 0.9) {
      recordIssue(showId, 'warning', '7-distribution',
        `${Math.round(inBand / scores.length * 100)}% of reviews in ${bands[i]}-${bands[i+1]} range - suspicious uniformity`);
    }
  }

  // Check for all positive (>90% above 75)
  const highScores = scores.filter(s => s >= 75);
  if (highScores.length / scores.length > 0.9) {
    recordIssue(showId, 'info', '7-distribution',
      `${Math.round(highScores.length / scores.length * 100)}% of reviews >= 75 - verify this is accurate`);
  }

  // Check for all negative (>90% below 50)
  const lowScores = scores.filter(s => s < 50);
  if (lowScores.length / scores.length > 0.9) {
    recordIssue(showId, 'info', '7-distribution',
      `${Math.round(lowScores.length / scores.length * 100)}% of reviews < 50 - verify this is accurate`);
  }

  // Check for bimodal distribution
  const veryHigh = scores.filter(s => s >= 85).length;
  const veryLow = scores.filter(s => s <= 45).length;
  const middle = scores.filter(s => s > 45 && s < 85).length;
  if (veryHigh > 2 && veryLow > 2 && middle === 0) {
    recordIssue(showId, 'warning', '7-distribution',
      `Bimodal distribution: ${veryHigh} high, ${veryLow} low, 0 middle - verify scores`);
  }

  return true;
}

// Check 8: Duplicate Review Detection
function checkDuplicates(showId, showReviews) {
  const seen = new Map();

  for (const review of showReviews) {
    // Check same critic + outlet + date
    const key1 = `${(review.criticName || '').toLowerCase()}|${(review.outlet || '').toLowerCase()}|${review.publishDate || ''}`;
    if (seen.has(key1)) {
      recordIssue(showId, 'critical', '8-duplicates',
        `Duplicate: same critic/outlet/date`, review);
    }
    seen.set(key1, review);

    // Check same URL
    if (review.url) {
      const urlKey = review.url.toLowerCase();
      const existing = showReviews.find(r => r !== review && r.url?.toLowerCase() === urlKey);
      if (existing) {
        recordIssue(showId, 'critical', '8-duplicates',
          `Duplicate URL within show`, review);
      }
    }
  }

  return true;
}

// Check 9: Rating Conversion Validation (CRITICAL)
function checkRatingConversion(review) {
  const original = review.originalRating;
  const assigned = review.assignedScore;

  if (!original || assigned == null) return true;

  const normalizedRating = original.trim();

  // Check star ratings (e.g., "4/5", "3 stars", "5/5")
  const starMatch = normalizedRating.match(/^(\d(?:\.\d)?)\s*(?:\/\s*(\d)|stars?)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    const maxStars = starMatch[2] ? parseInt(starMatch[2]) : 5;
    const key = `${Math.round(stars)}/${maxStars}`;
    const expected = STAR_RANGES[key];

    if (expected) {
      if (assigned < expected.min - 5 || assigned > expected.max + 5) {
        recordIssue(review.showId, 'critical', '9-conversion',
          `Rating "${normalizedRating}" -> ${assigned} (expected ${expected.min}-${expected.max})`, review);
        return false;
      }
    }
  }

  // Check letter grades
  const letterMatch = normalizedRating.match(/^([A-F][+-]?)$/i);
  if (letterMatch) {
    const grade = letterMatch[1].toUpperCase();
    const expected = LETTER_RANGES[grade];

    if (expected) {
      if (assigned < expected.min - 5 || assigned > expected.max + 5) {
        recordIssue(review.showId, 'critical', '9-conversion',
          `Grade "${grade}" -> ${assigned} (expected ${expected.min}-${expected.max})`, review);
        return false;
      }
    }
  }

  // Check sentiment buckets
  const lowerRating = normalizedRating.toLowerCase();
  if (lowerRating === 'negative' && assigned > 55) {
    recordIssue(review.showId, 'critical', '9-conversion',
      `"Negative" rating with score ${assigned} (expected <55)`, review);
    return false;
  }
  if (lowerRating === 'pan' && assigned > 40) {
    recordIssue(review.showId, 'critical', '9-conversion',
      `"Pan" rating with score ${assigned} (expected <40)`, review);
    return false;
  }
  if (lowerRating === 'rave' && assigned < 80) {
    recordIssue(review.showId, 'critical', '9-conversion',
      `"Rave" rating with score ${assigned} (expected >80)`, review);
    return false;
  }

  return true;
}

// Check 10: Outlet Tier Validation
function checkOutletTier(review) {
  const outletId = review.outletId;

  if (outletId && !OUTLET_TIERS[outletId]) {
    recordIssue(review.showId, 'info', '10-outlet-tier',
      `Unknown outlet ID: ${outletId}`, review);
  }

  return true;
}

// Check 11: Designation Validation
function checkDesignation(review) {
  const designation = review.designation;
  if (!designation) return true;

  // Critics_Pick only on NYT, Vulture
  if (designation === 'Critics_Pick') {
    if (!['NYT', 'VULT'].includes(review.outletId)) {
      recordIssue(review.showId, 'warning', '11-designation',
        `Critics_Pick on non-NYT/Vulture outlet: ${review.outlet}`, review);
    }
  }

  // Critics_Choice only on Time Out NY
  if (designation === 'Critics_Choice') {
    if (review.outletId !== 'TIMEOUTNY') {
      recordIssue(review.showId, 'warning', '11-designation',
        `Critics_Choice on non-TimeOut outlet: ${review.outlet}`, review);
    }
  }

  // No Recommended on low scores
  if (designation === 'Recommended' && review.assignedScore < 60) {
    recordIssue(review.showId, 'warning', '11-designation',
      `"Recommended" designation with low score: ${review.assignedScore}`, review);
  }

  return true;
}

// Check 12: Review Text Cross-Validation
function checkReviewTextCrossValidation(review) {
  const reviewText = loadReviewText(review.showId, review.outletId, review.criticName);
  if (!reviewText || !reviewText.fullText) return true;

  const text = reviewText.fullText.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  // Check text length
  if (wordCount < 300 && reviewText.isFullReview) {
    recordIssue(review.showId, 'info', '12-text-validation',
      `Short review text (${wordCount} words) marked as full review`, review);
  }

  // High score with negative sentiment
  if (review.assignedScore >= 75) {
    const negativeCount = NEGATIVE_WORDS.filter(w => text.includes(w)).length;
    if (negativeCount >= 3) {
      recordIssue(review.showId, 'warning', '12-text-validation',
        `High score (${review.assignedScore}) but ${negativeCount} negative words in text`, review);
    }
  }

  // Low score with glowing sentiment
  if (review.assignedScore <= 50) {
    const positiveCount = POSITIVE_WORDS.filter(w => text.includes(w)).length;
    if (positiveCount >= 3) {
      recordIssue(review.showId, 'warning', '12-text-validation',
        `Low score (${review.assignedScore}) but ${positiveCount} positive words in text`, review);
    }
  }

  return true;
}

// Check 13: Closed Show Temporal Validation
function checkClosedShowTemporal(review, show) {
  if (!show || show.status !== 'closed' || !show.closingDate) return true;

  const reviewDate = parseDate(review.publishDate);
  const closingDate = parseDate(show.closingDate);

  if (!reviewDate || !closingDate) return true;

  const daysAfterClose = daysBetween(show.closingDate, review.publishDate);
  if (daysAfterClose > 90) {
    recordIssue(review.showId, 'warning', '13-closed-temporal',
      `Review ${daysAfterClose} days after show closed (retrospective?)`, review);
    return false;
  }

  return true;
}

// Check 14: Archive.org URL Flagging
function checkArchiveOrgUrl(review) {
  if (review.url && review.url.includes('web.archive.org')) {
    recordIssue(review.showId, 'info', '14-archive-url',
      `Archive.org URL - verify quality`, review);
    return false;
  }
  return true;
}

// Check 15: Preview vs Opening Reviews
function checkPreviewReviews(review, show, showReviews) {
  if (!show || !review.publishDate || !show.openingDate) return true;

  const daysBefore = daysBetween(review.publishDate, show.openingDate);

  // Flag preview reviews (>14 days before opening)
  if (daysBefore > 14) {
    recordIssue(review.showId, 'warning', '15-preview',
      `Preview review: ${daysBefore} days before opening`, review);

    // Check if same outlet has opening night review too
    const sameOutletReviews = showReviews.filter(r =>
      r.outlet === review.outlet && r.publishDate !== review.publishDate
    );
    const hasOpeningReview = sameOutletReviews.some(r => {
      const days = daysBetween(r.publishDate, show.openingDate);
      return days !== null && Math.abs(days) <= 7;
    });

    if (hasOpeningReview) {
      recordIssue(review.showId, 'warning', '15-preview',
        `${review.outlet} has both preview and opening review - potential duplicate`, review);
    }
  }

  return true;
}

// Check 16: Multi-Production Detection
function checkMultiProduction(showId, showReviews, show) {
  if (!show) return true;

  const openingDate = parseDate(show.openingDate);
  if (!openingDate) return true;

  // Calculate show age in years
  const showAgeYears = (new Date() - openingDate) / (1000 * 60 * 60 * 24 * 365);
  if (showAgeYears < 5) return true;

  // For long-running shows, check review span
  const reviewDates = showReviews
    .map(r => parseDate(r.publishDate))
    .filter(d => d)
    .sort((a, b) => a - b);

  if (reviewDates.length < 2) return true;

  const spanYears = (reviewDates[reviewDates.length - 1] - reviewDates[0]) / (1000 * 60 * 60 * 24 * 365);

  if (spanYears > 3) {
    recordIssue(showId, 'info', '16-multi-production',
      `Long-running show (${Math.round(showAgeYears)} years) with review span of ${Math.round(spanYears)} years - verify reviews are for current production`);
  }

  return true;
}

// ============================================
// MAIN VALIDATION LOOP
// ============================================

console.log('Starting comprehensive review validation...\n');

// Group reviews by show
const reviewsByShow = new Map();
for (const review of reviews) {
  if (!reviewsByShow.has(review.showId)) {
    reviewsByShow.set(review.showId, []);
  }
  reviewsByShow.get(review.showId).push(review);
}

// Track all URLs for duplicate detection
const allUrls = new Map();

// Run validation for each review
for (const review of reviews) {
  const show = showsById.get(review.showId);
  const showReviews = reviewsByShow.get(review.showId) || [];

  initShowValidation(review.showId);

  // Individual review checks
  checkShowIdentity(review, show);
  checkProductionValidation(review, show);
  checkMetadataCompleteness(review);
  checkMetadataAccuracy(review, show, allUrls);
  checkRatingConversion(review);
  checkOutletTier(review);
  checkDesignation(review);
  checkReviewTextCrossValidation(review);
  checkClosedShowTemporal(review, show);
  checkArchiveOrgUrl(review);
  checkPreviewReviews(review, show, showReviews);
}

// Run show-level checks
for (const [showId, showReviews] of reviewsByShow) {
  const show = showsById.get(showId);

  checkDateClustering(showId, showReviews, show);
  checkAggregatorCoverage(showId, showReviews);
  checkScoreDistribution(showId, showReviews);
  checkDuplicates(showId, showReviews);
  checkMultiProduction(showId, showReviews, show);
}

// Count passed shows
for (const [showId, validation] of showValidation) {
  const showReviews = reviewsByShow.get(showId) || [];
  if (validation.failed === 0 && validation.warnings === 0) {
    results.passed.push({ showId, reviewCount: showReviews.length });
  }
}

// ============================================
// GENERATE REPORT
// ============================================

function generateReport() {
  const timestamp = new Date().toISOString();
  const totalReviews = reviews.length;
  const totalShows = reviewsByShow.size;

  let report = `# Review Validation Report

Generated: ${timestamp}

## Summary

| Metric | Count |
|--------|-------|
| Total Shows | ${totalShows} |
| Total Reviews | ${totalReviews} |
| Critical Errors | ${results.critical.length} |
| Warnings | ${results.warnings.length} |
| Info | ${results.info.length} |
| Shows Fully Passed | ${results.passed.length} |

---

## ❌ CRITICAL ERRORS (Fix Immediately)

`;

  // Group critical errors by check
  const criticalByCheck = {};
  for (const issue of results.critical) {
    if (!criticalByCheck[issue.check]) {
      criticalByCheck[issue.check] = [];
    }
    criticalByCheck[issue.check].push(issue);
  }

  if (results.critical.length === 0) {
    report += '*No critical errors found.*\n\n';
  } else {
    for (const [check, issues] of Object.entries(criticalByCheck)) {
      const checkNames = {
        '1-identity': 'Show Identity',
        '2-production': 'Wrong Production',
        '4-completeness': 'Missing Metadata',
        '5-accuracy': 'Duplicate URLs',
        '8-duplicates': 'Duplicate Reviews',
        '9-conversion': 'Rating Conversion Errors'
      };

      report += `### ${checkNames[check] || check} (${issues.length} issues)\n\n`;

      // Group by show
      const byShow = {};
      for (const issue of issues) {
        if (!byShow[issue.showId]) byShow[issue.showId] = [];
        byShow[issue.showId].push(issue);
      }

      for (const [showId, showIssues] of Object.entries(byShow)) {
        const show = showsById.get(showId);
        report += `**${show?.title || showId}:**\n`;
        for (const issue of showIssues) {
          report += `- ${issue.message}`;
          if (issue.review) {
            report += ` (${issue.review.outlet}${issue.review.critic ? `, ${issue.review.critic}` : ''}${issue.review.date ? `, ${issue.review.date}` : ''})`;
          }
          report += '\n';
        }
        report += '\n';
      }
    }
  }

  report += `---

## ⚠️ WARNINGS (Review Manually)

`;

  // Group warnings by check
  const warningsByCheck = {};
  for (const issue of results.warnings) {
    if (!warningsByCheck[issue.check]) {
      warningsByCheck[issue.check] = [];
    }
    warningsByCheck[issue.check].push(issue);
  }

  if (results.warnings.length === 0) {
    report += '*No warnings found.*\n\n';
  } else {
    for (const [check, issues] of Object.entries(warningsByCheck)) {
      const checkNames = {
        '1-identity': 'Show Identity',
        '2-production': 'Production Markers',
        '3-date-cluster': 'Date Outliers',
        '5-accuracy': 'Metadata Issues',
        '7-distribution': 'Score Distribution',
        '11-designation': 'Designation Issues',
        '12-text-validation': 'Text/Score Mismatch',
        '13-closed-temporal': 'Post-Closing Reviews',
        '15-preview': 'Preview Reviews'
      };

      report += `### ${checkNames[check] || check} (${issues.length} issues)\n\n`;

      // Show first 10 per check
      const toShow = issues.slice(0, 15);
      for (const issue of toShow) {
        const show = showsById.get(issue.showId);
        report += `- **${show?.title || issue.showId}**: ${issue.message}`;
        if (issue.review) {
          report += ` (${issue.review.outlet})`;
        }
        report += '\n';
      }
      if (issues.length > 15) {
        report += `- *...and ${issues.length - 15} more*\n`;
      }
      report += '\n';
    }
  }

  report += `---

## ℹ️ INFO (Low Priority)

`;

  // Group info by check
  const infoByCheck = {};
  for (const issue of results.info) {
    if (!infoByCheck[issue.check]) {
      infoByCheck[issue.check] = [];
    }
    infoByCheck[issue.check].push(issue);
  }

  if (results.info.length === 0) {
    report += '*No info items.*\n\n';
  } else {
    for (const [check, issues] of Object.entries(infoByCheck)) {
      const checkNames = {
        '5-accuracy': 'Name Formatting',
        '7-distribution': 'Score Distribution Notes',
        '10-outlet-tier': 'Unknown Outlets',
        '12-text-validation': 'Short Reviews',
        '14-archive-url': 'Archive.org URLs',
        '16-multi-production': 'Long-Running Shows'
      };

      report += `### ${checkNames[check] || check} (${issues.length} items)\n\n`;

      // Show first 10 per check
      const toShow = issues.slice(0, 10);
      for (const issue of toShow) {
        const show = showsById.get(issue.showId);
        report += `- **${show?.title || issue.showId}**: ${issue.message}\n`;
      }
      if (issues.length > 10) {
        report += `- *...and ${issues.length - 10} more*\n`;
      }
      report += '\n';
    }
  }

  report += `---

## ✅ PASSED VALIDATION

Shows where all reviews passed all validation checks:

`;

  if (results.passed.length === 0) {
    report += '*No shows with 100% pass rate.*\n\n';
  } else {
    for (const { showId, reviewCount } of results.passed.sort((a, b) => b.reviewCount - a.reviewCount)) {
      const show = showsById.get(showId);
      report += `- **${show?.title || showId}**: ${reviewCount}/${reviewCount} reviews passed\n`;
    }
    report += '\n';
  }

  report += `---

## Details by Show

`;

  // Sort shows by issue count (most issues first)
  const showsSorted = [...showValidation.entries()]
    .sort((a, b) => (b[1].failed + b[1].warnings) - (a[1].failed + a[1].warnings));

  for (const [showId, validation] of showsSorted) {
    const show = showsById.get(showId);
    const reviewCount = (reviewsByShow.get(showId) || []).length;
    const status = validation.failed > 0 ? '❌' : validation.warnings > 0 ? '⚠️' : '✅';

    report += `### ${status} ${show?.title || showId}\n\n`;
    report += `- Reviews: ${reviewCount}\n`;
    report += `- Critical: ${validation.failed}\n`;
    report += `- Warnings: ${validation.warnings}\n`;

    if (validation.issues.length > 0) {
      report += `- Issues:\n`;
      for (const issue of validation.issues.slice(0, 5)) {
        report += `  - [${issue.severity.toUpperCase()}] ${issue.message}\n`;
      }
      if (validation.issues.length > 5) {
        report += `  - *...and ${validation.issues.length - 5} more*\n`;
      }
    }
    report += '\n';
  }

  return report;
}

// Write report
const report = generateReport();
const reportPath = path.join(__dirname, '..', 'data', 'validation-report.md');
fs.writeFileSync(reportPath, report);

console.log('Validation complete!');
console.log(`\nSummary:`);
console.log(`  Total shows: ${reviewsByShow.size}`);
console.log(`  Total reviews: ${reviews.length}`);
console.log(`  Critical errors: ${results.critical.length}`);
console.log(`  Warnings: ${results.warnings.length}`);
console.log(`  Info: ${results.info.length}`);
console.log(`  Shows passed: ${results.passed.length}`);
console.log(`\nReport saved to: ${reportPath}`);
