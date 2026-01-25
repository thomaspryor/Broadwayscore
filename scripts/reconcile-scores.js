#!/usr/bin/env node
/**
 * Reconcile scores using review-texts files as source of truth
 * This script reads actual review data and corrects scores based on:
 * 1. Original star/letter ratings in review-texts
 * 2. DTLI/BWW thumbs in review-texts
 * 3. LLM scores in review-texts
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const reviewsJsonPath = path.join(__dirname, '../data/reviews.json');
const data = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));
let reviews = data.reviews;

// Score from thumbs
const THUMB_TO_SCORE = {
  'Up': 78,
  'Flat': 55,
  'Meh': 55,
  'Down': 35
};

// Score from star ratings
const STAR_TO_SCORE = {
  5: 92, 4: 82, 3: 63, 2: 45, 1: 25, 0: 10
};

const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 89,
  'B+': 85, 'B': 80, 'B-': 74,
  'C+': 67, 'C': 60, 'C-': 53,
  'D+': 45, 'D': 36, 'D-': 28,
  'F': 15
};

// Build lookup from review-texts
const reviewTextsMap = new Map();
const reviewTextsDir = path.join(__dirname, '../data/review-texts');

if (fs.existsSync(reviewTextsDir)) {
  const shows = fs.readdirSync(reviewTextsDir);
  shows.forEach(showId => {
    const showDir = path.join(reviewTextsDir, showId);
    if (fs.statSync(showDir).isDirectory()) {
      const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
      files.forEach(file => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
          const key = `${showId}|${(data.outletId || '').toLowerCase()}`;
          reviewTextsMap.set(key, data);
        } catch (e) {
          // skip invalid files
        }
      });
    }
  });
}

console.log(`Loaded ${reviewTextsMap.size} review-text files\n`);

// Key shows to focus on
const KEY_SHOWS = ['queen-versailles-2025', 'stereophonic-2024'];

let fixes = 0;

KEY_SHOWS.forEach(showId => {
  console.log(`\n=== ${showId.toUpperCase()} ===\n`);

  const showReviews = reviews.filter(r => r.showId === showId);

  showReviews.forEach(r => {
    const key = `${r.showId}|${(r.outletId || '').toLowerCase()}`;
    const textData = reviewTextsMap.get(key);

    let newScore = r.assignedScore;
    let reason = null;

    if (textData) {
      // Priority 1: LLM score if available
      if (textData.llmScore && textData.llmScore.score) {
        if (Math.abs(textData.llmScore.score - r.assignedScore) > 10) {
          newScore = textData.llmScore.score;
          reason = `LLM scored ${textData.llmScore.score}`;
        }
      }

      // Priority 2: Original star/letter rating in review-texts
      if (textData.originalScore) {
        const rating = textData.originalScore.toString();
        const starMatch = rating.match(/^(\d(?:\.\d)?)\s*(?:\/\s*5|stars?)/i);
        if (starMatch) {
          const stars = Math.round(parseFloat(starMatch[1]));
          if (STAR_TO_SCORE[stars]) {
            newScore = STAR_TO_SCORE[stars];
            reason = `originalScore=${rating}`;
          }
        }
        const letterMatch = rating.match(/^([A-D][+-]?|F)$/i);
        if (letterMatch) {
          const grade = letterMatch[1].toUpperCase();
          if (LETTER_TO_SCORE[grade]) {
            newScore = LETTER_TO_SCORE[grade];
            reason = `originalScore=${rating}`;
          }
        }
      }

      // Priority 3: DTLI/BWW thumb if current score conflicts
      const dtliThumb = textData.dtliThumb;
      const bwwThumb = textData.bwwThumb;

      if (dtliThumb === 'Down' && r.assignedScore > 55) {
        newScore = 35;
        reason = `dtliThumb=Down`;
      } else if (bwwThumb === 'Down' && r.assignedScore > 55) {
        newScore = 35;
        reason = `bwwThumb=Down`;
      }

      // Check for designation bonus
      if (textData.designation === 'Critics_Pick' && newScore < 80) {
        newScore = 82;
        reason = `Critics_Pick designation`;
      }
    }

    if (newScore !== r.assignedScore && reason) {
      console.log(`${r.outlet}: ${r.assignedScore} → ${newScore} (${reason})`);
      r.assignedScore = newScore;
      r.bucket = newScore >= 85 ? 'Rave' : newScore >= 70 ? 'Positive' : newScore >= 50 ? 'Mixed' : newScore >= 35 ? 'Negative' : 'Pan';
      fixes++;
    } else {
      console.log(`${r.outlet}: ${r.assignedScore} (no change)`);
    }
  });
});

// Save
data.reviews = reviews;
data._meta.lastUpdated = new Date().toISOString().split('T')[0];
fs.writeFileSync(reviewsJsonPath, JSON.stringify(data, null, 2));

console.log(`\nFixed ${fixes} scores`);

// Validate
console.log('\n=== VALIDATION ===\n');

function getShowAverage(showId) {
  const showReviews = reviews.filter(r => r.showId === showId && r.assignedScore != null);
  if (showReviews.length === 0) return null;
  const avg = showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length;
  return { avg: avg.toFixed(1), count: showReviews.length };
}

const qov = getShowAverage('queen-versailles-2025');
console.log(`Queen of Versailles: ${qov?.avg} (${qov?.count} reviews) - TARGET: 45-55`);
console.log(`  Status: ${qov && parseFloat(qov.avg) >= 45 && parseFloat(qov.avg) <= 55 ? '✓ PASS' : '✗ FAIL'}`);

const stereo = getShowAverage('stereophonic-2024');
console.log(`Stereophonic: ${stereo?.avg} (${stereo?.count} reviews) - TARGET: 85-95`);
console.log(`  Status: ${stereo && parseFloat(stereo.avg) >= 85 && parseFloat(stereo.avg) <= 95 ? '✓ PASS' : '✗ FAIL'}`);
