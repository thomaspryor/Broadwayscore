#!/usr/bin/env node
/**
 * Final pass at scoring remaining unscored reviews
 * Uses enhanced pattern matching including:
 * - Negation detection
 * - Phrase patterns (not just single words)
 * - Explicit negative expressions
 * - Contextual scoring
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Phrases that indicate strong negativity
const NEGATIVE_PHRASES = [
  'do not make up for', 'does not make up for',
  'not the show for you', 'this is not',
  'forget it', 'began to drag', 'started to drag',
  'wrong medium', 'wrong venue', 'wrong choice',
  'nothing surprising', 'nothing new', 'nothing special',
  'gives .* a bad name', 'very bad name',
  'legacy clean-up', 'legacy cleanup',
  'hagiography', 'vanity project',
  'not particularly memorable', 'not memorable',
  'bastardizes', 'bastardize',
  'corporate', 'officially sanctioned',
  'slickly', 'slick production',
  'excessiveness', 'excessive',
  'blunt direction', 'clunky direction',
  'passed its sell-by', 'past its sell-by',
  'overstays', 'drags on', 'too long',
  'tone shifted', 'tonal shift',
  'falls short', 'comes up short',
  'misses the mark', 'wide of the mark',
  'does little to', 'fails to',
  'interrogate', 'challenges.*forget',
  'if you expect.*forget', 'if you want.*not the show'
];

// Phrases that indicate positivity
const POSITIVE_PHRASES = [
  'uniformly topflight', 'topflight', 'top flight',
  'emotional electricity', 'sparking',
  'breathing room', 'breathes',
  'squarely where it counts',
  'must see', 'must-see', 'not to be missed',
  'worth the trip', 'worth seeing', 'worth every',
  'don\'t miss', 'do not miss',
  'standing ovation', 'brought the house down',
  'star is born', 'star-making', 'starmaking',
  'broadway debut', 'triumphant debut'
];

// Additional single-word negatives not in original list
const MORE_NEGATIVE_WORDS = [
  'faults', 'fault', 'flaws', 'flaw',
  'drag', 'drags', 'dragged', 'dragging',
  'excess', 'excessive', 'overly',
  'bloated', 'overwrought', 'overblown',
  'corporate', 'sanitized', 'whitewashed',
  'hagiography', 'hagiographic',
  'safe', 'playing it safe', 'plays it safe',
  'soulless', 'lifeless', 'bloodless',
  'inert', 'static', 'stilted',
  'cliche', 'cliched', 'clichéd', 'clichés',
  'generic', 'formulaic', 'by-the-numbers',
  'unremarkable', 'unmemorable', 'forgettable'
];

// Additional single-word positives
const MORE_POSITIVE_WORDS = [
  'topflight', 'electricity', 'electric',
  'sync', 'in sync', 'synced',
  'simplicity', 'elegant', 'elegance',
  'breathing', 'room', 'space'
];

function scoreByEnhancedSentiment(text) {
  if (!text || text.length < 30) return null;

  const lower = text.toLowerCase();

  // Check for negative phrases first (stronger signal)
  let negativePhraseCount = 0;
  let positivePhraseCount = 0;

  for (const phrase of NEGATIVE_PHRASES) {
    if (phrase.includes('.*')) {
      // Regex pattern
      const regex = new RegExp(phrase, 'i');
      if (regex.test(lower)) negativePhraseCount += 2;
    } else if (lower.includes(phrase)) {
      negativePhraseCount += 2;
    }
  }

  for (const phrase of POSITIVE_PHRASES) {
    if (lower.includes(phrase)) {
      positivePhraseCount += 2;
    }
  }

  // Check for additional single words
  let negativeWordCount = 0;
  let positiveWordCount = 0;

  for (const word of MORE_NEGATIVE_WORDS) {
    if (lower.includes(word)) negativeWordCount++;
  }

  for (const word of MORE_POSITIVE_WORDS) {
    if (lower.includes(word)) positiveWordCount++;
  }

  // Original word lists (reduced weight since first pass already tried these)
  const originalPositive = ['excellent', 'wonderful', 'brilliant', 'magnificent', 'stunning',
    'superb', 'phenomenal', 'dazzling', 'thrilling', 'breathtaking', 'masterpiece',
    'triumphant', 'riveting', 'mesmerizing', 'knockout', 'showstopper'];
  const originalNegative = ['disappointing', 'tedious', 'dull', 'boring', 'lackluster',
    'mediocre', 'weak', 'fails', 'misses', 'underwhelming', 'awful', 'terrible'];

  for (const word of originalPositive) {
    if (lower.includes(word)) positiveWordCount += 0.5;
  }
  for (const word of originalNegative) {
    if (lower.includes(word)) negativeWordCount += 0.5;
  }

  // Calculate totals
  const totalPositive = positivePhraseCount + positiveWordCount;
  const totalNegative = negativePhraseCount + negativeWordCount;

  // Need some signal to score
  if (totalPositive === 0 && totalNegative === 0) {
    return null;
  }

  const total = totalPositive + totalNegative + 0.1;
  const ratio = totalPositive / total;

  // Determine score and confidence
  let score, method, confidence;

  if (totalNegative >= 4) {
    // Strong negative signal
    score = ratio > 0.3 ? 48 : 38;
    method = 'enhanced-sentiment-negative';
    confidence = 'medium';
  } else if (totalPositive >= 4) {
    // Strong positive signal
    score = ratio > 0.8 ? 85 : 78;
    method = 'enhanced-sentiment-positive';
    confidence = 'medium';
  } else if (ratio < 0.3) {
    score = 45;
    method = 'enhanced-sentiment-lean-negative';
    confidence = 'low';
  } else if (ratio > 0.7) {
    score = 75;
    method = 'enhanced-sentiment-lean-positive';
    confidence = 'low';
  } else {
    score = 60;
    method = 'enhanced-sentiment-mixed';
    confidence = 'low';
  }

  return { score, method, confidence, debug: { totalPositive, totalNegative, ratio } };
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

console.log('=== FINAL SCORING PASS (Enhanced Phrase Analysis) ===\n');

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

      // Get text to analyze
      const textToAnalyze = data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt || data.fullText || '';

      if (textToAnalyze.length < 30) {
        stats.stillUnscored++;
        stillUnscored.push({ showId, file, outlet: data.outlet, textLength: textToAnalyze.length, reason: 'no-text' });
        return;
      }

      const result = scoreByEnhancedSentiment(textToAnalyze);

      if (result) {
        data.assignedScore = result.score;
        data.scoreSource = result.method;
        data.scoreConfidence = result.confidence;
        delete data.scoreStatus;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        stats.newlyScored++;
        newlyScored.push({
          showId,
          file,
          outlet: data.outlet,
          score: result.score,
          method: result.method,
          debug: result.debug
        });
        console.log(`✓ ${showId}/${file}: ${result.score} (${result.method})`);
        console.log(`  Debug: pos=${result.debug.totalPositive.toFixed(1)}, neg=${result.debug.totalNegative.toFixed(1)}, ratio=${result.debug.ratio.toFixed(2)}`);
      } else {
        stats.stillUnscored++;
        stillUnscored.push({ showId, file, outlet: data.outlet, textLength: textToAnalyze.length, reason: 'no-signal' });
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
  const withText = stillUnscored.filter(r => r.reason === 'no-signal');
  const noText = stillUnscored.filter(r => r.reason === 'no-text');

  if (withText.length > 0) {
    console.log(`\nWith text but no signal (${withText.length}):`);
    withText.forEach(r => {
      console.log(`  ${r.showId}: ${r.outlet} (${r.textLength} chars)`);
    });
  }

  if (noText.length > 0) {
    console.log(`\nNo text (${noText.length}):`);
    noText.forEach(r => {
      console.log(`  ${r.showId}: ${r.outlet}`);
    });
  }
}

// Save report
const reportPath = path.join(__dirname, '../data/audit/final-unscored.json');
fs.writeFileSync(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  stats,
  stillUnscoredReviews: stillUnscored
}, null, 2));

console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
