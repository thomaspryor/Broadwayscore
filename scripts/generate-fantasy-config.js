#!/usr/bin/env node
/**
 * generate-fantasy-config.js — Generates data/fantasy-league.json
 *
 * Reads shows.json + reviews.json, identifies eligible shows for the
 * current fantasy season, computes prices based on scoring potential,
 * and outputs the fantasy league configuration.
 *
 * Usage: node scripts/generate-fantasy-config.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

// ── Config (mirrors src/config/fantasy.ts) ──────────────────────────
const SEASON = '2025-2026';
const BUDGET = 100;
const TEAM_SIZE = 8;
const DRAFT_DEADLINE = '2026-02-07T05:00:00Z';
const SCORING_START = '2026-02-01';
const SCORING_END = '2026-06-15';

// Shows that opened before this date have their CriticScore/AudienceGrade "locked in"
// They can still earn box office and awards points
const SCORE_LOCKOUT_DATE = SCORING_START;

// ── Scoring tier thresholds (from src/config/scoring.ts) ────────────
function getCriticLabel(score) {
  if (score >= 83) return 'Critical Gold';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Stay Away';
}

// ── Load data ───────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
const showsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8'));
const reviewsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));

const shows = showsRaw.shows;
const reviews = reviewsRaw.reviews;

// ── Load audience data (from audience-buzz.json, NOT audience.json) ─
// audience-buzz.json has combinedScore per show. audience.json is raw per-platform data.
let audienceData = {};
try {
  const buzzRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'audience-buzz.json'), 'utf8'));
  const buzzShows = buzzRaw.shows || buzzRaw;
  for (const [showId, data] of Object.entries(buzzShows)) {
    if (showId === '_meta' || showId === 'lastUpdated') continue;
    if (data && data.combinedScore != null) {
      audienceData[showId] = data;
    }
  }
  console.error(`Loaded audience data for ${Object.keys(audienceData).length} shows`);
} catch (e) {
  console.error('Warning: Could not load audience-buzz.json:', e.message);
}

// ── Compute critic scores per show ──────────────────────────────────
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.35 };

function computeCriticScore(showId) {
  const showReviews = reviews.filter(r => r.showId === showId && r.assignedScore != null);
  if (showReviews.length === 0) return null;

  let weightedSum = 0;
  let weightSum = 0;
  for (const r of showReviews) {
    const tier = r.tier || 3;
    const weight = TIER_WEIGHTS[tier] || 0.35;
    weightedSum += r.assignedScore * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? Math.round((weightedSum / weightSum) * 100) / 100 : null;
}

// ── Compute audience grade per show ─────────────────────────────────
function getAudienceGrade(showId) {
  const data = audienceData[showId];
  if (!data || !data.sources) return null;

  // Need enough reviews
  let totalReviews = 0;
  for (const source of Object.values(data.sources)) {
    totalReviews += source?.reviewCount || 0;
  }
  if (totalReviews < 15) return null;

  const combinedScore = data.combinedScore;
  if (combinedScore == null) return null;

  if (combinedScore >= 90) return 'A+';
  if (combinedScore >= 88) return 'A';
  if (combinedScore >= 83) return 'A-';
  if (combinedScore >= 78) return 'B+';
  if (combinedScore >= 73) return 'B';
  if (combinedScore >= 68) return 'B-';
  if (combinedScore >= 63) return 'C+';
  if (combinedScore >= 58) return 'C';
  if (combinedScore >= 53) return 'C-';
  if (combinedScore >= 48) return 'D';
  return 'F';
}

// ── Tony Season Window ──────────────────────────────────────────────
// Must match src/lib/data-tony-predictions.ts getTonySeasonWindow()
// 2025-2026: April 28, 2025 to April 27, 2026
const TONY_SEASON_START = '2025-04-28';
const TONY_SEASON_END = '2026-04-27';

// ── Identify eligible shows ─────────────────────────────────────────
function isEligible(show) {
  const isBW = !show.category || show.category === 'broadway';
  const isOB = show.category === 'off-broadway';
  if (!isBW && !isOB) return false;
  if (show.type === 'special') return false;

  // Must have opened within the Tony season window
  if (!show.openingDate) return false;
  if (show.openingDate < TONY_SEASON_START || show.openingDate > TONY_SEASON_END) return false;

  return true;
}

// ── Pricing algorithm ───────────────────────────────────────────────
// Price reflects projected point potential. Higher prices for shows
// likely to score well across multiple pillars.
function computePrice(show, criticScore) {
  const isBW = !show.category || show.category === 'broadway';
  const isOB = show.category === 'off-broadway';
  const isMusical = show.type === 'musical';
  const isOpen = show.status === 'open' || show.status === 'opened';
  const isPreviews = show.status === 'previews';
  const isClosed = show.status === 'closed';

  // OB shows: $6-12 (no box office, no Tonys — but earn CS + AG + Drama Desk/Outer Critics)
  // Max OB ceiling ~65 pts (30 CS + 25 AG + ~10 awards). Priced so pts/$ is comparable to BW.
  if (isOB) {
    if (criticScore && criticScore >= 83) return 12;
    if (criticScore && criticScore >= 75) return 10;
    if (criticScore && criticScore >= 65) return 8;
    if (criticScore) return 7;
    return 6;
  }

  // Broadway shows: base price by type
  // Bump up from earlier version — budget needs to be tight ($100 for 8 shows)
  let base = isMusical ? 16 : 12;

  // Adjust for critic score
  if (criticScore) {
    if (criticScore >= 83) base += 4;      // Critical Gold
    else if (criticScore >= 75) base += 2;  // Recommended
    else if (criticScore >= 65) base += 0;  // Worth Seeing
    else if (criticScore >= 55) base -= 2;  // Skippable
    else base -= 4;                          // Stay Away
  } else if (isPreviews) {
    // Unknown score — moderate premium for potential
    base += 1;
  }

  // Closed shows: discount (no more box office)
  if (isClosed) {
    base -= 4;
  }

  // Clamp: BW $4-$22
  return Math.max(4, Math.min(22, base));
}

// ── Main ────────────────────────────────────────────────────────────
const dryRun = process.argv.includes('--dry-run');

const allShows = Object.values(shows);
const eligibleShows = allShows.filter(isEligible);

console.error(`Found ${eligibleShows.length} eligible shows (${eligibleShows.filter(s => !s.category || s.category === 'broadway').length} BW, ${eligibleShows.filter(s => s.category === 'off-broadway').length} OB)`);

// For prototype: limit OB to ~15 notable ones (highest scored, currently running)
const bwShows = eligibleShows.filter(s => !s.category || s.category === 'broadway');
const obShows = eligibleShows.filter(s => s.category === 'off-broadway');

// Select OB shows: top scored ones that are still running, then top closed
const obScored = obShows
  .map(s => ({ ...s, _score: computeCriticScore(s.id) }))
  .filter(s => s._score != null)
  .sort((a, b) => b._score - a._score);

const obOpen = obScored.filter(s => s.status === 'open' || s.status === 'previews');
const obClosed = obScored.filter(s => s.status === 'closed');
// Take up to 10 running + 5 best closed = ~15 max
const selectedOB = [
  ...obOpen.slice(0, 10),
  ...obClosed.slice(0, 5),
];

console.error(`Selected ${selectedOB.length} OB shows (${obOpen.length} open, ${obClosed.length} closed with scores)`);

const finalShows = [...bwShows, ...selectedOB];

// Build config
const showsConfig = {};
for (const show of finalShows) {
  const criticScore = computeCriticScore(show.id);
  const audGrade = getAudienceGrade(show.id);
  const isBW = !show.category || show.category === 'broadway';

  showsConfig[show.id] = {
    price: computePrice(show, criticScore),
    eligible: {
      criticScore: true, // all shows opened this season — score not locked
      audienceGrade: true,
      boxOffice: isBW, // only Broadway shows report grosses
      tonys: isBW,     // only Broadway shows eligible for Tonys
    },
    title: show.title,
    type: show.type || 'play',
    category: show.category || 'broadway',
    status: show.status,
    openingDate: show.openingDate || null,
    criticScore: criticScore,
    audienceGrade: audGrade,
    slug: show.slug,
    image: show.images?.thumbnail || show.images?.poster || null,
  };
}

const config = {
  _meta: {
    season: SEASON,
    draftDeadline: DRAFT_DEADLINE,
    scoringStart: SCORING_START,
    scoringEnd: SCORING_END,
    budget: BUDGET,
    teamSize: TEAM_SIZE,
    generatedAt: new Date().toISOString(),
  },
  shows: showsConfig,
  scoring: {
    criticScore: {
      'Critical Gold': 30,
      'Recommended': 20,
      'Worth Seeing': 12,
      'Skippable': 4,
      'Stay Away': 0,
    },
    audienceGrade: {
      'A+': 25, 'A': 20, 'A-': 16,
      'B+': 10, 'B': 6, 'B-': 3,
      'C+': 1, 'C': 0, 'C-': 0,
      'D': 0, 'F': 0,
    },
    boxOffice: { pointsPer100K: 0.30 },
    awards: {
      tonyNom: 7, tonyWin: 14, tonyBestMusical: 30, tonyBestPlay: 30,
      dramaLeagueNom: 2, dramaLeagueWin: 5,
      outerCriticsNom: 2, outerCriticsWin: 5,
      dramaDeskNom: 3, dramaDeskWin: 6,
      nydccWin: 5,
      lortelNom: 2, lortelWin: 5,
      obieAward: 4,
    },
  },
};

// Stats
const prices = Object.values(showsConfig).map(s => s.price);
const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
const bwPrices = Object.values(showsConfig).filter(s => s.category === 'broadway').map(s => s.price);
const obPrices = Object.values(showsConfig).filter(s => s.category === 'off-broadway').map(s => s.price);

console.error(`\nPricing summary:`);
console.error(`  Total shows: ${Object.keys(showsConfig).length}`);
console.error(`  BW: avg $${(bwPrices.reduce((a,b)=>a+b,0)/bwPrices.length).toFixed(0)}, range $${Math.min(...bwPrices)}-$${Math.max(...bwPrices)}`);
if (obPrices.length) console.error(`  OB: avg $${(obPrices.reduce((a,b)=>a+b,0)/obPrices.length).toFixed(0)}, range $${Math.min(...obPrices)}-$${Math.max(...obPrices)}`);
console.error(`  8-show avg cost: $${(avgPrice * 8).toFixed(0)}`);

if (dryRun) {
  console.log(JSON.stringify(config, null, 2));
  console.error('\n--dry-run: output to stdout only');
} else {
  const outPath = path.join(dataDir, 'fantasy-league.json');
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');
  console.error(`\nWrote ${outPath}`);
}
