#!/usr/bin/env node
/**
 * Audit Explicit Scores
 *
 * Validates that explicit critic scores (originalScore) actually match the review text.
 * Flags suspicious scores that may be scraping errors.
 *
 * Checks for:
 * 1. Score doesn't match text sentiment (e.g., "1/5" but text is positive)
 * 2. Score was extracted from link text (unreliable)
 * 3. Score extracted from JSON-LD may be wrong critic
 *
 * Usage:
 *   node scripts/audit-explicit-scores.js [--sample=50] [--verbose]
 */

const fs = require('fs');
const path = require('path');

const REVIEW_DIR = 'data/review-texts';
const OUTPUT_FILE = 'data/audit/suspicious-explicit-scores.json';

const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '0');
const VERBOSE = process.argv.includes('--verbose');

// Positive sentiment signals
const POSITIVE_SIGNALS = [
  'masterpiece', 'brilliant', 'must-see', 'extraordinary', 'outstanding',
  'excellent', 'remarkable', 'triumph', 'wonderful', 'superb', 'magnificent',
  'stunning', 'captivating', 'riveting', 'unmissable', 'glorious', 'dazzling',
  'phenomenal', 'spectacular', 'tremendous', 'flawless', 'perfect'
];

// Negative sentiment signals
const NEGATIVE_SIGNALS = [
  'disappointing', 'fails', 'terrible', 'avoid', 'waste', 'disaster',
  'misfire', 'tedious', 'dull', 'boring', 'weak', 'poor', 'mediocre',
  'forgettable', 'uninspired', 'flat', 'lifeless', 'dreary', 'lackluster',
  'muddled', 'mess', 'slog', 'tiresome', 'unwatchable'
];

/**
 * Convert originalScore to numeric (0-100)
 */
function convertToNumeric(originalScore) {
  if (!originalScore) return null;
  const s = String(originalScore).toLowerCase().trim();

  // Skip sentiment-only
  if (['positive', 'negative', 'mixed', 'rave', 'pan'].includes(s)) return null;
  if (s.includes('sentiment:')) return null;

  // Letter grades
  const letterGrades = {
    'a+': 98, 'a': 95, 'a-': 92,
    'b+': 88, 'b': 85, 'b-': 82,
    'c+': 78, 'c': 75, 'c-': 72,
    'd+': 68, 'd': 65, 'd-': 62,
    'f': 50
  };
  if (letterGrades[s]) return letterGrades[s];

  // Star ratings (X/5 format)
  const starMatch = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)(?:\s*stars?)?/i);
  if (starMatch) {
    return (parseFloat(starMatch[1]) / parseFloat(starMatch[2])) * 100;
  }

  // "X stars" format
  const starsMatch = s.match(/(\d+(?:\.\d+)?)\s*stars?/i);
  if (starsMatch) {
    return (parseFloat(starsMatch[1]) / 5) * 100;
  }

  return null;
}

/**
 * Analyze text sentiment using keyword matching
 */
function analyzeSentiment(text) {
  if (!text || text.length < 50) return null;

  const textLower = text.toLowerCase();

  let positiveCount = 0;
  let negativeCount = 0;
  const positiveMatches = [];
  const negativeMatches = [];

  for (const signal of POSITIVE_SIGNALS) {
    if (textLower.includes(signal)) {
      positiveCount++;
      positiveMatches.push(signal);
    }
  }

  for (const signal of NEGATIVE_SIGNALS) {
    if (textLower.includes(signal)) {
      negativeCount++;
      negativeMatches.push(signal);
    }
  }

  const sentiment = positiveCount > negativeCount ? 'positive' :
                    negativeCount > positiveCount ? 'negative' : 'neutral';

  return {
    sentiment,
    positiveCount,
    negativeCount,
    positiveMatches,
    negativeMatches
  };
}

/**
 * Check if score seems suspicious given text sentiment
 */
function checkScoreSentimentMatch(numericScore, sentiment) {
  if (!sentiment || sentiment.sentiment === 'neutral') return null;

  // High score (>=70) with negative text
  if (numericScore >= 70 && sentiment.sentiment === 'negative' &&
      sentiment.negativeCount >= 2) {
    return {
      suspicious: true,
      reason: `High score (${numericScore}) but text has ${sentiment.negativeCount} negative signals: ${sentiment.negativeMatches.slice(0, 3).join(', ')}`
    };
  }

  // Very high score (>=85) with any negative signals
  if (numericScore >= 85 && sentiment.negativeCount >= 2 &&
      sentiment.positiveCount < sentiment.negativeCount) {
    return {
      suspicious: true,
      reason: `Very high score (${numericScore}) but negative sentiment dominates`
    };
  }

  // Low score (<=40) with positive text
  if (numericScore <= 40 && sentiment.sentiment === 'positive' &&
      sentiment.positiveCount >= 2) {
    return {
      suspicious: true,
      reason: `Low score (${numericScore}) but text has ${sentiment.positiveCount} positive signals: ${sentiment.positiveMatches.slice(0, 3).join(', ')}`
    };
  }

  // Very low score (<=25) with any positive signals
  if (numericScore <= 25 && sentiment.positiveCount >= 2 &&
      sentiment.negativeCount < sentiment.positiveCount) {
    return {
      suspicious: true,
      reason: `Very low score (${numericScore}) but positive sentiment dominates`
    };
  }

  return { suspicious: false };
}

/**
 * Check if score source is unreliable
 */
