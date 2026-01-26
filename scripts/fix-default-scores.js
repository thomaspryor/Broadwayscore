#!/usr/bin/env node
/**
 * URGENT FIX: Score the 214 reviews currently defaulting to 50
 *
 * Strategy:
 * 1. Extract letter grades from end of fullText (common in EW, etc.)
 * 2. Use sentiment keywords to estimate scores for excerpts
 * 3. Mark remaining for manual review
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

// Sentiment keyword scoring (for excerpts without explicit grades)
const POSITIVE_STRONG = ['masterpiece', 'brilliant', 'extraordinary', 'magnificent', 'stunning', 'superb', 'phenomenal', 'triumphant', 'dazzling', 'must-see', 'must see', 'unmissable'];
const POSITIVE = ['excellent', 'wonderful', 'delightful', 'captivating', 'enchanting', 'entertaining', 'enjoyable', 'impressive', 'remarkable', 'terrific', 'fantastic', 'great', 'lovely'];
const MIXED_POSITIVE = ['solid', 'good', 'pleasant', 'satisfying', 'decent', 'fine', 'nice', 'charming'];
const MIXED = ['uneven', 'mixed', 'inconsistent', 'flawed but', 'despite', 'however', 'problematic'];
const NEGATIVE = ['disappointing', 'tedious', 'dull', 'boring', 'lackluster', 'forgettable', 'mediocre', 'weak', 'fails', 'misses'];
const NEGATIVE_STRONG = ['awful', 'terrible', 'disaster', 'waste', 'avoid', 'painful', 'unbearable', 'worst'];

function extractLetterGrade(text) {
  if (!text) return null;

  // Check last 10 characters for letter grade
  const ending = text.trim().slice(-10);

  // Match patterns like "B", "B+", "A-", etc. at end
  const gradeMatch = ending.match(/\s([A-D][+-]?|F)\s*$/i);
  if (gradeMatch) {
    const grade = gradeMatch[1].toUpperCase();
    return { grade, score: LETTER_TO_SCORE[grade] };
  }

  // Also check for "Grade: B" or "Rating: B+" patterns
  const explicitMatch = text.match(/(?:grade|rating|score)[:\s]+([A-D][+-]?|F)\b/i);
  if (explicitMatch) {
    const grade = explicitMatch[1].toUpperCase();
    return { grade, score: LETTER_TO_SCORE[grade] };
  }

  return null;
}

function scoreBySentiment(text) {
  if (!text || text.length < 50) return null;

  const lower = text.toLowerCase();

  // Count sentiment indicators
  let positiveStrong = 0, positive = 0, mixedPositive = 0, mixed = 0, negative = 0, negativeStrong = 0;

  POSITIVE_STRONG.forEach(w => { if (lower.includes(w)) positiveStrong++; });
  POSITIVE.forEach(w => { if (lower.includes(w)) positive++; });
  MIXED_POSITIVE.forEach(w => { if (lower.includes(w)) mixedPositive++; });
  MIXED.forEach(w => { if (lower.includes(w)) mixed++; });
  NEGATIVE.forEach(w => { if (lower.includes(w)) negative++; });
  NEGATIVE_STRONG.forEach(w => { if (lower.includes(w)) negativeStrong++; });

  // Calculate weighted sentiment
  const totalPositive = positiveStrong * 2 + positive * 1.5 + mixedPositive;
  const totalNegative = negativeStrong * 2 + negative * 1.5 + mixed * 0.5;

  if (totalPositive === 0 && totalNegative === 0) return null;

  const ratio = totalPositive / (totalPositive + totalNegative + 0.1);

  // Map ratio to score
  if (ratio > 0.85) return { score: 88, method: 'sentiment-strong-positive', confidence: 'medium' };
  if (ratio > 0.7) return { score: 80, method: 'sentiment-positive', confidence: 'medium' };
  if (ratio > 0.55) return { score: 72, method: 'sentiment-mixed-positive', confidence: 'low' };
  if (ratio > 0.45) return { score: 65, method: 'sentiment-mixed', confidence: 'low' };
  if (ratio > 0.3) return { score: 55, method: 'sentiment-mixed-negative', confidence: 'low' };
  if (ratio > 0.15) return { score: 45, method: 'sentiment-negative', confidence: 'medium' };
  return { score: 35, method: 'sentiment-strong-negative', confidence: 'medium' };
}

// Track stats
const stats = {
  total: 0,
  fixedByGrade: 0,
  fixedBySentiment: 0,
  stillDefault: 0
};

const stillNeedsFix = [];

// Process all shows
const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
  fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
);

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Check if this would fall back to default score
      const hasLlmScore = data.llmScore?.score && data.llmScore?.confidence !== 'low' && !data.ensembleData?.needsReview;
      const hasAssignedScore = data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100;
      const hasOriginalScore = data.originalScore;
      const hasBucket = data.bucket;
      const hasThumb = data.dtliThumb || data.bwwThumb || data.thumb;

      if (!hasLlmScore && !hasAssignedScore && !hasOriginalScore && !hasBucket && !hasThumb) {
        stats.total++;

        // Try to extract letter grade from text
        const gradeResult = extractLetterGrade(data.fullText);
        if (gradeResult) {
          data.originalScore = gradeResult.grade;
          data.assignedScore = gradeResult.score;
          data.scoreSource = 'extracted-grade';
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          stats.fixedByGrade++;
          console.log(`✓ ${showId}/${file}: Grade ${gradeResult.grade} → ${gradeResult.score}`);
          return;
        }

        // Try sentiment analysis on available text
        const textToAnalyze = data.fullText || data.dtliExcerpt || data.bwwExcerpt || data.showScoreExcerpt || '';
        const sentimentResult = scoreBySentiment(textToAnalyze);

        if (sentimentResult && sentimentResult.confidence !== 'low') {
          data.assignedScore = sentimentResult.score;
          data.scoreSource = sentimentResult.method;
          data.scoreConfidence = sentimentResult.confidence;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          stats.fixedBySentiment++;
          console.log(`✓ ${showId}/${file}: Sentiment → ${sentimentResult.score} (${sentimentResult.method})`);
          return;
        }

        // Even low confidence is better than 50
        if (sentimentResult) {
          data.assignedScore = sentimentResult.score;
          data.scoreSource = sentimentResult.method;
          data.scoreConfidence = 'low';
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          stats.fixedBySentiment++;
          console.log(`~ ${showId}/${file}: Sentiment (low conf) → ${sentimentResult.score}`);
          return;
        }

        // Still can't score
        stats.stillDefault++;
        stillNeedsFix.push({ showId, file, outlet: data.outlet, hasText: !!(data.fullText || data.dtliExcerpt) });
      }
    } catch(e) {
      console.error(`Error processing ${file}: ${e.message}`);
    }
  });
});

console.log('\n=== SUMMARY ===');
console.log(`Total reviews needing fix: ${stats.total}`);
console.log(`Fixed by grade extraction: ${stats.fixedByGrade}`);
console.log(`Fixed by sentiment analysis: ${stats.fixedBySentiment}`);
console.log(`Still need manual review: ${stats.stillDefault}`);

if (stillNeedsFix.length > 0) {
  console.log('\n=== STILL NEEDS MANUAL FIX ===');
  stillNeedsFix.forEach(r => {
    console.log(`  ${r.showId}/${r.file} (${r.outlet}) - has text: ${r.hasText}`);
  });
}

console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
console.log('To sync these fixes to reviews.json');
