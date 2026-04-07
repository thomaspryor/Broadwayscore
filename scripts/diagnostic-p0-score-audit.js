#!/usr/bin/env node
/**
 * P0 Score Corruption Diagnostic
 *
 * Scans all West End review-text files to find originalScore values that
 * are wrong — either from aggregator sources (should be aggregatorStars)
 * or from extractors that didn't find the rating in the actual review text.
 *
 * Outputs:
 *   1. Summary statistics
 *   2. Per-show impact analysis (how much composite scores are inflated)
 *   3. Full list of affected reviews for cleanup
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';

// Aggregator sources that should NEVER be in originalScore (should be aggregatorStars)
const AGGREGATOR_SCORE_SOURCES = new Set([
  'theatre-reviews-star-rating',
  'westendtheatre-star-rating',
  'show-score-stars',
  'stagedoor-star-rating',
  'lbo-star-rating',
  'lbo-css-stars',
  'thestage-roundup-star-rating',
]);

// Score sources that extract from the review page/text itself (should be verifiable)
const EXTRACTION_SOURCES = new Set([
  'explicit-rating',
  'unicode-stars',
  'json-ld',
  'dailymail-rating-img',
  'wos-star-images',
  'timeout-svg-stars',
  'telegraph-svg-stars',
  'stage-star-svg',
  'fivestar-widget',
  'star-class',
  'css-stars',
  'numeric-stars',
  'star-rating',
  'text-pattern',
  'word-stars',
  'original-star-rating',
]);

function textContainsStarRating(text, claimedScore) {
  if (!text) return false;

  // Parse claimed score
  const match = claimedScore.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (!match) return false;
  const claimed = parseFloat(match[1]);
  const outOf = parseInt(match[2]);

  // Check for unicode stars matching the claimed count
  const filledStars = (text.match(/★/g) || []).length;
  const emptyStars = (text.match(/☆/g) || []).length;
  if (filledStars > 0 && filledStars === claimed && (filledStars + emptyStars) === outOf) {
    return true;
  }

  // Check for explicit "X/Y" pattern
  const patterns = [
    new RegExp(`\\b${claimed}\\s*/\\s*${outOf}\\b`),
    new RegExp(`\\b${claimed}\\s+out\\s+of\\s+${outOf}\\b`, 'i'),
    new RegExp(`\\b${claimed}\\s+stars?\\b`, 'i'),
  ];

  // Also check for word-form ("five stars", "four out of five")
  const numWords = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
  if (numWords[claimed]) {
    patterns.push(new RegExp(`\\b${numWords[claimed]}\\s+stars?\\b`, 'i'));
    patterns.push(new RegExp(`\\b${numWords[claimed]}\\s+out\\s+of\\s+${numWords[outOf] || outOf}\\b`, 'i'));
  }

  return patterns.some(p => p.test(text));
}

function parseStarScore(scoreStr) {
  if (!scoreStr) return null;
  const match = String(scoreStr).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (!match) return null;
  return Math.round((parseFloat(match[1]) / parseInt(match[2])) * 100);
}

// Load reviews.json for current assigned scores
const reviewsData = require('../data/reviews.json');
const allReviews = Object.values(reviewsData).flat();
const reviewMap = new Map();
allReviews.forEach(r => {
  const key = `${r.showId}||${r.criticName}||${r.outletName}`;
  reviewMap.set(key, r);
});

// Scan all West End show directories
const shows = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
  try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory() && d.includes('west-end'); }
  catch (e) { return false; }
});

const issues = [];
const showImpact = {};

let totalFiles = 0;
let filesWithOrigScore = 0;
let aggregatorAsP0 = 0;
let extractionNoEvidence = 0;
let extractionVerified = 0;
let undefinedSource = 0;

for (const show of shows) {
  const showDir = path.join(REVIEW_TEXTS_DIR, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    totalFiles++;
    try {
      const filePath = path.join(showDir, file);
      const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      if (!d.originalScore) continue;
      filesWithOrigScore++;

      const scoreSource = d.scoreSource || 'undefined';
      const normalizedScore = parseStarScore(d.originalScore);
      if (normalizedScore === null) continue;

      let issueType = null;
      let detail = '';

      if (AGGREGATOR_SCORE_SOURCES.has(scoreSource)) {
        // Aggregator score stored as originalScore — should be aggregatorStars
        issueType = 'aggregator-as-p0';
        detail = `Aggregator source "${scoreSource}" stored as originalScore (should be aggregatorStars)`;
        aggregatorAsP0++;
      } else if (scoreSource === 'undefined' || !scoreSource) {
        // Unknown source — can't verify
        issueType = 'unknown-source';
        detail = `originalScore with no scoreSource — unverifiable`;
        undefinedSource++;
      } else if (EXTRACTION_SOURCES.has(scoreSource)) {
        // Extraction source — verify against fullText
        const text = d.fullText || d.showScoreExcerpt || '';
        if (textContainsStarRating(text, String(d.originalScore))) {
          extractionVerified++;
          continue; // This one is legit
        } else {
          issueType = 'extraction-no-evidence';
          detail = `scoreSource "${scoreSource}" claims "${d.originalScore}" but fullText (${text.length} chars) has no matching rating`;
          extractionNoEvidence++;
        }
      } else {
        // Other sources (guardian-api, llm-gemini, etc.) — generally trustworthy
        continue;
      }

      if (issueType) {
        const issue = {
          showId: show,
          file,
          critic: d.criticName || 'Unknown',
          outlet: d.outletName || d.outletId || 'Unknown',
          originalScore: d.originalScore,
          normalizedScore,
          scoreSource,
          issueType,
          detail,
          url: d.url || null,
          hasLlmScore: !!d.llmScore,
          llmScore: d.llmScore?.score || null,
          assignedScoreInFile: d.assignedScore || null,
        };

        // Check what reviews.json currently has
        const reviewKey = `${show}||${d.criticName}||${d.outletName}`;
        const currentReview = reviewMap.get(reviewKey);
        if (currentReview) {
          issue.currentReviewScore = currentReview.assignedScore;
          issue.currentScoreSource = currentReview.scoreSource;
        }

        issues.push(issue);

        // Track per-show impact
        if (!showImpact[show]) {
          showImpact[show] = { affectedReviews: 0, totalInflation: 0, reviews: [] };
        }
        showImpact[show].affectedReviews++;
        // Estimate inflation: difference between P0 score and what LLM would give
        if (issue.llmScore && normalizedScore > issue.llmScore) {
          showImpact[show].totalInflation += (normalizedScore - issue.llmScore);
        }
        showImpact[show].reviews.push({
          critic: issue.critic,
          outlet: issue.outlet,
          wrongScore: normalizedScore,
          llmScore: issue.llmScore,
          issueType,
        });
      }
    } catch (e) {
      // Skip parse errors
    }
  }
}

// Summary
console.log('=== P0 SCORE CORRUPTION DIAGNOSTIC ===\n');
console.log(`Total WE review-text files scanned: ${totalFiles}`);
console.log(`Files with originalScore: ${filesWithOrigScore}`);
console.log(`\n--- ISSUES FOUND ---`);
console.log(`Aggregator score stored as P0 (should be aggregatorStars): ${aggregatorAsP0}`);
console.log(`Extraction source with no evidence in text: ${extractionNoEvidence}`);
console.log(`Unknown source (no scoreSource field): ${undefinedSource}`);
console.log(`Extraction sources VERIFIED in text (legit): ${extractionVerified}`);
console.log(`\nTOTAL AFFECTED REVIEWS: ${issues.length}`);

// Break down by issue type and score
console.log('\n--- SCORE DISTRIBUTION OF AFFECTED REVIEWS ---');
const scoreDistrib = {};
issues.forEach(i => {
  const s = i.normalizedScore;
  scoreDistrib[s] = (scoreDistrib[s] || 0) + 1;
});
Object.entries(scoreDistrib).sort((a,b) => b[0]-a[0]).forEach(([score, count]) => {
  console.log(`  Score ${score}: ${count} reviews`);
});

// Show impact summary (sorted by affected count)
console.log('\n--- PER-SHOW IMPACT (top 20) ---');
const sortedShows = Object.entries(showImpact)
  .sort((a,b) => b[1].affectedReviews - a[1].affectedReviews)
  .slice(0, 20);

for (const [show, impact] of sortedShows) {
  console.log(`\n${show}: ${impact.affectedReviews} affected reviews (avg inflation: ${impact.totalInflation ? Math.round(impact.totalInflation / impact.affectedReviews) : '?'}pts)`);
  impact.reviews.forEach(r => {
    const delta = r.llmScore ? ` (LLM would give ${r.llmScore}, delta: ${r.wrongScore - r.llmScore})` : ' (no LLM fallback)';
    console.log(`  ${r.critic} | ${r.outlet} | wrong=${r.wrongScore} ${delta} | ${r.issueType}`);
  });
}

// Score 100 specifically
console.log('\n\n--- ALL SCORE-100 ISSUES (these are most visible) ---');
const score100Issues = issues.filter(i => i.normalizedScore === 100);
console.log(`Total: ${score100Issues.length}`);
score100Issues.forEach(i => {
  const delta = i.llmScore ? ` → LLM=${i.llmScore} (Δ${100 - i.llmScore})` : ' → no LLM fallback';
  console.log(`  ${i.showId} | ${i.critic} | ${i.outlet} | src=${i.scoreSource}${delta}`);
});

// Write full report to file
const report = {
  timestamp: new Date().toISOString(),
  summary: {
    totalFilesScanned: totalFiles,
    filesWithOriginalScore: filesWithOrigScore,
    aggregatorAsP0: aggregatorAsP0,
    extractionNoEvidence: extractionNoEvidence,
    unknownSource: undefinedSource,
    extractionVerified: extractionVerified,
    totalAffected: issues.length,
  },
  showImpact,
  issues,
};

fs.writeFileSync('data/audit/p0-score-corruption-report.json', JSON.stringify(report, null, 2));
console.log('\n\nFull report written to: data/audit/p0-score-corruption-report.json');
