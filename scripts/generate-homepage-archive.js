#!/usr/bin/env node
/**
 * Generate homepage archive JSON for lazy-loading closed shows.
 *
 * The homepage only passes active (non-closed) shows as React props.
 * This script generates a static JSON file with closed shows (5+ reviews)
 * that the client fetches on demand when the user filters to ALL/CLOSED
 * or searches.
 *
 * Output format matches HomepageShow interface from HomePageClient.tsx.
 * Scoring logic mirrors engine.ts via the same constants as generate-mobile-data.js.
 *
 * Generates: public/data/homepage-archive.json
 * Run: node scripts/generate-homepage-archive.js
 * Or via: npm run prebuild
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// ===========================================
// SCORING CONSTANTS (from src/config/scoring.ts)
// Keep in sync! Same as generate-mobile-data.js.
// ===========================================
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.35 };
const DEFAULT_TIER = 3;

const DESIGNATION_BUMPS = { 'Critics_Pick': 3, 'Critics_Choice': 2 };
const DESIGNATION_FLOORS = { 'Critics_Pick': 70 };

const TOP_CRITICS = new Set([
  'Jesse Green', 'Ben Brantley', 'Charles Isherwood', 'David Rooney',
  'Hilton Als', 'Helen Shaw', 'Peter Marks', 'Elisabeth Vincentelli',
  'Adam Feldman', 'Linda Winer', 'Alexis Soloski', 'Sara Holdren',
  'Johnny Oleksinski', 'Chris Jones',
]);

const SCORE_DISPLAY_YEAR_CUTOFF = 2005;
const MIN_HIGH_CONF_REVIEWS_PRE_CUTOFF = 3;
const LOW_CONF_SCORE_SOURCES = new Set([
  'llmScore-lowconf', 'llmScore-thumb-boosted', 'thumb', 'bwwScore-fallback',
]);

// Audience grade thresholds (from src/lib/audience-grade-utils.ts)
const MIN_AUDIENCE_REVIEWS = 15;

function getAudienceGrade(score) {
  if (score == null) return null;
  if (score >= 90) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#fff', tooltip: 'Audiences love it' };
  if (score >= 88) return { grade: 'A', label: 'Loving It', color: '#16a34a', textColor: '#fff', tooltip: 'Audiences love it' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#fff', tooltip: 'Strong audience reception' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#fff', tooltip: 'Strong audience reception' };
  if (score >= 73) return { grade: 'B', label: 'Shrugging', color: '#f59e0b', textColor: '#000', tooltip: 'Mixed audience reception' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#000', tooltip: 'Mixed audience reception' };
  if (score >= 63) return { grade: 'C+', label: 'Disliking It', color: '#ef4444', textColor: '#fff', tooltip: 'Below-average reception' };
  if (score >= 58) return { grade: 'C', label: 'Disliking It', color: '#dc2626', textColor: '#fff', tooltip: 'Below-average reception' };
  if (score >= 53) return { grade: 'C-', label: 'Disliking It', color: '#b91c1c', textColor: '#fff', tooltip: 'Below-average reception' };
  if (score >= 48) return { grade: 'D', label: 'Loathing It', color: '#991b1b', textColor: '#fff', tooltip: 'Very poor reception' };
  return { grade: 'F', label: 'Loathing It', color: '#6b7280', textColor: '#fff', tooltip: 'Very poor reception' };
}

// ===========================================
// LOAD DATA
// ===========================================
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

let shows = [];
let reviews = [];
let outletRegistry = {};
let audienceBuzz = {};

try {
  const showsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf-8'));
  shows = showsData.shows || [];
} catch (err) {
  console.warn('⚠ shows.json not found — generating empty homepage-archive.json');
}

try {
  const reviewsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf-8'));
  reviews = reviewsData.reviews || [];
} catch (err) {
  console.warn('⚠ reviews.json not found — scores will be null');
}

try {
  const registryData = JSON.parse(fs.readFileSync(path.join(dataDir, 'outlet-registry.json'), 'utf-8'));
  outletRegistry = registryData.outlets || {};
} catch (err) {
  console.warn('⚠ outlet-registry.json not found — using default tiers');
}

try {
  const buzzData = JSON.parse(fs.readFileSync(path.join(dataDir, 'audience-buzz.json'), 'utf-8'));
  audienceBuzz = buzzData.shows || {};
} catch (err) {
  console.warn('⚠ audience-buzz.json not found — audience grades will be null');
}

// ===========================================
// INDEX REVIEWS BY SHOW
// ===========================================
const reviewsByShow = {};
for (const review of reviews) {
  if (!reviewsByShow[review.showId]) reviewsByShow[review.showId] = [];
  reviewsByShow[review.showId].push(review);
}

// ===========================================
// COMPUTE CRITIC SCORE (mirrors engine.ts)
// ===========================================
function getOutletTier(outletId) {
  if (!outletId) return DEFAULT_TIER;
  const entry = outletRegistry[outletId.toLowerCase().trim()];
  return entry?.tier || DEFAULT_TIER;
}

function computeCriticScore(showReviews) {
  if (!showReviews || showReviews.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;
  let tier1Count = 0;
  let tier2Count = 0;

  for (const review of showReviews) {
    const isTopCritic = !!(review.criticName && TOP_CRITICS.has(review.criticName));
    const tier = isTopCritic ? 1 : getOutletTier(review.outletId);
    const tierWeight = TIER_WEIGHTS[tier] || TIER_WEIGHTS[DEFAULT_TIER];

    let score = review.assignedScore;
    if (score == null && review.llmScore?.score != null) score = review.llmScore.score;
    if (score == null) score = 50;

    if (review.designation) {
      if (DESIGNATION_FLOORS[review.designation]) {
        score = Math.max(score, DESIGNATION_FLOORS[review.designation]);
      }
      if (DESIGNATION_BUMPS[review.designation]) {
        score = Math.min(100, score + DESIGNATION_BUMPS[review.designation]);
      }
    }

    const thumbReflectedInScore = !!(review.dtliThumb || review.bwwThumb) && !review.needsReview;
    let confidenceWeight = 1.0;
    if (review.contentTier === 'excerpt' || review.contentTier === 'stub') {
      confidenceWeight = thumbReflectedInScore ? 0.75 : 0.5;
    } else if (review.contentTier === 'truncated') {
      confidenceWeight = 0.85;
    }

    weightedSum += score * tierWeight * confidenceWeight;
    totalWeight += tierWeight * confidenceWeight;

    if (tier === 1) tier1Count++;
    else if (tier === 2) tier2Count++;
  }

  if (totalWeight === 0) return null;

  const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;
  const rounded = Math.round(weightedScore);

  return {
    score: rounded,
    reviewCount: showReviews.length,
    tier1Count,
    tier2Count,
  };
}

// ===========================================
// reviewYearNote (mirrors engine.ts)
// ===========================================
function getReviewYearNote(show, showReviews) {
  if (!show.openingDate || !showReviews || showReviews.length < 3) return undefined;
  const openYear = new Date(show.openingDate).getFullYear();
  const now = new Date().getFullYear();
  if (now - openYear < 10) return undefined;
  return `Reviews from ${openYear}`;
}

// ===========================================
// GENERATE ARCHIVE DATA
// ===========================================

// Filter to closed Broadway shows with 5+ scored reviews
const archiveShows = shows.filter(show => {
  if (show.status !== 'closed') return false;
  if (show.category && show.category !== 'broadway') return false;
  const showReviews = reviewsByShow[show.id] || [];
  return showReviews.length >= 5;
});

const archiveData = archiveShows.map(show => {
  const showReviews = reviewsByShow[show.id] || [];

  // Compute critic score
  let criticScore = computeCriticScore(showReviews);

  // Pre-2005 gating
  if (criticScore && show.openingDate) {
    const openingYear = new Date(show.openingDate).getFullYear();
    if (openingYear < SCORE_DISPLAY_YEAR_CUTOFF) {
      const highConfCount = showReviews.filter(r =>
        r.scoreSource && !LOW_CONF_SCORE_SOURCES.has(r.scoreSource)
      ).length;
      if (highConfCount < MIN_HIGH_CONF_REVIEWS_PRE_CUTOFF) {
        criticScore = null;
      }
    }
  }

  // Audience data
  const buzz = audienceBuzz[show.id];
  let audienceCombinedScore = null;
  let audienceGrade = null;
  if (buzz && buzz.combinedScore != null) {
    const totalReviews = (buzz.sources?.showScore?.reviewCount || 0)
      + (buzz.sources?.mezzanine?.reviewCount || 0)
      + (buzz.sources?.reddit?.reviewCount || 0);
    if (totalReviews >= MIN_AUDIENCE_REVIEWS) {
      audienceCombinedScore = buzz.combinedScore;
      audienceGrade = getAudienceGrade(buzz.combinedScore);
    }
  }

  // Build HomepageShow-shaped entry
  const entry = {
    id: show.id,
    slug: show.slug,
    title: show.title,
    venue: show.venue || '',
    openingDate: show.openingDate,
    status: show.status,
    type: show.type,
    audienceCombinedScore,
    audienceGrade,
  };

  if (show.closingDate) entry.closingDate = show.closingDate;
  if (show.isRevival) entry.isRevival = true;
  if (show.tags?.length > 0) entry.tags = show.tags;
  if (show.ageRecommendation) entry.ageRecommendation = show.ageRecommendation;
  if (show.creativeTeam?.length > 0) entry.creativeTeam = show.creativeTeam;
  if (show.images) entry.images = show.images;
  if (criticScore) entry.criticScore = criticScore;
  if (show.category && show.category !== 'broadway') entry.category = show.category;

  const reviewYearNote = getReviewYearNote(show, showReviews);
  if (reviewYearNote) entry.reviewYearNote = reviewYearNote;

  return entry;
});

// ===========================================
// WRITE OUTPUT
// ===========================================
const outputPath = path.join(outputDir, 'homepage-archive.json');
fs.writeFileSync(outputPath, JSON.stringify(archiveData));

const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
const withScores = archiveData.filter(s => s.criticScore).length;

console.log(`✓ Generated homepage-archive.json: ${archiveData.length} closed shows (${sizeKB}KB)`);
console.log(`  ${withScores} with critic scores`);
