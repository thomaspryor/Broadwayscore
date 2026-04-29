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
const { computeCriticScore: _computeRaw } = require('./lib/compute-critic-score');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Scoring constants still needed for pre-2005 gating and other local logic
const DEFAULT_TIER = 3;

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

// Shared loader appends blog-reviews-for-scoring.json so homepage scores match
// the Next.js show page (src/lib/data-core.ts does the same concatenation).
reviews = loadReviewsWithBlog();
if (reviews.length === 0) {
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
// Uses shared scoring module — single source of truth.
// Homepage archive is filtered to Broadway-only (see archiveShows filter below),
// so showCategory is hardcoded to 'broadway' for v5 region-aware tier lookup.
function computeCriticScore(showReviews) {
  const result = _computeRaw(showReviews, outletRegistry, 'broadway');
  if (!result) return null;
  return { score: result.s, reviewCount: result.rc, tier1Count: result.t1 };
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

  // Pre-2005 closed shows: hide reviews entirely
  const openingYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 9999;
  const hideReviews = openingYear < SCORE_DISPLAY_YEAR_CUTOFF && show.status === 'closed';
  let criticScore = hideReviews ? null : computeCriticScore(showReviews);

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
