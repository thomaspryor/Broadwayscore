#!/usr/bin/env node

/**
 * audit-audience-scores.js
 *
 * Comprehensive audit of audience-buzz.json data quality.
 * Checks for score range violations, missing/orphan entries, source consistency,
 * outliers, stale data, weighting sanity, Reddit quality, designation consistency,
 * and cross-source divergence.
 *
 * Usage:
 *   node scripts/audit-audience-scores.js [--show=SLUG] [--verbose]
 *
 * Output:
 *   data/audit/audience-score-audit.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');

// Parse CLI args
const args = process.argv.slice(2);
const SHOW_FILTER = args.find(a => a.startsWith('--show='))?.split('=')[1];
const VERBOSE = args.includes('--verbose');

// Load audience weighting module for recomputation
const { calculateCombinedScore, isRedditEligible, MIN_REDDIT_ITEMS } = require('./lib/audience-weighting');

// ─── Load data ──────────────────────────────────────────────────────────────

const audienceBuzz = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'audience-buzz.json'), 'utf8'));
const showsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
const showsList = showsRaw.shows || showsRaw;

// Build show lookup by ID
const showById = {};
if (Array.isArray(showsList)) {
  for (const s of showsList) showById[s.id] = s;
} else {
  for (const [id, s] of Object.entries(showsList)) showById[id] = s;
}

const buzzShows = audienceBuzz.shows || {};

// ─── Designation thresholds (from _meta) ────────────────────────────────────

const DESIGNATION_RANGES = {
  'Loving':    { min: 88, max: 100 },
  'Liking':    { min: 78, max: 87 },
  'Shrugging': { min: 68, max: 77 },
  'Loathing':  { min: 0,  max: 67 },
};

function expectedDesignation(score) {
  if (score == null) return null;
  if (score >= 88) return 'Loving';
  if (score >= 78) return 'Liking';
  if (score >= 68) return 'Shrugging';
  return 'Loathing';
}

// ─── Collect issues ─────────────────────────────────────────────────────────

const issues = [];

function addIssue(type, severity, showId, detail) {
  issues.push({ type, severity, showId, detail });
}

// ─── Stats tracking ─────────────────────────────────────────────────────────

const stats = {
  totalBuzzEntries: 0,
  totalShows: Object.keys(showById).length,
  showsWithBuzz: 0,
  showsWithoutBuzz: 0,
  openShowsWithBuzz: 0,
  openShowsWithoutBuzz: 0,
  previewsShowsWithBuzz: 0,
  previewsShowsWithoutBuzz: 0,
  closedShowsWithBuzz: 0,
  closedShowsWithoutBuzz: 0,
  sourceBreakdown: {
    showScore: 0,
    mezzanine: 0,
    reddit: 0,
    all3: 0,
    ss_mezz_only: 0,
    ss_only: 0,
    mezz_only: 0,
    reddit_only: 0,
  },
  designationBreakdown: {
    Loving: 0,
    Liking: 0,
    Shrugging: 0,
    Loathing: 0,
    missing: 0,
  },
  issuesBySeverity: { high: 0, medium: 0, low: 0 },
  issuesByType: {},
};

// ─── AUDIT 1: Score range violations ────────────────────────────────────────

console.log('=== Audit 1: Score range violations ===');
let rangeViolations = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  stats.totalBuzzEntries++;

  // Check combinedScore
  if (entry.combinedScore != null) {
    if (entry.combinedScore < 0 || entry.combinedScore > 100) {
      addIssue('score-range-violation', 'high', showId,
        `combinedScore ${entry.combinedScore} is outside 0-100 range`);
      rangeViolations++;
    }
    if (!Number.isInteger(entry.combinedScore)) {
      addIssue('score-range-violation', 'medium', showId,
        `combinedScore ${entry.combinedScore} is not an integer`);
      rangeViolations++;
    }
  }

  // Check each source score
  const sources = entry.sources || {};
  for (const [srcName, srcData] of Object.entries(sources)) {
    if (!srcData || srcData.score == null) continue;
    if (srcData.score < 0 || srcData.score > 100) {
      addIssue('score-range-violation', 'high', showId,
        `${srcName} score ${srcData.score} is outside 0-100 range`);
      rangeViolations++;
    }
  }

  // Check Reddit sentiment values are 0-1
  if (sources.reddit?.sentiment) {
    const sent = sources.reddit.sentiment;
    for (const [key, val] of Object.entries(sent)) {
      if (typeof val === 'number' && (val < 0 || val > 1)) {
        addIssue('score-range-violation', 'medium', showId,
          `reddit.sentiment.${key} = ${val} is outside 0-1 range`);
        rangeViolations++;
      }
    }
    // Check sentiment sums to roughly 1.0
    const sentSum = Object.values(sent).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    if (sentSum > 0 && (sentSum < 0.85 || sentSum > 1.15)) {
      addIssue('score-range-violation', 'low', showId,
        `reddit sentiment sums to ${sentSum.toFixed(3)}, expected ~1.0`);
      rangeViolations++;
    }
  }

  // Check positiveRate 0-1
  if (sources.reddit?.positiveRate != null) {
    if (sources.reddit.positiveRate < 0 || sources.reddit.positiveRate > 1) {
      addIssue('score-range-violation', 'medium', showId,
        `reddit.positiveRate ${sources.reddit.positiveRate} is outside 0-1 range`);
      rangeViolations++;
    }
  }

  // Check starRating 0-5
  if (sources.mezzanine?.starRating != null) {
    if (sources.mezzanine.starRating < 0 || sources.mezzanine.starRating > 5) {
      addIssue('score-range-violation', 'medium', showId,
        `mezzanine.starRating ${sources.mezzanine.starRating} is outside 0-5 range`);
      rangeViolations++;
    }
  }
}
console.log(`  Found ${rangeViolations} range violations`);

// ─── AUDIT 2: Missing shows (in shows.json but not audience-buzz.json) ──────

console.log('\n=== Audit 2: Missing shows ===');
let missingOpen = 0, missingPreviews = 0, missingClosed = 0;

for (const [showId, show] of Object.entries(showById)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;

  const hasBuzz = showId in buzzShows;

  if (show.status === 'open') {
    if (hasBuzz) stats.openShowsWithBuzz++;
    else {
      stats.openShowsWithoutBuzz++;
      addIssue('missing-show', 'high', showId,
        `Open show "${show.title}" has no audience buzz data`);
      missingOpen++;
    }
  } else if (show.status === 'previews') {
    if (hasBuzz) stats.previewsShowsWithBuzz++;
    else {
      stats.previewsShowsWithoutBuzz++;
      addIssue('missing-show', 'medium', showId,
        `Previews show "${show.title}" has no audience buzz data`);
      missingPreviews++;
    }
  } else {
    if (hasBuzz) stats.closedShowsWithBuzz++;
    else {
      stats.closedShowsWithoutBuzz++;
      // Closed shows without buzz is low severity — many older shows simply lack data
      // Only flag if it's a relatively recent show (2020+)
      const year = show.openingDate ? parseInt(show.openingDate.slice(0, 4)) : 0;
      if (year >= 2020) {
        addIssue('missing-show', 'low', showId,
          `Closed show "${show.title}" (${show.openingDate || 'no date'}) has no audience buzz data`);
        missingClosed++;
      }
    }
  }
}

stats.showsWithBuzz = stats.openShowsWithBuzz + stats.previewsShowsWithBuzz + stats.closedShowsWithBuzz;
stats.showsWithoutBuzz = stats.openShowsWithoutBuzz + stats.previewsShowsWithoutBuzz + stats.closedShowsWithoutBuzz;

console.log(`  Missing open: ${missingOpen}, previews: ${missingPreviews}, closed (2020+): ${missingClosed}`);

// ─── AUDIT 3: Orphan entries ────────────────────────────────────────────────

console.log('\n=== Audit 3: Orphan entries ===');
let orphanCount = 0;

for (const showId of Object.keys(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  if (!(showId in showById)) {
    addIssue('orphan-entry', 'medium', showId,
      `Audience buzz entry exists for "${buzzShows[showId].title || showId}" but no matching show in shows.json`);
    orphanCount++;
  }
}
console.log(`  Found ${orphanCount} orphan entries`);

// ─── AUDIT 4: Source consistency ────────────────────────────────────────────

console.log('\n=== Audit 4: Source consistency ===');
let consistencyIssues = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;

  const sources = entry.sources || {};

  for (const [srcName, srcData] of Object.entries(sources)) {
    if (!srcData) continue; // null source is fine

    // Score without reviewCount
    if (srcData.score != null && (srcData.reviewCount == null || srcData.reviewCount === 0)) {
      addIssue('source-consistency', 'medium', showId,
        `${srcName} has score=${srcData.score} but reviewCount=${srcData.reviewCount || 0}`);
      consistencyIssues++;
    }

    // reviewCount without score
    if (srcData.reviewCount > 0 && srcData.score == null) {
      addIssue('source-consistency', 'medium', showId,
        `${srcName} has reviewCount=${srcData.reviewCount} but no score`);
      consistencyIssues++;
    }

    // Negative reviewCount
    if (srcData.reviewCount != null && srcData.reviewCount < 0) {
      addIssue('source-consistency', 'high', showId,
        `${srcName} has negative reviewCount=${srcData.reviewCount}`);
      consistencyIssues++;
    }
  }

  // combinedScore null but valid sources exist
  const activeSources = Object.entries(sources).filter(([_, s]) => s && s.score != null && s.reviewCount > 0);
  if (activeSources.length > 0 && entry.combinedScore == null) {
    addIssue('source-consistency', 'high', showId,
      `Has ${activeSources.length} active source(s) but combinedScore is null`);
    consistencyIssues++;
  }

  // combinedScore set but no active sources
  if (activeSources.length === 0 && entry.combinedScore != null) {
    addIssue('source-consistency', 'high', showId,
      `combinedScore=${entry.combinedScore} but no active sources with score + reviewCount`);
    consistencyIssues++;
  }

  // Missing designation when combinedScore exists
  if (entry.combinedScore != null && !entry.designation) {
    addIssue('source-consistency', 'medium', showId,
      `combinedScore=${entry.combinedScore} but no designation`);
    consistencyIssues++;
  }

  // Source count tracking
  const hasShowScore = sources.showScore?.score != null && sources.showScore.reviewCount > 0;
  const hasMezzanine = sources.mezzanine?.score != null && sources.mezzanine.reviewCount > 0;
  const hasReddit = sources.reddit?.score != null && sources.reddit.reviewCount > 0;

  if (hasShowScore) stats.sourceBreakdown.showScore++;
  if (hasMezzanine) stats.sourceBreakdown.mezzanine++;
  if (hasReddit) stats.sourceBreakdown.reddit++;
  if (hasShowScore && hasMezzanine && hasReddit) stats.sourceBreakdown.all3++;
  if (hasShowScore && hasMezzanine && !hasReddit) stats.sourceBreakdown.ss_mezz_only++;
  if (hasShowScore && !hasMezzanine && !hasReddit) stats.sourceBreakdown.ss_only++;
  if (!hasShowScore && hasMezzanine && !hasReddit) stats.sourceBreakdown.mezz_only++;
  if (!hasShowScore && !hasMezzanine && hasReddit) stats.sourceBreakdown.reddit_only++;
}
console.log(`  Found ${consistencyIssues} source consistency issues`);

// ─── AUDIT 5: Score outliers ────────────────────────────────────────────────

console.log('\n=== Audit 5: Score outliers ===');
let outlierCount = 0;

// Collect all combinedScores for statistical analysis
const allCombined = [];
for (const [_, entry] of Object.entries(buzzShows)) {
  if (entry.combinedScore != null) allCombined.push(entry.combinedScore);
}
allCombined.sort((a, b) => a - b);

const median = allCombined[Math.floor(allCombined.length / 2)] || 0;
const mean = allCombined.reduce((a, b) => a + b, 0) / (allCombined.length || 1);
const stddev = Math.sqrt(allCombined.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (allCombined.length || 1));

stats.scoreDistribution = {
  min: allCombined[0] || null,
  max: allCombined[allCombined.length - 1] || null,
  mean: Math.round(mean * 10) / 10,
  median,
  stddev: Math.round(stddev * 10) / 10,
  count: allCombined.length,
};

// Flag extreme outliers (>3 stddev from mean)
for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  if (entry.combinedScore == null) continue;

  const zScore = (entry.combinedScore - mean) / (stddev || 1);
  if (Math.abs(zScore) > 3) {
    addIssue('score-outlier', 'low', showId,
      `combinedScore ${entry.combinedScore} is ${zScore > 0 ? 'extremely high' : 'extremely low'} (z-score: ${zScore.toFixed(2)}, mean: ${mean.toFixed(1)}, stddev: ${stddev.toFixed(1)})`);
    outlierCount++;
  }

  // Per-source outlier: individual source score far from combinedScore
  const sources = entry.sources || {};
  for (const [srcName, srcData] of Object.entries(sources)) {
    if (!srcData || srcData.score == null) continue;
    const diff = Math.abs(srcData.score - entry.combinedScore);
    if (diff > 25) {
      addIssue('score-outlier', 'low', showId,
        `${srcName} score ${srcData.score} differs from combinedScore ${entry.combinedScore} by ${diff} points`);
      outlierCount++;
    }
  }
}
console.log(`  Found ${outlierCount} score outliers`);

// ─── AUDIT 6: Stale data — open shows with no audience data ────────────────

console.log('\n=== Audit 6: Stale data ===');
let staleCount = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;

  const show = showById[showId];
  if (!show) continue;

  const sources = entry.sources || {};
  const activeSources = Object.entries(sources).filter(([_, s]) => s && s.score != null && s.reviewCount > 0);

  // Open show with only 1 source (should have at least 2 for meaningful data)
  if (show.status === 'open' && activeSources.length === 1) {
    addIssue('stale-data', 'low', showId,
      `Open show "${show.title}" has only 1 active source (${activeSources[0][0]})`);
    staleCount++;
  }

  // Open/previews show with very low total reviewCount (<10)
  if ((show.status === 'open' || show.status === 'previews') && activeSources.length > 0) {
    const totalReviews = activeSources.reduce((sum, [_, s]) => sum + (s.reviewCount || 0), 0);
    if (totalReviews < 10) {
      addIssue('stale-data', 'medium', showId,
        `Active show "${show.title}" has only ${totalReviews} total reviews across all sources`);
      staleCount++;
    }
  }

  // Reddit data with old lastUpdated (>30 days) for open shows
  if (show.status === 'open' && sources.reddit?.lastUpdated) {
    const lastUpdate = new Date(sources.reddit.lastUpdated);
    const now = new Date();
    const daysSince = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));
    if (daysSince > 30) {
      addIssue('stale-data', 'medium', showId,
        `Open show "${show.title}" has Reddit data last updated ${daysSince} days ago (${sources.reddit.lastUpdated})`);
      staleCount++;
    }
  }
}
console.log(`  Found ${staleCount} stale data issues`);

// ─── AUDIT 7: Weighting sanity ──────────────────────────────────────────────

console.log('\n=== Audit 7: Weighting sanity ===');
let weightingIssues = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  if (entry.combinedScore == null) continue;

  const show = showById[showId];
  const showInfo = show ? { closingDate: show.closingDate, status: show.status, category: show.category } : undefined;

  // Recompute the combined score using the shared weighting module
  const { score: recomputed } = calculateCombinedScore(entry.sources || {}, showInfo);

  if (recomputed == null) continue;

  const diff = Math.abs(entry.combinedScore - recomputed);
  if (diff > 2) {
    addIssue('weighting-mismatch', 'medium', showId,
      `combinedScore ${entry.combinedScore} differs from recomputed ${recomputed} by ${diff} points (may indicate stale weighting)`);
    weightingIssues++;
  } else if (diff > 0 && VERBOSE) {
    // Minor rounding difference, only in verbose mode
    console.log(`  [info] ${showId}: stored=${entry.combinedScore}, recomputed=${recomputed} (diff=${diff})`);
  }
}
console.log(`  Found ${weightingIssues} weighting mismatches (>2pt diff)`);

// ─── AUDIT 8: Reddit quality ────────────────────────────────────────────────

console.log('\n=== Audit 8: Reddit quality ===');
let redditQualityIssues = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;

  const reddit = entry.sources?.reddit;
  if (!reddit || reddit.score == null) continue;

  // Missing totalPosts/totalComments (legacy junk per MEMORY.md)
  if (reddit.totalPosts == null || reddit.totalComments == null) {
    addIssue('reddit-quality', 'medium', showId,
      `Reddit entry missing totalPosts (${reddit.totalPosts}) or totalComments (${reddit.totalComments}) — legacy junk data`);
    redditQualityIssues++;
  }

  // reviewCount below MIN_REDDIT_ITEMS threshold but still included
  if (reddit.reviewCount > 0 && reddit.reviewCount < MIN_REDDIT_ITEMS) {
    addIssue('reddit-quality', 'medium', showId,
      `Reddit reviewCount ${reddit.reviewCount} is below minimum threshold of ${MIN_REDDIT_ITEMS} — should be excluded from weighting`);
    redditQualityIssues++;
  }

  // Missing sentiment object
  if (reddit.score != null && !reddit.sentiment) {
    addIssue('reddit-quality', 'low', showId,
      `Reddit has score=${reddit.score} but missing sentiment breakdown`);
    redditQualityIssues++;
  }

  // Missing positiveRate
  if (reddit.score != null && reddit.positiveRate == null) {
    addIssue('reddit-quality', 'low', showId,
      `Reddit has score=${reddit.score} but missing positiveRate`);
    redditQualityIssues++;
  }

  // Sanity: positiveRate should roughly align with score
  // A score of 80+ with a positiveRate < 0.3 or score < 40 with positiveRate > 0.8 is suspect
  if (reddit.score != null && reddit.positiveRate != null) {
    if (reddit.score >= 80 && reddit.positiveRate < 0.3) {
      addIssue('reddit-quality', 'medium', showId,
        `Reddit score ${reddit.score} but positiveRate only ${reddit.positiveRate.toFixed(3)} — seems inconsistent`);
      redditQualityIssues++;
    }
    if (reddit.score <= 40 && reddit.positiveRate > 0.8) {
      addIssue('reddit-quality', 'medium', showId,
        `Reddit score ${reddit.score} but positiveRate is ${reddit.positiveRate.toFixed(3)} — seems inconsistent`);
      redditQualityIssues++;
    }
  }

  // Check for closed >3 years ago shows still carrying Reddit data
  const show = showById[showId];
  if (show && show.status === 'closed' && show.closingDate) {
    const closed = new Date(show.closingDate);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 3);
    if (closed < cutoff && reddit.reviewCount >= MIN_REDDIT_ITEMS) {
      addIssue('reddit-quality', 'low', showId,
        `Closed show (${show.closingDate}) >3 years ago still has Reddit data with ${reddit.reviewCount} reviews — should be excluded by recency gate`);
      redditQualityIssues++;
    }
  }
}
console.log(`  Found ${redditQualityIssues} Reddit quality issues`);

// ─── AUDIT 9: Designation consistency ───────────────────────────────────────

console.log('\n=== Audit 9: Designation consistency ===');
let designationIssues = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;

  // Track designation breakdown
  if (entry.designation && stats.designationBreakdown[entry.designation] != null) {
    stats.designationBreakdown[entry.designation]++;
  } else if (!entry.designation) {
    stats.designationBreakdown.missing++;
  }

  if (entry.combinedScore == null || !entry.designation) continue;

  const expected = expectedDesignation(entry.combinedScore);
  if (expected !== entry.designation) {
    addIssue('designation-mismatch', 'medium', showId,
      `combinedScore ${entry.combinedScore} should be "${expected}" but designation is "${entry.designation}"`);
    designationIssues++;
  }
}
console.log(`  Found ${designationIssues} designation mismatches`);

// ─── AUDIT 10: Cross-source divergence ──────────────────────────────────────

console.log('\n=== Audit 10: Cross-source divergence ===');
let divergenceCount = 0;

for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;

  const sources = entry.sources || {};
  const activeScores = [];

  for (const [srcName, srcData] of Object.entries(sources)) {
    if (srcData && srcData.score != null && srcData.reviewCount > 0) {
      activeScores.push({ name: srcName, score: srcData.score });
    }
  }

  if (activeScores.length < 2) continue;

  // Find max spread
  const scores = activeScores.map(s => s.score);
  const maxSpread = Math.max(...scores) - Math.min(...scores);

  if (maxSpread > 30) {
    const detail = activeScores.map(s => `${s.name}=${s.score}`).join(', ');
    addIssue('cross-source-divergence', 'medium', showId,
      `Sources wildly disagree (${maxSpread}pt spread): ${detail}`);
    divergenceCount++;
  } else if (maxSpread > 20) {
    const detail = activeScores.map(s => `${s.name}=${s.score}`).join(', ');
    addIssue('cross-source-divergence', 'low', showId,
      `Notable source disagreement (${maxSpread}pt spread): ${detail}`);
    divergenceCount++;
  }
}
console.log(`  Found ${divergenceCount} cross-source divergences`);

// ─── Additional checks ─────────────────────────────────────────────────────

console.log('\n=== Additional checks ===');

// Check for missing title field
let missingTitles = 0;
for (const [showId, entry] of Object.entries(buzzShows)) {
  if (!entry.title) {
    addIssue('missing-title', 'low', showId,
      `Audience buzz entry has no title field`);
    missingTitles++;
  }
}
console.log(`  Missing titles: ${missingTitles}`);

// Check for duplicate-ish entries (same title, different IDs)
const titleToIds = {};
for (const [showId, entry] of Object.entries(buzzShows)) {
  const title = (entry.title || '').toLowerCase().trim();
  if (!title) continue;
  if (!titleToIds[title]) titleToIds[title] = [];
  titleToIds[title].push(showId);
}
let duplicateTitleCount = 0;
for (const [title, ids] of Object.entries(titleToIds)) {
  if (ids.length > 1) {
    // Only flag if they are truly unexpected duplicates (not known revivals)
    addIssue('possible-duplicate', 'low', ids[0],
      `Multiple entries share title "${title}": ${ids.join(', ')}`);
    duplicateTitleCount++;
  }
}
console.log(`  Possible duplicate titles: ${duplicateTitleCount}`);

// Check mezzanine starRating consistency with score
let starRatingIssues = 0;
for (const [showId, entry] of Object.entries(buzzShows)) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  const mezz = entry.sources?.mezzanine;
  if (!mezz || mezz.score == null || mezz.starRating == null) continue;

  // starRating is on 0-5 scale, score is 0-100. Rough mapping: starRating * 20 ~ score
  const expectedScore = mezz.starRating * 20;
  const diff = Math.abs(mezz.score - expectedScore);
  if (diff > 15) {
    addIssue('mezzanine-star-score-mismatch', 'low', showId,
      `Mezzanine score=${mezz.score} but starRating=${mezz.starRating} (expected ~${expectedScore})`);
    starRatingIssues++;
  }
}
console.log(`  Mezzanine star/score mismatches: ${starRatingIssues}`);

// ─── Summarize ──────────────────────────────────────────────────────────────

// Count issues by severity and type
for (const issue of issues) {
  stats.issuesBySeverity[issue.severity] = (stats.issuesBySeverity[issue.severity] || 0) + 1;
  stats.issuesByType[issue.type] = (stats.issuesByType[issue.type] || 0) + 1;
}

const coveragePct = stats.totalShows > 0
  ? Math.round((stats.showsWithBuzz / stats.totalShows) * 1000) / 10
  : 0;

const report = {
  _meta: {
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/audit-audience-scores.js',
    audienceBuzzLastUpdated: audienceBuzz._meta?.lastUpdated || audienceBuzz.lastUpdated || null,
  },
  summary: {
    totalShowsInShowsJson: stats.totalShows,
    totalBuzzEntries: stats.totalBuzzEntries,
    coverage: {
      total: `${stats.showsWithBuzz}/${stats.totalShows} (${coveragePct}%)`,
      open: `${stats.openShowsWithBuzz}/${stats.openShowsWithBuzz + stats.openShowsWithoutBuzz}`,
      previews: `${stats.previewsShowsWithBuzz}/${stats.previewsShowsWithBuzz + stats.previewsShowsWithoutBuzz}`,
      closed: `${stats.closedShowsWithBuzz}/${stats.closedShowsWithBuzz + stats.closedShowsWithoutBuzz}`,
    },
    sourceBreakdown: stats.sourceBreakdown,
    designationBreakdown: stats.designationBreakdown,
    scoreDistribution: stats.scoreDistribution,
    issuesBySeverity: stats.issuesBySeverity,
    issuesByType: stats.issuesByType,
    totalIssues: issues.length,
  },
  issues,
};

// ─── Write report ───────────────────────────────────────────────────────────

if (!fs.existsSync(AUDIT_DIR)) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

const outputPath = path.join(AUDIT_DIR, 'audience-score-audit.json');
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

// ─── Console summary ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('AUDIENCE SCORE AUDIT SUMMARY');
console.log('='.repeat(60));
console.log(`Total shows in shows.json:  ${stats.totalShows}`);
console.log(`Total audience buzz entries: ${stats.totalBuzzEntries}`);
console.log(`Coverage: ${coveragePct}%`);
console.log(`  Open:     ${stats.openShowsWithBuzz}/${stats.openShowsWithBuzz + stats.openShowsWithoutBuzz}`);
console.log(`  Previews: ${stats.previewsShowsWithBuzz}/${stats.previewsShowsWithBuzz + stats.previewsShowsWithoutBuzz}`);
console.log(`  Closed:   ${stats.closedShowsWithBuzz}/${stats.closedShowsWithBuzz + stats.closedShowsWithoutBuzz}`);
console.log('');
console.log('Source breakdown:');
console.log(`  ShowScore:       ${stats.sourceBreakdown.showScore}`);
console.log(`  Mezzanine:       ${stats.sourceBreakdown.mezzanine}`);
console.log(`  Reddit:          ${stats.sourceBreakdown.reddit}`);
console.log(`  All 3 sources:   ${stats.sourceBreakdown.all3}`);
console.log(`  SS+Mezz only:    ${stats.sourceBreakdown.ss_mezz_only}`);
console.log(`  SS only:         ${stats.sourceBreakdown.ss_only}`);
console.log(`  Mezz only:       ${stats.sourceBreakdown.mezz_only}`);
console.log(`  Reddit only:     ${stats.sourceBreakdown.reddit_only}`);
console.log('');
console.log('Designation breakdown:');
for (const [d, count] of Object.entries(stats.designationBreakdown)) {
  console.log(`  ${d}: ${count}`);
}
console.log('');
console.log('Score distribution:');
if (stats.scoreDistribution) {
  console.log(`  Min: ${stats.scoreDistribution.min}, Max: ${stats.scoreDistribution.max}`);
  console.log(`  Mean: ${stats.scoreDistribution.mean}, Median: ${stats.scoreDistribution.median}`);
  console.log(`  Stddev: ${stats.scoreDistribution.stddev}`);
}
console.log('');
console.log(`TOTAL ISSUES: ${issues.length}`);
console.log(`  High:   ${stats.issuesBySeverity.high || 0}`);
console.log(`  Medium: ${stats.issuesBySeverity.medium || 0}`);
console.log(`  Low:    ${stats.issuesBySeverity.low || 0}`);
console.log('');
console.log('Issues by type:');
for (const [type, count] of Object.entries(stats.issuesByType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}
console.log('');
console.log(`Report written to: ${outputPath}`);