function checkScoreSource(data) {
  const issues = [];

  // Link text extraction (like "[Read Roma Torre's ★★★★★ review]")
  // BUT: If fullText starts with stars, the score is probably correct even if there are links
  const startsWithStars = data.fullText && /^★/.test(data.fullText.trim());
  if (data.fullText && data.fullText.includes('[Read ') &&
      data.fullText.includes('★') && !startsWithStars) {
    issues.push('Score may have been extracted from link to another review');
  }

  // JSON-LD without validation
  if (data.scoreSource === 'json-ld' && !data.originalScoreValidated) {
    issues.push('Score from JSON-LD metadata - may not match this critic');
  }

  // Very short text
  const textLength = (data.fullText || data.showScoreExcerpt ||
                     data.dtliExcerpt || data.bwwExcerpt || '').length;
  if (textLength < 100) {
    issues.push('Very short text - hard to validate score');
  }

  return issues;
}

async function main() {
  console.log('Auditing explicit scores...\n');

  const suspicious = [];
  const stats = {
    totalReviews: 0,
    withExplicitScore: 0,
    numericScores: 0,
    flaggedSentimentMismatch: 0,
    flaggedSourceIssues: 0,
    flaggedTotal: 0
  };

  // Find all reviews
  const shows = fs.readdirSync(REVIEW_DIR).filter(f =>
    fs.statSync(path.join(REVIEW_DIR, f)).isDirectory()
  );

  const allReviews = [];

  for (const show of shows) {
    const showDir = path.join(REVIEW_DIR, show);
    const files = fs.readdirSync(showDir).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    for (const file of files) {
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        stats.totalReviews++;

        if (data.originalScore) {
          stats.withExplicitScore++;
          const numeric = convertToNumeric(data.originalScore);

          if (numeric !== null) {
            stats.numericScores++;
            allReviews.push({
              filePath,
              showId: show,
              file,
              data,
              numericScore: numeric
            });
          }
        }
      } catch (e) {
        // Skip invalid files
      }
    }
  }

  // Sample if requested
  let reviewsToCheck = allReviews;
  if (SAMPLE_SIZE > 0 && SAMPLE_SIZE < allReviews.length) {
    // Random sample
    reviewsToCheck = allReviews
      .sort(() => Math.random() - 0.5)
      .slice(0, SAMPLE_SIZE);
    console.log(`Checking random sample of ${SAMPLE_SIZE} reviews\n`);
  }

  // Check each review
  for (const review of reviewsToCheck) {
    const { data, numericScore, showId, file } = review;

    // Get best available text
    const text = data.fullText || data.showScoreExcerpt ||
                 data.dtliExcerpt || data.bwwExcerpt || '';

    const issues = [];

    // Check sentiment match
    const sentiment = analyzeSentiment(text);
    const sentimentCheck = checkScoreSentimentMatch(numericScore, sentiment);
    if (sentimentCheck?.suspicious) {
      issues.push(sentimentCheck.reason);
      stats.flaggedSentimentMismatch++;
    }

    // Check source reliability
    const sourceIssues = checkScoreSource(data);
    if (sourceIssues.length > 0) {
      issues.push(...sourceIssues);
      stats.flaggedSourceIssues++;
    }

    if (issues.length > 0) {
      stats.flaggedTotal++;

      const result = {
        reviewId: `${showId}/${file}`,
        originalScore: data.originalScore,
        numericScore,
        criticName: data.criticName,
        outlet: data.outlet || data.outletId,
        scoreSource: data.scoreSource,
        issues,
        textSample: text.slice(0, 300) + (text.length > 300 ? '...' : ''),
        sentiment: sentiment ? {
          overall: sentiment.sentiment,
          positiveSignals: sentiment.positiveMatches,
          negativeSignals: sentiment.negativeMatches
        } : null
      };

      suspicious.push(result);

      if (VERBOSE) {
        console.log(`\n⚠️  ${showId}/${file}`);
        console.log(`   Score: ${data.originalScore} (${numericScore})`);
        issues.forEach(i => console.log(`   Issue: ${i}`));
      }
    }
  }

  // Sort by severity (most issues first)
  suspicious.sort((a, b) => b.issues.length - a.issues.length);

  // Save results
  const output = {
    generatedAt: new Date().toISOString(),
    stats,
    flaggedReviews: suspicious
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('EXPLICIT SCORE AUDIT RESULTS');
  console.log('='.repeat(60));
  console.log(`\nTotal reviews: ${stats.totalReviews}`);
  console.log(`With explicit score: ${stats.withExplicitScore}`);
  console.log(`With numeric score: ${stats.numericScores}`);
  console.log(`\nFlagged for review: ${stats.flaggedTotal}`);
  console.log(`  - Sentiment mismatch: ${stats.flaggedSentimentMismatch}`);
  console.log(`  - Source reliability: ${stats.flaggedSourceIssues}`);

  const errorRate = (stats.flaggedTotal / stats.numericScores * 100).toFixed(1);
  console.log(`\nEstimated error rate: ${errorRate}%`);

  if (parseFloat(errorRate) > 10) {
    console.log('\n⚠️  ERROR RATE EXCEEDS 10% - EXPLICIT SCORES MAY BE UNRELIABLE');
    console.log('   Consider manual review before using for calibration');
  }

  console.log(`\n✓ Full results saved to ${OUTPUT_FILE}`);
}

main().catch(console.error);
