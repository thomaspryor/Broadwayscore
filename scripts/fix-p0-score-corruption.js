#!/usr/bin/env node
/**
 * Fix P0 Score Corruption — Tier 1 + 1.5
 *
 * Moves aggregator-sourced originalScore values to aggregatorStars where they belong,
 * and clears suspicious extraction scores that have no evidence in review text.
 *
 * Tier 1a: scoreSource is a known AGGREGATOR_SCORE_SOURCE → move to aggregatorStars
 * Tier 1b: source is an aggregator roundup but scoreSource says 'explicit-rating' → move to aggregatorStars
 * Tier 1c: source='westendtheatre' with no scoreSource → move to aggregatorStars
 * Tier 1.5: unicode-stars/text-pattern/word-stars with no evidence in fullText → clear with flag
 *
 * Usage:
 *   node scripts/fix-p0-score-corruption.js --dry-run   # Report only
 *   node scripts/fix-p0-score-corruption.js              # Fix files
 */

const fs = require('fs');
const path = require('path');
const { AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');

const DRY_RUN = process.argv.includes('--dry-run');
const WEST_END_ONLY = !process.argv.includes('--all-markets');
const baseDir = path.join(__dirname, '..', 'data', 'review-texts');

// Aggregator roundup sources that sometimes get mislabeled as explicit-rating
const AGGREGATOR_ROUNDUP_SOURCES = new Set([
  'theatre-reviews-roundup',
  'showscore-roundup',
  'lbo-roundup',
]);

// Extraction sources to verify against fullText
const VERIFY_IN_TEXT_SOURCES = new Set([
  'unicode-stars',
  'text-pattern',
  'word-stars',
]);

function textContainsStarRating(text, claimedScore) {
  if (!text) return false;
  const match = String(claimedScore).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (!match) return false;
  const claimed = parseFloat(match[1]);
  const outOf = parseInt(match[2]);

  // Unicode stars
  const filledStars = (text.match(/★/g) || []).length;
  const emptyStars = (text.match(/☆/g) || []).length;
  if (filledStars > 0 && filledStars === claimed && (filledStars + emptyStars) === outOf) return true;

  // Explicit patterns
  const numWords = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
  const patterns = [
    new RegExp(`\\b${claimed}\\s*/\\s*${outOf}\\b`),
    new RegExp(`\\b${claimed}\\s+out\\s+of\\s+${outOf}\\b`, 'i'),
  ];
  if (numWords[claimed]) {
    patterns.push(new RegExp(`\\b${numWords[claimed]}\\s+stars?\\b`, 'i'));
  }
  return patterns.some(p => p.test(text));
}

const shows = fs.readdirSync(baseDir).filter(d => {
  try {
    if (!fs.statSync(path.join(baseDir, d)).isDirectory()) return false;
    return WEST_END_ONLY ? d.includes('west-end') : true;
  } catch { return false; }
});

const stats = {
  tier1a: 0, // Known aggregator scoreSource
  tier1b: 0, // Aggregator roundup mislabeled as explicit-rating
  tier1c: 0, // WET with no scoreSource
  tier15: 0, // Suspicious extraction with no text evidence
  skipped: 0,
  total: 0,
};
const affectedShows = new Set();

for (const show of shows) {
  const showDir = path.join(baseDir, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data.originalScore == null) continue;
      stats.total++;

      let tier = null;
      const scoreSource = data.scoreSource || null;
      const source = data.source || null;

      // Tier 1a: Known aggregator scoreSource
      if (scoreSource && AGGREGATOR_SCORE_SOURCES.has(scoreSource)) {
        tier = '1a';
        stats.tier1a++;
      }
      // Tier 1b: Aggregator roundup mislabeled as explicit-rating
      else if (scoreSource === 'explicit-rating' && source && AGGREGATOR_ROUNDUP_SOURCES.has(source)) {
        tier = '1b';
        stats.tier1b++;
      }
      // Tier 1c: WET source with no scoreSource
      else if (source === 'westendtheatre' && !scoreSource) {
        tier = '1c';
        stats.tier1c++;
      }
      // Tier 1.5: Extraction source with no evidence in text
      else if (scoreSource && VERIFY_IN_TEXT_SOURCES.has(scoreSource)) {
        const text = data.fullText || '';
        if (!textContainsStarRating(text, String(data.originalScore))) {
          tier = '1.5';
          stats.tier15++;
        }
      }

      if (!tier) {
        stats.skipped++;
        continue;
      }

      affectedShows.add(show);

      if (tier.startsWith('1') && tier !== '1.5') {
        // Aggregator fix: move to aggregatorStars
        if (!DRY_RUN) {
          data.aggregatorStars = data.aggregatorStars || data.originalScore;
          data.previousOriginalScore = data.originalScore;
          data.originalScore = null;
          data.originalScoreCleared = true;
          data.originalScoreClearedReason = `aggregator-score-in-p0-slot (tier ${tier})`;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        console.log(`${DRY_RUN ? '[DRY] ' : ''}[T${tier}] ${show}/${file}: ${scoreSource || source} "${data.originalScore || data.previousOriginalScore}" → aggregatorStars`);
      } else {
        // Tier 1.5: Clear suspicious extraction
        if (!DRY_RUN) {
          data.previousOriginalScore = data.originalScore;
          data.originalScore = null;
          data.originalScoreCleared = true;
          data.originalScoreClearedReason = `extraction-no-evidence-in-text (tier 1.5, was ${scoreSource})`;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        console.log(`${DRY_RUN ? '[DRY] ' : ''}[T1.5] ${show}/${file}: ${scoreSource} "${data.originalScore || data.previousOriginalScore}" cleared (no text evidence)`);
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
}

console.log('\n=== Summary ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
console.log(`Total files with originalScore: ${stats.total}`);
console.log(`Tier 1a (aggregator scoreSource): ${stats.tier1a}`);
console.log(`Tier 1b (aggregator roundup mislabeled): ${stats.tier1b}`);
console.log(`Tier 1c (WET with no scoreSource): ${stats.tier1c}`);
console.log(`Tier 1.5 (extraction no evidence): ${stats.tier15}`);
console.log(`Total fixed: ${stats.tier1a + stats.tier1b + stats.tier1c + stats.tier15}`);
console.log(`Skipped (not in scope): ${stats.skipped}`);
console.log(`Affected shows: ${affectedShows.size}`);
console.log(`\nShows: ${[...affectedShows].sort().join(', ')}`);
