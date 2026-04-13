#!/usr/bin/env node
/**
 * compute-fantasy-scores.js — Computes fantasy points per show
 *
 * Reads fantasy-league.json + shows.json + reviews.json + grosses-history.json
 * to compute points for each scoring pillar. Outputs data/fantasy-scores.json.
 *
 * Scoring pillars:
 * 1. CriticScore: points based on critic tier (Critical Gold = 30 pts)
 * 2. AudienceGrade: points based on audience letter grade (A+ = 25 pts)
 * 3. Box Office: 0.30 points per $100K weekly gross (Broadway only)
 * 4. Awards: Tonys + Drama Desk + Outer Critics + Drama League
 *
 * Usage: node scripts/compute-fantasy-scores.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { computeAwardsPoints } = require('./lib/fantasy-helpers');

// ── Load data ───────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');

const fantasyConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-league.json'), 'utf8'));
const grossesRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'grosses-history.json'), 'utf8'));
const awardsData = JSON.parse(fs.readFileSync(path.join(dataDir, 'awards.json'), 'utf8'));

const { scoring, shows: fantasyShows, _meta: meta } = fantasyConfig;
const weeks = grossesRaw.weeks || {};

// ── Scoring tier thresholds (from src/config/scoring.ts) ────────────
function getCriticLabel(score) {
  if (score >= 83) return 'Critical Gold';
  if (score >= 75) return 'Recommended';
  if (score >= 65) return 'Worth Seeing';
  if (score >= 55) return 'Skippable';
  return 'Stay Away';
}

function getAudienceGrade(score) {
  if (score == null) return null;
  if (score >= 90) return 'A+';
  if (score >= 88) return 'A';
  if (score >= 83) return 'A-';
  if (score >= 78) return 'B+';
  if (score >= 73) return 'B';
  if (score >= 68) return 'B-';
  if (score >= 63) return 'C+';
  if (score >= 58) return 'C';
  if (score >= 53) return 'C-';
  if (score >= 48) return 'D';
  return 'F';
}

// ── Compute box office points ───────────────────────────────────────
function computeBoxOfficePoints(showSlug, scoringStart, scoringEnd) {
  const pointsPer100K = scoring.boxOffice.pointsPer100K;
  let totalPoints = 0;
  let weekCount = 0;
  let totalGross = 0;

  const sortedWeeks = Object.keys(weeks).sort();
  for (const weekDate of sortedWeeks) {
    if (weekDate < scoringStart || weekDate > scoringEnd) continue;

    const weekData = weeks[weekDate];
    // Grosses keyed by slug (without year suffix usually)
    // Try both slug and common variants
    const entry = weekData[showSlug];
    if (entry && entry.gross) {
      totalPoints += (entry.gross / 100000) * pointsPer100K;
      totalGross += entry.gross;
      weekCount++;
    }
  }

  return {
    points: Math.round(totalPoints * 100) / 100,
    weekCount,
    totalGross,
  };
}

// ── Main ────────────────────────────────────────────────────────────
const dryRun = process.argv.includes('--dry-run');

const showScores = {};
let latestWeek = '';

const sortedWeeks = Object.keys(weeks).sort();
if (sortedWeeks.length > 0) {
  const inRange = sortedWeeks.filter(w => w >= meta.scoringStart && w <= meta.scoringEnd);
  latestWeek = inRange.length > 0 ? inRange[inRange.length - 1] : sortedWeeks[sortedWeeks.length - 1];
}

for (const [showId, show] of Object.entries(fantasyShows)) {
  // CriticScore points
  let criticScorePoints = 0;
  let criticTier = null;
  if (show.criticScore != null && show.eligible.criticScore) {
    criticTier = getCriticLabel(show.criticScore);
    criticScorePoints = scoring.criticScore[criticTier] || 0;
  } else if (show.criticScore != null && !show.eligible.criticScore) {
    // Score locked in (opened before scoring start) — still show the tier for display
    criticTier = getCriticLabel(show.criticScore) + ' (locked)';
    criticScorePoints = 0;
  }

  // AudienceGrade points
  let audienceGradePoints = 0;
  let audGrade = show.audienceGrade || null;
  if (audGrade && show.eligible.audienceGrade) {
    audienceGradePoints = scoring.audienceGrade[audGrade] || 0;
  }

  // Box office points (Broadway only)
  let boxOfficePoints = 0;
  let boxOfficeWeeks = 0;
  let boxOfficeTotal = 0;
  if (show.eligible.boxOffice) {
    const bo = computeBoxOfficePoints(show.slug, meta.scoringStart, meta.scoringEnd);
    boxOfficePoints = bo.points;
    boxOfficeWeeks = bo.weekCount;
    boxOfficeTotal = bo.totalGross;
  }

  // Awards points (auto-computed from awards.json)
  const awardsResult = computeAwardsPoints(showId, awardsData, scoring.awards);
  let awardsPoints = awardsResult.points;
  const awardsList = awardsResult.awardsList;

  const totalPoints = Math.round((criticScorePoints + audienceGradePoints + boxOfficePoints + awardsPoints) * 100) / 100;

  showScores[showId] = {
    criticScorePoints,
    audienceGradePoints,
    boxOfficePoints,
    awardsPoints,
    totalPoints,
    breakdown: {
      criticTier,
      audienceGrade: audGrade,
      boxOfficeWeeks,
      boxOfficeTotal: boxOfficeTotal > 0 ? `$${(boxOfficeTotal / 1000000).toFixed(1)}M` : '$0',
      awards: awardsList,
    },
  };
}

// Sort by total points for summary
const ranked = Object.entries(showScores)
  .sort((a, b) => b[1].totalPoints - a[1].totalPoints);

console.error('Fantasy Scores Summary:');
console.error(`  Shows scored: ${ranked.length}`);
console.error(`  Scoring window: ${meta.scoringStart} to ${meta.scoringEnd}`);
console.error(`  Latest grosses week: ${latestWeek}`);
console.error(`\nTop 15 by total points:`);
for (const [id, score] of ranked.slice(0, 15)) {
  const show = fantasyShows[id];
  console.error(`  ${score.totalPoints.toFixed(1).padStart(6)} pts  $${show.price.toString().padStart(2)}  ${show.title.substring(0, 35).padEnd(37)} CS:${score.criticScorePoints} AG:${score.audienceGradePoints} BO:${score.boxOfficePoints.toFixed(1)} AW:${score.awardsPoints}`);
}

const output = {
  _meta: {
    lastUpdated: new Date().toISOString(),
    weekEnding: latestWeek,
    season: meta.season,
  },
  showScores,
};

if (dryRun) {
  console.log(JSON.stringify(output, null, 2));
  console.error('\n--dry-run: output to stdout only');
} else {
  const outPath = path.join(dataDir, 'fantasy-scores.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.error(`\nWrote ${outPath}`);
}
