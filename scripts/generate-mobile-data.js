#!/usr/bin/env node
/**
 * Generate mobile app data JSON with pre-computed scores.
 *
 * Computes critic scores using the SAME tier-weighted average as engine.ts,
 * and extracts audience grades from audience-buzz.json.
 *
 * Generates: public/data/mobile-shows.json
 * Run: node scripts/generate-mobile-data.js
 * Or via: npm run prebuild
 *
 * IMPORTANT: If you change scoring logic in engine.ts or scoring.ts,
 * you MUST update the corresponding logic here. The validation step
 * at the end will catch drift, but keep them in sync.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Schema version — bump when output format changes
const SCHEMA_VERSION = 1;

// ===========================================
// SCORING CONSTANTS (from src/config/scoring.ts)
// Keep in sync! Validation step catches drift.
// ===========================================
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.45 };
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

function getCriticLabel(score) {
  if (score >= 83) return 'Critical Gold';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Stay Away';
}

// Audience grade thresholds (from src/lib/audience-grade-utils.ts)
function getAudienceGrade(score) {
  if (score == null) return null;
  if (score >= 90) return { g: 'A+', l: 'Loving It', c: '#22c55e' };
  if (score >= 88) return { g: 'A', l: 'Loving It', c: '#16a34a' };
  if (score >= 83) return { g: 'A-', l: 'Liking It', c: '#14b8a6' };
  if (score >= 78) return { g: 'B+', l: 'Liking It', c: '#0ea5e9' };
  if (score >= 73) return { g: 'B', l: 'Shrugging', c: '#f59e0b' };
  if (score >= 68) return { g: 'B-', l: 'Shrugging', c: '#f97316' };
  if (score >= 63) return { g: 'C+', l: 'Disliking It', c: '#ef4444' };
  if (score >= 58) return { g: 'C', l: 'Disliking It', c: '#dc2626' };
  if (score >= 53) return { g: 'C-', l: 'Disliking It', c: '#b91c1c' };
  if (score >= 48) return { g: 'D', l: 'Loathing It', c: '#991b1b' };
  return { g: 'F', l: 'Loathing It', c: '#6b7280' };
}

const MIN_AUDIENCE_REVIEWS = 15;

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
  console.warn('⚠ shows.json not found — generating empty mobile-shows.json');
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
// COMPUTE CRITIC SCORE (mirrors engine.ts computeCriticScore)
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
  let tier3Count = 0;

  for (const review of showReviews) {
    // Determine tier (top critics get T1 regardless of outlet)
    const isTopCritic = !!(review.criticName && TOP_CRITICS.has(review.criticName));
    const tier = isTopCritic ? 1 : getOutletTier(review.outletId);
    const tierWeight = TIER_WEIGHTS[tier] || TIER_WEIGHTS[DEFAULT_TIER];

    // Determine score (same priority as engine.ts)
    let score = review.assignedScore;
    if (score == null && review.llmScore?.score != null) score = review.llmScore.score;
    if (score == null) score = 50;

    // Apply designation bumps/floors
    if (review.designation) {
      if (DESIGNATION_FLOORS[review.designation]) {
        score = Math.max(score, DESIGNATION_FLOORS[review.designation]);
      }
      if (DESIGNATION_BUMPS[review.designation]) {
        score = Math.min(100, score + DESIGNATION_BUMPS[review.designation]);
      }
    }

    // Confidence weight based on content quality
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
    else tier3Count++;
  }

  if (totalWeight === 0) return null;

  const weightedScore = Math.round((weightedSum / totalWeight) * 100) / 100;
  const rounded = Math.round(weightedScore);

  return {
    s: rounded,
    rc: showReviews.length,
    l: getCriticLabel(rounded),
    t1: tier1Count,
  };
}

// ===========================================
// GENERATE MOBILE DATA
// ===========================================

// Filter: same logic as generate-search-shows.js
const showsWithScores = new Set();
for (const review of reviews) {
  if (review.assignedScore != null) showsWithScores.add(review.showId);
}

const visibleShows = shows.filter(show =>
  showsWithScores.has(show.id) || show.status !== 'closed'
);

const mobileShows = visibleShows.map(show => {
  const showReviews = reviewsByShow[show.id] || [];

  // Compute critic score
  let criticScore = computeCriticScore(showReviews);

  // Pre-2005 gating (same as engine.ts)
  if (criticScore && show.openingDate && (!show.category || show.category === 'broadway')) {
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

  // Composite score = critic score (V1: critic-only, same as engine.ts line 618)
  const compositeScore = criticScore ? criticScore.s : null;

  // Audience grade from audience-buzz.json
  const buzz = audienceBuzz[show.id];
  let audienceGrade = null;
  if (buzz && buzz.combinedScore != null) {
    const totalReviews = (buzz.sources?.showScore?.reviewCount || 0)
      + (buzz.sources?.mezzanine?.reviewCount || 0)
      + (buzz.sources?.reddit?.reviewCount || 0);
    if (totalReviews >= MIN_AUDIENCE_REVIEWS) {
      audienceGrade = getAudienceGrade(buzz.combinedScore);
    }
  }

  // Determine effective status (same as engine.ts line 639)
  let status = show.status;
  if (status === 'previews' && show.previewsStartDate && show.previewsStartDate > new Date().toISOString().slice(0, 10)) {
    status = 'upcoming';
  }

  // Build compact entry — omit null/empty fields for size
  const entry = {
    id: show.id,
    t: show.title,
    s: show.slug,
    v: show.venue || '',
    st: status,
    ty: show.type,
  };

  if (show.category && show.category !== 'broadway') entry.cat = show.category;
  if (show.openingDate) entry.od = show.openingDate;
  if (show.closingDate) entry.cd = show.closingDate;

  // Images
  const img = {};
  if (show.images?.thumbnail) img.th = show.images.thumbnail;
  if (show.images?.poster) img.po = show.images.poster;
  if (Object.keys(img).length > 0) entry.img = img;

  // Scores
  if (compositeScore != null) entry.cs = compositeScore;
  if (criticScore) entry.cr = criticScore;
  if (audienceGrade) entry.ag = audienceGrade;

  // Metadata (omit if empty/null to save bytes)
  if (show.tags?.length > 0) entry.tg = show.tags;
  if (show.synopsis) entry.syn = show.synopsis;
  if (show.ageRecommendation) entry.ar = show.ageRecommendation;
  if (show.isRevival || show.tags?.includes('revival')) entry.rv = true;
  if (show.runtime) entry.rt = show.runtime;
  if (show.creativeTeam?.length > 0) {
    entry.ct = show.creativeTeam.map(m => ({ n: m.name, r: m.role }));
  }
  if (show.ticketLinks?.length > 0) {
    entry.tl = show.ticketLinks.map(l => ({ p: l.platform, u: l.url }));
  }
  if (show.officialUrl) entry.ou = show.officialUrl;

  return entry;
});

// ===========================================
// WRITE OUTPUT
// ===========================================
const output = {
  _v: SCHEMA_VERSION,
  _ts: new Date().toISOString(),
  shows: mobileShows,
};

const outputPath = path.join(outputDir, 'mobile-shows.json');
fs.writeFileSync(outputPath, JSON.stringify(output));

const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
const withScores = mobileShows.filter(s => s.cs != null).length;
const withAudience = mobileShows.filter(s => s.ag != null).length;
const excluded = shows.length - visibleShows.length;

console.log(`✓ Generated mobile-shows.json: ${mobileShows.length} shows (${sizeKB}KB)`);
console.log(`  ${withScores} with scores, ${withAudience} with audience grades, ${excluded} unscored closed excluded`);

// ===========================================
// VALIDATION: Cross-check against search-shows.json
// ===========================================
const searchPath = path.join(outputDir, 'search-shows.json');
if (fs.existsSync(searchPath)) {
  const searchShows = JSON.parse(fs.readFileSync(searchPath, 'utf-8'));
  const searchIds = new Set(searchShows.map(s => s.id));
  const mobileIds = new Set(mobileShows.map(s => s.id));

  // Check that all search shows are in mobile data
  let missing = 0;
  for (const id of searchIds) {
    if (!mobileIds.has(id)) missing++;
  }
  if (missing > 0) {
    console.warn(`⚠ ${missing} shows in search-shows.json missing from mobile-shows.json`);
  }

  // Verify scored shows have scores
  const searchScored = searchShows.filter(s => s.hasScore);
  let scoreMissing = 0;
  for (const ss of searchScored) {
    const ms = mobileShows.find(m => m.id === ss.id);
    if (ms && ms.cs == null) scoreMissing++;
  }
  if (scoreMissing > 0) {
    console.warn(`⚠ ${scoreMissing} shows marked hasScore in search-shows.json but no score in mobile-shows.json`);
  }

  console.log(`✓ Validation: ${searchIds.size} search shows checked (${missing} missing, ${scoreMissing} score mismatches)`);
} else {
  console.log('ℹ search-shows.json not found — skipping cross-validation');
}
