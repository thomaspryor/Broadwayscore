#!/usr/bin/env node

/**
 * Assign scores to reviews based on sentiment analysis of pullQuotes
 * Uses keyword matching to classify reviews as Positive/Mixed/Negative
 */

const fs = require('fs');

// Positive indicators (stronger = higher score)
const strongPositive = [
  'triumph', 'masterpiece', 'brilliant', 'extraordinary', 'phenomenal', 'stunning',
  'magnificent', 'spectacular', 'dazzling', 'electrifying', 'thrilling', 'breathtaking',
  'transcendent', 'exhilarating', 'glorious', 'sublime', 'ravishing', 'rapturous',
  'miraculous', 'astonishing', 'unforgettable', 'unmissable', 'must-see', 'best',
  'perfection', 'flawless', 'impeccable', 'sensational', 'landmark', 'revolutionary'
];

const positive = [
  'excellent', 'wonderful', 'fantastic', 'terrific', 'great', 'superb', 'delightful',
  'entertaining', 'enjoyable', 'compelling', 'captivating', 'engaging', 'powerful',
  'moving', 'touching', 'funny', 'hilarious', 'clever', 'smart', 'impressive',
  'remarkable', 'exceptional', 'outstanding', 'beautiful', 'lovely', 'charming',
  'fresh', 'inventive', 'creative', 'winning', 'appealing', 'satisfying', 'rewarding',
  'fun', 'joyful', 'joyous', 'exuberant', 'vibrant', 'alive', 'soars', 'shines'
];

const mildPositive = [
  'good', 'solid', 'decent', 'nice', 'pleasant', 'likable', 'likeable', 'fine',
  'worthwhile', 'commendable', 'respectable', 'competent', 'professional', 'polished',
  'well-crafted', 'well-made', 'effective', 'serviceable', 'adequate', 'passable'
];

// Negative indicators
const strongNegative = [
  'disaster', 'awful', 'terrible', 'dreadful', 'abysmal', 'atrocious', 'horrendous',
  'disastrous', 'catastrophic', 'unbearable', 'unwatchable', 'excruciating', 'painful',
  'worst', 'failure', 'fiasco', 'trainwreck', 'mess', 'waste'
];

const negative = [
  'bad', 'poor', 'weak', 'disappointing', 'mediocre', 'dull', 'boring', 'tedious',
  'tiresome', 'flat', 'lifeless', 'uninspired', 'lackluster', 'forgettable',
  'underwhelming', 'uneven', 'clunky', 'awkward', 'forced', 'contrived', 'stale',
  'predictable', 'clichéd', 'derivative', 'shallow', 'superficial', 'empty',
  'overlong', 'bloated', 'draggy', 'plodding', 'sluggish', 'confusing', 'muddled'
];

const mildNegative = [
  'flawed', 'imperfect', 'uneven', 'inconsistent', 'mixed', 'problematic',
  'not quite', 'falls short', 'misses', 'lacks', 'needed', 'could have'
];

// Qualifiers that might negate sentiment
const negators = ['not', "n't", 'never', 'no', 'without', 'lacks', 'fails to', 'hardly'];
const hedges = ['but', 'however', 'although', 'though', 'despite', 'yet', 'still'];

function analyzeQuote(quote) {
  if (!quote) return { score: 70, bucket: 'Mixed', confidence: 'low' };

  const text = quote.toLowerCase();
  const words = text.split(/\s+/);

  let positiveScore = 0;
  let negativeScore = 0;

  // Check for strong positive
  for (const word of strongPositive) {
    if (text.includes(word)) positiveScore += 3;
  }

  // Check for positive
  for (const word of positive) {
    if (text.includes(word)) positiveScore += 2;
  }

  // Check for mild positive
  for (const word of mildPositive) {
    if (text.includes(word)) positiveScore += 1;
  }

  // Check for strong negative
  for (const word of strongNegative) {
    if (text.includes(word)) negativeScore += 3;
  }

  // Check for negative
  for (const word of negative) {
    if (text.includes(word)) negativeScore += 2;
  }

  // Check for mild negative
  for (const word of mildNegative) {
    if (text.includes(word)) negativeScore += 1;
  }

  // Check for hedges (indicate mixed review)
  let hasHedge = false;
  for (const hedge of hedges) {
    if (text.includes(hedge)) hasHedge = true;
  }

  // Calculate net sentiment
  const netSentiment = positiveScore - negativeScore;
  const totalSignals = positiveScore + negativeScore;

  let score, bucket, thumb;

  if (totalSignals === 0) {
    // No clear signals - default to mildly positive (most reviews are)
    score = 72;
    bucket = 'Mixed';
    thumb = 'Up';
  } else if (netSentiment >= 4) {
    // Strong positive
    score = hasHedge ? 82 : 88;
    bucket = 'Positive';
    thumb = 'Up';
  } else if (netSentiment >= 2) {
    // Positive
    score = hasHedge ? 76 : 80;
    bucket = 'Positive';
    thumb = 'Up';
  } else if (netSentiment >= 0) {
    // Mild positive or mixed
    score = hasHedge ? 68 : 72;
    bucket = 'Mixed';
    thumb = 'Up';
  } else if (netSentiment >= -2) {
    // Mild negative
    score = hasHedge ? 58 : 55;
    bucket = 'Mixed';
    thumb = 'Down';
  } else {
    // Negative
    score = hasHedge ? 45 : 38;
    bucket = 'Negative';
    thumb = 'Down';
  }

  return {
    score,
    bucket,
    thumb,
    confidence: totalSignals >= 3 ? 'high' : totalSignals >= 1 ? 'medium' : 'low',
    signals: { positive: positiveScore, negative: negativeScore, net: netSentiment }
  };
}

// Main
const reviewsData = JSON.parse(fs.readFileSync('data/reviews.json', 'utf8'));
const reviews = reviewsData.reviews;

let updated = 0;
let alreadyHasScore = 0;

for (const review of reviews) {
  if (review.assignedScore !== null) {
    alreadyHasScore++;
    continue;
  }

  const analysis = analyzeQuote(review.pullQuote);
  review.assignedScore = analysis.score;
  review.bucket = analysis.bucket;
  review.thumb = analysis.thumb;
  review.originalRating = `Sentiment: ${analysis.bucket}`;

  updated++;
}

console.log('Reviews already had scores:', alreadyHasScore);
console.log('Reviews updated with scores:', updated);

// Save
fs.writeFileSync('data/reviews.json', JSON.stringify(reviewsData, null, 2));
console.log('\nSaved to data/reviews.json');

// Show sample of updated reviews
console.log('\nSample scored reviews:');
const samples = reviews.filter(r => r.source === 'bww-roundup').slice(0, 5);
for (const r of samples) {
  console.log(`\n${r.showId} - ${r.outlet} (${r.criticName || 'Unknown'})`);
  console.log(`  Score: ${r.assignedScore} | Bucket: ${r.bucket} | Thumb: ${r.thumb}`);
  console.log(`  Quote: ${(r.pullQuote || '').substring(0, 100)}...`);
}
