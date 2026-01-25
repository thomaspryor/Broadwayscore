#!/usr/bin/env node
/**
 * Score remaining unscored reviews with improved sentiment analysis
 * Includes Broadway-specific vocabulary and more comprehensive keywords
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Expanded sentiment keywords for theater reviews
const RAVE_WORDS = [
  'masterpiece', 'brilliant', 'extraordinary', 'magnificent', 'stunning', 'superb',
  'phenomenal', 'triumphant', 'dazzling', 'unmissable', 'transcendent', 'unforgettable',
  'thrilling', 'sensational', 'breathtaking', 'spellbinding', 'electrifying', 'rapturous',
  'exhilarating', 'glorious', 'sublime', 'perfection', 'flawless', 'knockout',
  'tour de force', 'astonishing', 'riveting', 'mesmerizing', 'hypnotic'
];

const POSITIVE_WORDS = [
  'excellent', 'wonderful', 'delightful', 'captivating', 'enchanting', 'entertaining',
  'enjoyable', 'impressive', 'remarkable', 'terrific', 'fantastic', 'great', 'lovely',
  'gorgeous', 'beautiful', 'touching', 'moving', 'powerful', 'clever', 'witty', 'smart',
  'inventive', 'winning', 'charming', 'magical', 'resplendent', 'joyous', 'exuberant',
  'rousing', 'spirited', 'lively', 'vibrant', 'engaging', 'absorbing', 'compelling',
  'satisfying', 'rewarding', 'accomplished', 'polished', 'well-crafted', 'well-staged',
  'well-sung', 'well sung', 'first-rate', 'first rate', 'top-notch', 'showstopper',
  'show-stopper', 'crowd-pleaser', 'crowd pleaser', 'hit', 'success', 'triumph',
  'winner', 'wins', 'outdoes', 'excels', 'shines', 'soars', 'dazzles', 'sparkles',
  'heartfelt', 'poignant', 'stirring', 'uplifting', 'inspired', 'imaginative',
  'innovative', 'fresh', 'original', 'creative', 'artful', 'skillful', 'expert',
  'happy', 'fun', 'funny', 'hilarious', 'laugh', 'laughs', 'humor', 'humorous'
];

const MIXED_POSITIVE_WORDS = [
  'solid', 'good', 'pleasant', 'decent', 'fine', 'nice', 'capable', 'competent',
  'adequate', 'respectable', 'serviceable', 'workmanlike', 'professional', 'polished',
  'effective', 'works', 'succeeds', 'delivers', 'entertaining enough', 'worth seeing'
];

const MIXED_WORDS = [
  'uneven', 'mixed', 'inconsistent', 'flawed', 'problematic', 'hit and miss',
  'hit-and-miss', 'ups and downs', 'highs and lows', 'despite', 'however', 'but',
  'although', 'yet', 'still', 'nonetheless', 'nevertheless', 'overlong', 'uneven',
  'bloated', 'padded', 'meandering', 'unfocused', 'muddled'
];

const NEGATIVE_WORDS = [
  'disappointing', 'tedious', 'dull', 'boring', 'lackluster', 'forgettable',
  'mediocre', 'weak', 'fails', 'misses', 'falls flat', 'underwhelming', 'predictable',
  'tired', 'stale', 'lifeless', 'flat', 'uninspired', 'uninspiring', 'plodding',
  'sluggish', 'dreary', 'listless', 'vapid', 'hollow', 'shallow', 'superficial',
  'forced', 'contrived', 'labored', 'clunky', 'awkward', 'misguided', 'misfire'
];

const PAN_WORDS = [
  'awful', 'terrible', 'disaster', 'waste', 'avoid', 'painful', 'unbearable',
  'worst', 'atrocious', 'dreadful', 'abysmal', 'execrable', 'horrendous', 'ghastly',
  'appalling', 'dismal', 'wretched', 'cringe', 'embarrassing', 'excruciating'
];

function scoreBySentiment(text) {
  if (!text || text.length < 20) return null;

  const lower = text.toLowerCase();

  let raveCount = 0, positiveCount = 0, mixedPosCount = 0, mixedCount = 0, negativeCount = 0, panCount = 0;

  RAVE_WORDS.forEach(w => { if (lower.includes(w)) raveCount++; });
  POSITIVE_WORDS.forEach(w => { if (lower.includes(w)) positiveCount++; });
  MIXED_POSITIVE_WORDS.forEach(w => { if (lower.includes(w)) mixedPosCount++; });
  MIXED_WORDS.forEach(w => { if (lower.includes(w)) mixedCount++; });
  NEGATIVE_WORDS.forEach(w => { if (lower.includes(w)) negativeCount++; });
  PAN_WORDS.forEach(w => { if (lower.includes(w)) panCount++; });

  // Weight the counts
  const totalPositive = raveCount * 3 + positiveCount * 2 + mixedPosCount;
  const totalNegative = panCount * 3 + negativeCount * 2 + mixedCount * 0.5;

  // Need at least some signal
  if (totalPositive === 0 && totalNegative === 0) {
    // Try to find any positive/negative indicators
    const hasPositiveIndicators = lower.includes('recommend') || lower.includes('worth') ||
      lower.includes('enjoy') || lower.includes('love') || lower.includes('best');
    const hasNegativeIndicators = lower.includes('not worth') || lower.includes('skip') ||
      lower.includes('don\'t') || lower.includes('avoid') || lower.includes('worst');

    if (hasPositiveIndicators && !hasNegativeIndicators) {
      return { score: 75, method: 'sentiment-indicator-positive', confidence: 'low' };
    }
    if (hasNegativeIndicators && !hasPositiveIndicators) {
      return { score: 45, method: 'sentiment-indicator-negative', confidence: 'low' };
    }
    return null;
  }

  const total = totalPositive + totalNegative + 0.1;
  const ratio = totalPositive / total;

  // Map ratio to score with more granularity
  if (ratio > 0.9) return { score: 92, method: 'sentiment-rave', confidence: 'medium' };
  if (ratio > 0.8) return { score: 85, method: 'sentiment-strong-positive', confidence: 'medium' };
  if (ratio > 0.7) return { score: 78, method: 'sentiment-positive', confidence: 'medium' };
  if (ratio > 0.6) return { score: 72, method: 'sentiment-mixed-positive', confidence: 'low' };
  if (ratio > 0.5) return { score: 68, method: 'sentiment-lean-positive', confidence: 'low' };
  if (ratio > 0.4) return { score: 62, method: 'sentiment-mixed', confidence: 'low' };
  if (ratio > 0.3) return { score: 55, method: 'sentiment-lean-negative', confidence: 'low' };
  if (ratio > 0.2) return { score: 48, method: 'sentiment-negative', confidence: 'medium' };
  if (ratio > 0.1) return { score: 40, method: 'sentiment-strong-negative', confidence: 'medium' };
  return { score: 32, method: 'sentiment-pan', confidence: 'medium' };
}

// Stats
const stats = {
  total: 0,
  alreadyScored: 0,
  newlyScored: 0,
  stillUnscored: 0
};

const newlyScored = [];
const stillUnscored = [];

// Process all shows
const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
  fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
);

console.log('=== SCORING REMAINING REVIEWS (Improved Analysis) ===\n');

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      stats.total++;

      // Skip if already has valid score
      if (data.scoreStatus !== 'TO_BE_CALCULATED') {
        stats.alreadyScored++;
        return;
      }

      // Try improved sentiment analysis
      const textToAnalyze = data.fullText || data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || '';

      // Skip if fullText is a 404 page
      if (data.fullText && (data.fullText.includes('Page Not Found') || data.fullText.includes('404'))) {
        // Use excerpt instead
        const excerptText = data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || '';
        const result = scoreBySentiment(excerptText);

        if (result) {
          data.assignedScore = result.score;
          data.scoreSource = result.method;
          data.scoreConfidence = result.confidence;
          delete data.scoreStatus;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          stats.newlyScored++;
          newlyScored.push({ showId, file, outlet: data.outlet, score: result.score, method: result.method });
          console.log(`✓ ${showId}/${file}: ${result.score} (${result.method})`);
          return;
        }
      }

      const result = scoreBySentiment(textToAnalyze);

      if (result) {
        data.assignedScore = result.score;
        data.scoreSource = result.method;
        data.scoreConfidence = result.confidence;
        delete data.scoreStatus;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        stats.newlyScored++;
        newlyScored.push({ showId, file, outlet: data.outlet, score: result.score, method: result.method });
        console.log(`✓ ${showId}/${file}: ${result.score} (${result.method})`);
      } else {
        stats.stillUnscored++;
        stillUnscored.push({ showId, file, outlet: data.outlet, textLength: textToAnalyze.length });
      }

    } catch(e) {
      console.error(`Error: ${file}: ${e.message}`);
    }
  });
});

console.log('\n=== SUMMARY ===');
console.log(`Total files: ${stats.total}`);
console.log(`Already scored: ${stats.alreadyScored}`);
console.log(`Newly scored: ${stats.newlyScored}`);
console.log(`Still unscored: ${stats.stillUnscored}`);

if (newlyScored.length > 0) {
  console.log('\n=== NEWLY SCORED ===');
  newlyScored.forEach(r => {
    console.log(`  ${r.showId}: ${r.outlet} → ${r.score}`);
  });
}

if (stillUnscored.length > 0) {
  console.log('\n=== STILL UNSCORED ===');
  // Group by whether they have text
  const withText = stillUnscored.filter(r => r.textLength > 20);
  const noText = stillUnscored.filter(r => r.textLength <= 20);

  console.log(`\nWith text (${withText.length}):`);
  withText.slice(0, 10).forEach(r => {
    console.log(`  ${r.showId}: ${r.outlet} (${r.textLength} chars)`);
  });
  if (withText.length > 10) console.log(`  ... and ${withText.length - 10} more`);

  console.log(`\nNo text (${noText.length}):`);
  noText.slice(0, 10).forEach(r => {
    console.log(`  ${r.showId}: ${r.outlet}`);
  });
  if (noText.length > 10) console.log(`  ... and ${noText.length - 10} more`);
}

// Save updated report
const reportPath = path.join(__dirname, '../data/audit/unscored-reviews-final.json');
fs.writeFileSync(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  stats: {
    totalFiles: stats.total,
    scored: stats.alreadyScored + stats.newlyScored,
    newlyScored: stats.newlyScored,
    stillUnscored: stats.stillUnscored
  },
  stillUnscoredReviews: stillUnscored
}, null, 2));

console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
