#!/usr/bin/env node
/**
 * Score ALL reviews that don't have a valid score
 * This includes:
 * - Reviews with assignedScore = null
 * - Reviews with assignedScore = 50 (previous default)
 * - Reviews marked TO_BE_CALCULATED
 * - Reviews with no scoreSource
 *
 * Uses: grade extraction, sentiment analysis, thumb data
 * If we STILL can't score it, marks as TO_BE_CALCULATED and it gets excluded
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Letter grade mapping
const LETTER_TO_SCORE = {
  'A+': 97, 'A': 93, 'A-': 90,
  'B+': 87, 'B': 83, 'B-': 80,
  'C+': 77, 'C': 73, 'C-': 70,
  'D+': 55, 'D': 50, 'D-': 45,
  'F': 30
};

const THUMB_TO_SCORE = { 'Up': 80, 'Meh': 60, 'Flat': 60, 'Down': 35 };

// Sentiment keyword scoring
const POSITIVE_STRONG = ['masterpiece', 'brilliant', 'extraordinary', 'magnificent', 'stunning', 'superb', 'phenomenal', 'triumphant', 'dazzling', 'must-see', 'must see', 'unmissable', 'transcendent', 'unforgettable', 'thrilling', 'sensational'];
const POSITIVE = ['excellent', 'wonderful', 'delightful', 'captivating', 'enchanting', 'entertaining', 'enjoyable', 'impressive', 'remarkable', 'terrific', 'fantastic', 'great', 'lovely', 'gorgeous', 'beautiful', 'touching', 'moving', 'powerful', 'clever', 'witty', 'smart', 'inventive'];
const MIXED_POSITIVE = ['solid', 'good', 'pleasant', 'satisfying', 'decent', 'fine', 'nice', 'charming', 'capable', 'competent', 'adequate', 'respectable'];
const MIXED = ['uneven', 'mixed', 'inconsistent', 'flawed but', 'despite', 'however', 'problematic', 'hit and miss', 'hit-and-miss'];
const NEGATIVE = ['disappointing', 'tedious', 'dull', 'boring', 'lackluster', 'forgettable', 'mediocre', 'weak', 'fails', 'misses', 'falls flat', 'underwhelming', 'predictable', 'tired', 'stale'];
const NEGATIVE_STRONG = ['awful', 'terrible', 'disaster', 'waste', 'avoid', 'painful', 'unbearable', 'worst', 'atrocious', 'dreadful'];

function extractLetterGrade(text) {
  if (!text) return null;

  // Check last 10 characters for letter grade
  const ending = text.trim().slice(-10);
  const gradeMatch = ending.match(/\s([A-D][+-]?|F)\s*$/i);
  if (gradeMatch) {
    const grade = gradeMatch[1].toUpperCase();
    return { grade, score: LETTER_TO_SCORE[grade] };
  }

  // Check for "Grade: B" or "Rating: B+" patterns
  // "grade" requires colon (idiom: "Grade B" = mediocre); "score" excluded (theater: musical score)
  const explicitMatch = text.match(/(?:grade:\s*|rating[:\s]+)([A-D][+-]?|F)(?!\w)/i);
  if (explicitMatch) {
    const grade = explicitMatch[1].toUpperCase();
    return { grade, score: LETTER_TO_SCORE[grade] };
  }

  return null;
}

function scoreBySentiment(text) {
  if (!text || text.length < 30) return null;

  const lower = text.toLowerCase();

  let positiveStrong = 0, positive = 0, mixedPositive = 0, mixed = 0, negative = 0, negativeStrong = 0;

  POSITIVE_STRONG.forEach(w => { if (lower.includes(w)) positiveStrong++; });
  POSITIVE.forEach(w => { if (lower.includes(w)) positive++; });
  MIXED_POSITIVE.forEach(w => { if (lower.includes(w)) mixedPositive++; });
  MIXED.forEach(w => { if (lower.includes(w)) mixed++; });
  NEGATIVE.forEach(w => { if (lower.includes(w)) negative++; });
  NEGATIVE_STRONG.forEach(w => { if (lower.includes(w)) negativeStrong++; });

  const totalPositive = positiveStrong * 2 + positive * 1.5 + mixedPositive;
  const totalNegative = negativeStrong * 2 + negative * 1.5 + mixed * 0.5;

  if (totalPositive === 0 && totalNegative === 0) return null;

  const ratio = totalPositive / (totalPositive + totalNegative + 0.1);

  if (ratio > 0.85) return { score: 88, method: 'sentiment-strong-positive', confidence: 'medium' };
  if (ratio > 0.7) return { score: 80, method: 'sentiment-positive', confidence: 'medium' };
  if (ratio > 0.55) return { score: 72, method: 'sentiment-mixed-positive', confidence: 'low' };
  if (ratio > 0.45) return { score: 65, method: 'sentiment-mixed', confidence: 'low' };
  if (ratio > 0.3) return { score: 55, method: 'sentiment-mixed-negative', confidence: 'low' };
  if (ratio > 0.15) return { score: 45, method: 'sentiment-negative', confidence: 'medium' };
  return { score: 35, method: 'sentiment-strong-negative', confidence: 'medium' };
}

function hasValidScore(data) {
  // Check if already has a valid score from known sources
  const hasLlmScore = data.llmScore?.score && data.llmScore?.confidence !== 'low' && !data.ensembleData?.needsReview;
  const hasThumb = data.dtliThumb || data.bwwThumb;
  const hasOriginalScore = data.originalScore;
  const hasBucket = data.bucket && ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'].includes(data.bucket);

  // Check if assignedScore with valid source
  const validSources = ['llmScore', 'originalScore', 'bucket', 'thumb', 'extracted-grade',
                        'sentiment-strong-positive', 'sentiment-positive', 'sentiment-mixed-positive',
                        'sentiment-mixed', 'sentiment-mixed-negative', 'sentiment-negative',
                        'sentiment-strong-negative', 'manual', 'dtli', 'bww'];
  const hasValidAssignedScore = data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100 &&
    ((data.scoreSource && validSources.some(s => data.scoreSource.includes(s))) || hasThumb || hasOriginalScore || hasBucket);

  return hasLlmScore || hasValidAssignedScore || hasThumb || hasOriginalScore || hasBucket;
}

// Stats
const stats = {
  total: 0,
  alreadyScored: 0,
  fixedByGrade: 0,
  fixedBySentiment: 0,
  fixedByThumb: 0,
  fixedByDesignation: 0,
  stillUnscored: 0
};

const stillUnscored = [];

// Process all shows
const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
  fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
);

console.log('=== SCORING ALL UNSCORED REVIEWS ===\n');

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      stats.total++;

      // Check if already has valid score
      if (hasValidScore(data)) {
        stats.alreadyScored++;
        return;
      }

      // Try to score this review
      let scored = false;

      // 1. Try grade extraction from text
      const textToCheck = data.fullText || data.dtliExcerpt || data.bwwExcerpt || '';
      const gradeResult = extractLetterGrade(textToCheck);
      if (gradeResult) {
        data.originalScore = gradeResult.grade;
        data.assignedScore = gradeResult.score;
        data.scoreSource = 'extracted-grade';
        delete data.scoreStatus;
        scored = true;
        stats.fixedByGrade++;
        console.log(`✓ ${showId}/${file}: Grade ${gradeResult.grade} → ${gradeResult.score}`);
      }

      // 2. Try thumb data (dtli/bww) - these are reliable signals
      if (!scored && (data.dtliThumb || data.bwwThumb)) {
        const thumb = data.dtliThumb || data.bwwThumb;
        data.assignedScore = THUMB_TO_SCORE[thumb] || 60;
        data.scoreSource = `thumb-${data.dtliThumb ? 'dtli' : 'bww'}`;
        delete data.scoreStatus;
        scored = true;
        stats.fixedByThumb++;
        console.log(`✓ ${showId}/${file}: Thumb ${thumb} → ${data.assignedScore}`);
      }

      // 3. Try designation (Critics_Pick is strongly positive)
      if (!scored && data.designation === 'Critics_Pick') {
        data.assignedScore = 88;
        data.scoreSource = 'designation-critics-pick';
        delete data.scoreStatus;
        scored = true;
        stats.fixedByDesignation++;
        console.log(`✓ ${showId}/${file}: Critics_Pick → 88`);
      }

      // 4. Try sentiment analysis on available text
      if (!scored) {
        const textForSentiment = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '';
        const sentimentResult = scoreBySentiment(textForSentiment);

        if (sentimentResult) {
          data.assignedScore = sentimentResult.score;
          data.scoreSource = sentimentResult.method;
          data.scoreConfidence = sentimentResult.confidence;
          delete data.scoreStatus;
          scored = true;
          stats.fixedBySentiment++;
          const confNote = sentimentResult.confidence === 'low' ? ' (low conf)' : '';
          console.log(`✓ ${showId}/${file}: Sentiment → ${sentimentResult.score}${confNote}`);
        }
      }

      // 5. Still can't score - mark as TO_BE_CALCULATED
      if (!scored) {
        data.assignedScore = null;
        data.scoreStatus = 'TO_BE_CALCULATED';
        data.scoreSource = null;
        stats.stillUnscored++;
        stillUnscored.push({
          showId,
          file,
          outlet: data.outlet,
          critic: data.criticName,
          hasAnyText: !!(data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt)
        });
        console.log(`⚠ ${showId}/${file}: No data to score (${data.outlet})`);
      }

      // Save the updated file
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    } catch(e) {
      console.error(`Error processing ${file}: ${e.message}`);
    }
  });
});

console.log('\n=== SUMMARY ===');
console.log(`Total files: ${stats.total}`);
console.log(`Already had valid score: ${stats.alreadyScored}`);
console.log(`Fixed by grade extraction: ${stats.fixedByGrade}`);
console.log(`Fixed by thumb data: ${stats.fixedByThumb}`);
console.log(`Fixed by designation: ${stats.fixedByDesignation}`);
console.log(`Fixed by sentiment: ${stats.fixedBySentiment}`);
console.log(`Still unscored (excluded): ${stats.stillUnscored}`);

if (stillUnscored.length > 0) {
  console.log('\n=== STILL UNSCORED (will be excluded) ===');

  // Group by show
  const byShow = {};
  stillUnscored.forEach(r => {
    byShow[r.showId] = byShow[r.showId] || [];
    byShow[r.showId].push(r);
  });

  Object.entries(byShow)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([show, reviews]) => {
      console.log(`\n  ${show}: ${reviews.length}`);
      reviews.slice(0, 3).forEach(r => {
        console.log(`    - ${r.outlet} (has text: ${r.hasAnyText})`);
      });
      if (reviews.length > 3) console.log(`    ... and ${reviews.length - 3} more`);
    });
}

// Save report
const reportPath = path.join(__dirname, '../data/audit/unscored-reviews-final.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  stats,
  unscoredReviews: stillUnscored
}, null, 2));

console.log(`\nReport saved to: ${reportPath}`);
console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
