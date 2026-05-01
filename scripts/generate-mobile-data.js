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
const { computeCriticScore } = require('./lib/compute-critic-score');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');

const dataDir = path.join(__dirname, '../data');
const outputDir = path.join(__dirname, '../public/data');

// Schema version — bump when output format changes
const SCHEMA_VERSION = 1;

// Scoring constants and computeCriticScore imported from ./lib/compute-critic-score.js

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
  return 'Critical Miss';
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

// Shared loader appends blog-reviews-for-scoring.json so mobile scores match
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

// NYT Critic's Picks: cross-reference nyt-critics-picks.json URLs with reviews
// Mirrors the logic in src/lib/data-core.ts getNYTCriticsPickShowIds()
const nytPickShowIds = new Set();
try {
  const picksData = JSON.parse(fs.readFileSync(path.join(dataDir, 'nyt-critics-picks.json'), 'utf-8'));
  const pickUrlSet = new Set((picksData.urls || []).map(u => u.replace(/^https?:\/\//, '').replace(/\/$/, '')));
  for (const review of reviews) {
    if (review.outletId !== 'nytimes' || !review.url) continue;
    const canonical = review.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (pickUrlSet.has(canonical)) nytPickShowIds.add(review.showId);
  }
  // Also include manual Critics_Pick designations
  for (const review of reviews) {
    if (review.designation === 'Critics_Pick') nytPickShowIds.add(review.showId);
  }
  console.log(`✓ NYT Critic's Picks: ${nytPickShowIds.size} shows`);
} catch (err) {
  console.warn('⚠ nyt-critics-picks.json not found — nyt-pick tag will be skipped');
}

// ===========================================
// INDEX REVIEWS BY SHOW
// ===========================================
const reviewsByShow = {};
for (const review of reviews) {
  if (!reviewsByShow[review.showId]) reviewsByShow[review.showId] = [];
  reviewsByShow[review.showId].push(review);
}

// computeCriticScore imported from ./lib/compute-critic-score.js
// Wrap to pass outletRegistry and add critic label.
// v5 (2026-04-29): pass showCategory so per-region tier + off-market multiplier apply.
function computeShowScore(showReviews, showCategory, showType) {
  const result = computeCriticScore(showReviews, outletRegistry, showCategory, showType);
  if (!result) return null;
  return { ...result, l: getCriticLabel(result.s) };
}

// ===========================================
// GENERATE MOBILE DATA
// ===========================================

// Helper: should reviews be hidden for this show? (matches src/config/scoring.ts)
function shouldHideReviews(show) {
  if (!show.openingDate) return false;
  const openingYear = new Date(show.openingDate).getFullYear();
  if (openingYear >= SCORE_DISPLAY_YEAR_CUTOFF) return false;
  if (show.status === 'open' || show.status === 'previews') return false;
  return true;
}

// Filter: include all non-closed shows + closed shows that have scores (and aren't review-hidden)
const showsWithScores = new Set();
for (const review of reviews) {
  if (review.assignedScore != null) showsWithScores.add(review.showId);
}

const visibleShows = shows.filter(show =>
  showsWithScores.has(show.id) || show.status !== 'closed'
);

const mobileShows = visibleShows.map(show => {
  const showReviews = reviewsByShow[show.id] || [];

  // Pre-2005 closed shows: hide reviews entirely (unreliable data from bulk import)
  const hideReviews = shouldHideReviews(show);
  let criticScore = hideReviews ? null : computeShowScore(showReviews, show.category, show.type);

  // Composite score = critic score (V1: critic-only, same as engine.ts line 618)
  const compositeScore = criticScore ? criticScore.s : null;

  // Audience grade from audience-buzz.json
  const buzz = audienceBuzz[show.id];
  let audienceGrade = null;
  if (buzz && buzz.combinedScore != null) {
    const totalReviews = Object.values(buzz.sources || {}).reduce((sum, s) => sum + (s?.reviewCount || 0), 0);
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
  const tags = [...(show.tags || [])];
  if (nytPickShowIds.has(show.id)) tags.push('nyt-pick');
  if (tags.length > 0) entry.tg = tags;
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
// ANALYST ENDPOINTS
// Two slim derivatives for external Claude Projects doing trend/scoring analysis.
// Kept small enough (~350KB each) to survive claude.ai's web-fetch truncation.
// ===========================================
const ANALYST_FIELDS = ['id', 't', 's', 'v', 'st', 'ty', 'cat', 'od', 'cd', 'rt', 'ar', 'cs', 'cr', 'ag', 'tg'];

const analystShows = mobileShows.map(s => {
  const slim = {};
  for (const k of ANALYST_FIELDS) if (s[k] !== undefined) slim[k] = s[k];
  return slim;
});

const analystCreatives = {};
for (const s of mobileShows) {
  if (s.ct && s.ct.length > 0) analystCreatives[s.id] = s.ct;
}

const analystShowsOutput = { _v: SCHEMA_VERSION, _ts: output._ts, shows: analystShows };
const analystCreativesOutput = { _v: SCHEMA_VERSION, _ts: output._ts, creatives: analystCreatives };

const analystShowsPath = path.join(outputDir, 'analyst-shows.json');
const analystCreativesPath = path.join(outputDir, 'analyst-creatives.json');
fs.writeFileSync(analystShowsPath, JSON.stringify(analystShowsOutput));
fs.writeFileSync(analystCreativesPath, JSON.stringify(analystCreativesOutput));

const analystShowsKB = (fs.statSync(analystShowsPath).size / 1024).toFixed(0);
const analystCreativesKB = (fs.statSync(analystCreativesPath).size / 1024).toFixed(0);
console.log(`✓ Generated analyst-shows.json: ${analystShows.length} shows (${analystShowsKB}KB)`);
console.log(`✓ Generated analyst-creatives.json: ${Object.keys(analystCreatives).length} shows (${analystCreativesKB}KB)`);

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
