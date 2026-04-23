#!/usr/bin/env node
/**
 * compute-fantasy-scores.js — Computes fantasy points per show
 *
 * Two modes:
 *   --mode=realized (default): current weekly scoring — sums realized BO grosses,
 *     applies current CS/AG tiers, credits realized awards from awards.json.
 *     Outputs data/fantasy-scores.json.
 *
 *   --mode=projection: expected points through scoring end — projects BO forward
 *     from trailing average, applies current CS/AG tiers (assumed to hold),
 *     computes E[awards] from tony-win-probabilities.json. Outputs
 *     data/fantasy-ev.json. This is the input to price-fantasy-league.js.
 *
 * Scoring pillars:
 * 1. CriticScore: points based on critic tier (Critical Gold = 30 pts)
 * 2. AudienceGrade: points based on audience letter grade (A+ = 25 pts)
 * 3. Box Office: 0.30 points per $100K weekly gross (Broadway only)
 * 4. Awards: Tonys + Drama Desk + Outer Critics + Drama League
 *
 * Usage: node scripts/compute-fantasy-scores.js [--mode=realized|projection] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const {
  computeAwardsPoints,
  sumGrossesInRange,
  projectRemainingGrosses,
  computeExpectedAwardsPoints,
  validateTonyPredictions,
} = require('./lib/fantasy-helpers');

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
  return 'Critical Miss';
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
const modeArg = process.argv.find(a => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'realized';
if (!['realized', 'projection'].includes(mode)) {
  console.error(`Unknown --mode=${mode}. Use 'realized' or 'projection'.`);
  process.exit(1);
}

// Projection mode: load tony-win-probabilities.json (external signal).
// Validate strictly — a silent {} would collapse all prices to $5.
let tonyPredictions = null;
if (mode === 'projection') {
  const predsPath = path.join(dataDir, 'tony-win-probabilities.json');
  if (!fs.existsSync(predsPath)) {
    console.error(`--mode=projection requires data/tony-win-probabilities.json. Missing.`);
    process.exit(1);
  }
  tonyPredictions = JSON.parse(fs.readFileSync(predsPath, 'utf8'));
  const v = validateTonyPredictions(tonyPredictions);
  if (!v.ok) {
    console.error(`tony-win-probabilities.json failed validation: ${v.reason}`);
    process.exit(1);
  }
  console.error(`Validated tony-win-probabilities.json: ${JSON.stringify(v.stats)}`);
}

const showScores = {};
let latestWeek = '';

const sortedWeeks = Object.keys(weeks).sort();
if (sortedWeeks.length > 0) {
  const inRange = sortedWeeks.filter(w => w >= meta.scoringStart && w <= meta.scoringEnd);
  latestWeek = inRange.length > 0 ? inRange[inRange.length - 1] : sortedWeeks[sortedWeeks.length - 1];
}

for (const [showId, show] of Object.entries(fantasyShows)) {
  // CriticScore points — same in both modes (current tier assumed to hold).
  let criticScorePoints = 0;
  let criticTier = null;
  if (show.criticScore != null && show.eligible.criticScore) {
    criticTier = getCriticLabel(show.criticScore);
    criticScorePoints = scoring.criticScore[criticTier] || 0;
  } else if (show.criticScore != null && !show.eligible.criticScore) {
    criticTier = getCriticLabel(show.criticScore) + ' (locked)';
    criticScorePoints = 0;
  }

  // AudienceGrade points — same in both modes.
  let audienceGradePoints = 0;
  let audGrade = show.audienceGrade || null;
  if (audGrade && show.eligible.audienceGrade) {
    audienceGradePoints = scoring.audienceGrade[audGrade] || 0;
  }

  // Box office points — realized sums historical, projection adds forward estimate.
  let boxOfficePoints = 0;
  let boxOfficeWeeks = 0;
  let boxOfficeTotal = 0;
  let projectedRemainingGross = 0;
  let projectionConfidence = null;
  if (show.eligible.boxOffice) {
    const bo = computeBoxOfficePoints(show.slug, meta.scoringStart, meta.scoringEnd);
    boxOfficePoints = bo.points;
    boxOfficeWeeks = bo.weekCount;
    boxOfficeTotal = bo.totalGross;

    if (mode === 'projection' && latestWeek && latestWeek < meta.scoringEnd) {
      const isClosed = show.status === 'closed';
      const proj = projectRemainingGrosses(
        show.slug, weeks, latestWeek, meta.scoringEnd, { isClosed }
      );
      projectedRemainingGross = proj.expectedRemaining;
      projectionConfidence = proj.confidence;
      const projPoints = (proj.expectedRemaining / 100000) * scoring.boxOffice.pointsPer100K;
      boxOfficePoints = Math.round((boxOfficePoints + projPoints) * 100) / 100;
    }
  }

  // Awards points — realized reads awards.json, projection reads tony predictions
  // for E[Tony points] and realizes pre-Tony ceremonies that have already happened.
  let awardsPoints;
  let awardsList;
  let expectedAwardsBreakdown = null;
  if (mode === 'projection') {
    const realized = computeAwardsPoints(showId, awardsData, scoring.awards);
    const expected = show.eligible.tonys
      ? computeExpectedAwardsPoints(showId, tonyPredictions, scoring.awards)
      : { points: 0, breakdown: null };
    awardsPoints = Math.round((realized.points + expected.points) * 100) / 100;
    awardsList = [
      ...realized.awardsList,
      ...(expected.points > 0 ? [`E[Tonys]: ${expected.points} pts`] : []),
    ];
    expectedAwardsBreakdown = expected.breakdown;
  } else {
    const awardsResult = computeAwardsPoints(showId, awardsData, scoring.awards);
    awardsPoints = awardsResult.points;
    awardsList = awardsResult.awardsList;
  }

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
      ...(mode === 'projection' ? {
        projectedRemainingGross,
        projectionConfidence,
        expectedAwardsBreakdown,
      } : {}),
    },
  };
}

// Sort by total points for summary
const ranked = Object.entries(showScores)
  .sort((a, b) => b[1].totalPoints - a[1].totalPoints);

console.error(`Fantasy Scores Summary (mode=${mode}):`);
console.error(`  Shows scored: ${ranked.length}`);
console.error(`  Scoring window: ${meta.scoringStart} to ${meta.scoringEnd}`);
console.error(`  Latest grosses week: ${latestWeek}`);
console.error(`\nTop 15 by ${mode === 'projection' ? 'expected' : 'total'} points:`);
for (const [id, score] of ranked.slice(0, 15)) {
  const show = fantasyShows[id];
  console.error(`  ${score.totalPoints.toFixed(1).padStart(6)} pts  $${show.price.toString().padStart(2)}  ${show.title.substring(0, 35).padEnd(37)} CS:${score.criticScorePoints} AG:${score.audienceGradePoints} BO:${score.boxOfficePoints.toFixed(1)} AW:${score.awardsPoints}`);
}

const outFileName = mode === 'projection' ? 'fantasy-ev.json' : 'fantasy-scores.json';
const output = {
  _meta: {
    mode,
    lastUpdated: new Date().toISOString(),
    weekEnding: latestWeek,
    season: meta.season,
    ...(mode === 'projection' ? {
      predictionSource: tonyPredictions?._meta?.source || null,
      predictionLastUpdated: tonyPredictions?._meta?.lastUpdated || null,
      hasNominations: !!tonyPredictions?._meta?.hasNominations,
    } : {}),
  },
  showScores,
};

if (dryRun) {
  console.log(JSON.stringify(output, null, 2));
  console.error('\n--dry-run: output to stdout only');
} else {
  const outPath = path.join(dataDir, outFileName);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.error(`\nWrote ${outPath}`);
}
