/**
 * Ground Truth Calibration Module
 *
 * Uses reviews with actual numeric ratings (stars, letter grades)
 * to calibrate and validate LLM scoring accuracy.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GroundTruthReview, ReviewEntry } from './types';

// ========================================
// RATING CONVERSION
// ========================================

/**
 * Convert a rating string (e.g., "4/5", "B+", "3.5 stars") to a 0-100 score
 */
export function convertRatingToScore(rating: string): number | null {
  if (!rating) return null;

  const normalized = rating.trim().toLowerCase();

  // Fraction format: 4/5, 3.5/4, etc.
  const fractionMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    const denom = parseFloat(fractionMatch[2]);
    if (denom > 0) {
      // Convert to 0-100 scale
      return Math.round((num / denom) * 100);
    }
  }

  // Star format: "5 stars", "3.5 stars", "★★★★"
  const starMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:stars?|★)/);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    // Assume 5-star scale
    return Math.round((stars / 5) * 100);
  }

  // Count stars: "★★★★" or "****"
  const starCountMatch = normalized.match(/^[★\*]+$/);
  if (starCountMatch) {
    const count = starCountMatch[0].length;
    // Assume 5-star scale
    return Math.round((count / 5) * 100);
  }

  // Letter grade format: A+, A, A-, B+, B, B-, etc.
  const gradeMap: Record<string, number> = {
    'a+': 98, 'a': 95, 'a-': 92,
    'b+': 88, 'b': 85, 'b-': 82,
    'c+': 78, 'c': 75, 'c-': 72,
    'd+': 68, 'd': 65, 'd-': 62,
    'f': 50
  };

  if (gradeMap[normalized]) {
    return gradeMap[normalized];
  }

  // Numeric score (0-10 or 0-100)
  const numMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:out of\s*(\d+))?$/);
  if (numMatch) {
    const score = parseFloat(numMatch[1]);
    const outOf = numMatch[2] ? parseFloat(numMatch[2]) : (score <= 10 ? 10 : 100);
    return Math.round((score / outOf) * 100);
  }

  return null;
}

// ========================================
// GROUND TRUTH EXTRACTION
// ========================================

/**
 * Find all reviews with actual numeric ratings
 */
export function findGroundTruthReviews(
  reviewsJsonPath: string,
  reviewTextsDir: string
): GroundTruthReview[] {
  const groundTruth: GroundTruthReview[] = [];

  // Load reviews.json
  const reviewsData = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf-8'));

  // Filter to reviews with convertible ratings
  for (const review of Object.values(reviewsData) as ReviewEntry[]) {
    if (!review.originalRating) continue;

    const groundTruthScore = convertRatingToScore(review.originalRating);
    if (groundTruthScore === null) continue;

    // Try to find the matching review text file
    const showDir = path.join(reviewTextsDir, review.showId);
    if (!fs.existsSync(showDir)) continue;

    // Look for matching file
    const files = fs.readdirSync(showDir);
    const matchingFile = files.find(f => {
      const parts = f.replace('.json', '').split('--');
      return parts[0] === review.outletId.toLowerCase().replace(/\s+/g, '-');
    });

    if (!matchingFile) continue;

    const textFilePath = path.join(showDir, matchingFile);
    try {
      const textData = JSON.parse(fs.readFileSync(textFilePath, 'utf-8'));
      if (!textData.fullText || textData.fullText.length < 100) continue;

      // Check if already has LLM score
      const llmScore = textData.llmScore?.score ?? undefined;
      const ensembleScore = textData.ensembleData?.claudeScore !== undefined && textData.ensembleData?.openaiScore !== undefined
        ? Math.round((textData.ensembleData.claudeScore + textData.ensembleData.openaiScore) / 2)
        : undefined;

      groundTruth.push({
        showId: review.showId,
        outletId: review.outletId,
        outlet: review.outlet,
        criticName: review.criticName || 'Unknown',
        originalRating: review.originalRating,
        groundTruthScore,
        fullText: textData.fullText,
        llmScore,
        ensembleScore
      });
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return groundTruth;
}

// ========================================
// CALIBRATION METRICS
// ========================================

export interface GroundTruthCalibrationResult {
  totalReviews: number;
  scoredReviews: number;
  mae: number;
  rmse: number;
  meanBias: number;
  bucketAccuracy: number;
  byRatingType: {
    fraction: { count: number; mae: number };
    letterGrade: { count: number; mae: number };
    stars: { count: number; mae: number };
  };
  largestErrors: Array<{
    showId: string;
    outlet: string;
    originalRating: string;
    groundTruthScore: number;
    llmScore: number;
    delta: number;
  }>;
  recommendations: string[];
}

function getRatingType(rating: string): 'fraction' | 'letterGrade' | 'stars' | 'other' {
  if (/^\d+(?:\.\d+)?\/\d+$/.test(rating.trim())) return 'fraction';
  if (/^[A-Fa-f][+-]?$/.test(rating.trim())) return 'letterGrade';
  if (/stars?|★/i.test(rating)) return 'stars';
  return 'other';
}

function scoreToBucket(score: number): string {
  if (score >= 90) return 'Rave';
  if (score >= 75) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 40) return 'Negative';
  return 'Pan';
}

/**
 * Calculate calibration metrics against ground truth
 */
export function calculateGroundTruthCalibration(
  groundTruth: GroundTruthReview[],
  useEnsemble: boolean = true
): GroundTruthCalibrationResult {
  // Filter to reviews with LLM scores
  const scored = groundTruth.filter(r =>
    useEnsemble ? r.ensembleScore !== undefined : r.llmScore !== undefined
  );

  if (scored.length === 0) {
    return {
      totalReviews: groundTruth.length,
      scoredReviews: 0,
      mae: 0,
      rmse: 0,
      meanBias: 0,
      bucketAccuracy: 0,
      byRatingType: {
        fraction: { count: 0, mae: 0 },
        letterGrade: { count: 0, mae: 0 },
        stars: { count: 0, mae: 0 }
      },
      largestErrors: [],
      recommendations: ['No scored reviews found for calibration']
    };
  }

  // Calculate errors
  const errors = scored.map(r => {
    const llmScore = useEnsemble ? r.ensembleScore! : r.llmScore!;
    const delta = llmScore - r.groundTruthScore;
    return {
      ...r,
      llmScore,
      delta,
      absError: Math.abs(delta),
      ratingType: getRatingType(r.originalRating),
      bucketMatch: scoreToBucket(llmScore) === scoreToBucket(r.groundTruthScore)
    };
  });

  // Overall metrics
  const totalAbsError = errors.reduce((sum, e) => sum + e.absError, 0);
  const mae = totalAbsError / errors.length;

  const totalSquaredError = errors.reduce((sum, e) => sum + e.delta * e.delta, 0);
  const rmse = Math.sqrt(totalSquaredError / errors.length);

  const totalBias = errors.reduce((sum, e) => sum + e.delta, 0);
  const meanBias = totalBias / errors.length;

  const bucketMatches = errors.filter(e => e.bucketMatch).length;
  const bucketAccuracy = Math.round((bucketMatches / errors.length) * 100);

  // By rating type
  const byRatingType = {
    fraction: { count: 0, mae: 0 },
    letterGrade: { count: 0, mae: 0 },
    stars: { count: 0, mae: 0 }
  };

  for (const type of ['fraction', 'letterGrade', 'stars'] as const) {
    const typeErrors = errors.filter(e => e.ratingType === type);
    if (typeErrors.length > 0) {
      byRatingType[type].count = typeErrors.length;
      byRatingType[type].mae = typeErrors.reduce((sum, e) => sum + e.absError, 0) / typeErrors.length;
    }
  }

  // Largest errors
  const largestErrors = [...errors]
    .sort((a, b) => b.absError - a.absError)
    .slice(0, 5)
    .map(e => ({
      showId: e.showId,
      outlet: e.outlet,
      originalRating: e.originalRating,
      groundTruthScore: e.groundTruthScore,
      llmScore: e.llmScore,
      delta: e.delta
    }));

  // Recommendations
  const recommendations: string[] = [];

  if (meanBias > 5) {
    recommendations.push(`LLM scores ${Math.abs(meanBias).toFixed(1)} points too high on average. Add examples of lower scores to the prompt.`);
  } else if (meanBias < -5) {
    recommendations.push(`LLM scores ${Math.abs(meanBias).toFixed(1)} points too low on average. Add examples of higher scores to the prompt.`);
  }

  if (bucketAccuracy < 60) {
    recommendations.push(`Bucket accuracy is only ${bucketAccuracy}%. Review score anchor definitions.`);
  }

  for (const [type, stats] of Object.entries(byRatingType)) {
    if (stats.count >= 3 && stats.mae > mae + 5) {
      recommendations.push(`${type} ratings have higher error (${stats.mae.toFixed(1)} vs ${mae.toFixed(1)}). Add more ${type} examples to calibration.`);
    }
  }

  return {
    totalReviews: groundTruth.length,
    scoredReviews: scored.length,
    mae: Math.round(mae * 10) / 10,
    rmse: Math.round(rmse * 10) / 10,
    meanBias: Math.round(meanBias * 10) / 10,
    bucketAccuracy,
    byRatingType,
    largestErrors,
    recommendations
  };
}

// ========================================
// CLI
// ========================================

export function printGroundTruthReport(result: GroundTruthCalibrationResult): void {
  console.log('\n========================================');
  console.log('GROUND TRUTH CALIBRATION REPORT');
  console.log('========================================\n');

  console.log(`Total reviews with ratings: ${result.totalReviews}`);
  console.log(`Reviews with LLM scores:    ${result.scoredReviews}`);
  console.log('');

  console.log('OVERALL METRICS:');
  console.log(`  MAE:             ${result.mae} points`);
  console.log(`  RMSE:            ${result.rmse} points`);
  console.log(`  Mean Bias:       ${result.meanBias > 0 ? '+' : ''}${result.meanBias} points`);
  console.log(`  Bucket Accuracy: ${result.bucketAccuracy}%`);
  console.log('');

  console.log('BY RATING TYPE:');
  for (const [type, stats] of Object.entries(result.byRatingType)) {
    if (stats.count > 0) {
      console.log(`  ${type}: ${stats.count} reviews, MAE ${stats.mae.toFixed(1)}`);
    }
  }
  console.log('');

  if (result.largestErrors.length > 0) {
    console.log('LARGEST ERRORS:');
    for (const err of result.largestErrors) {
      const sign = err.delta > 0 ? '+' : '';
      console.log(`  ${err.outlet} (${err.showId}): ${err.originalRating} → ${err.groundTruthScore}, LLM: ${err.llmScore} (${sign}${err.delta})`);
    }
    console.log('');
  }

  if (result.recommendations.length > 0) {
    console.log('RECOMMENDATIONS:');
    for (const rec of result.recommendations) {
      console.log(`  • ${rec}`);
    }
    console.log('');
  }
}

// ========================================
// MAIN
// ========================================

if (require.main === module) {
  const projectRoot = path.join(__dirname, '../..');
  const reviewsJsonPath = path.join(projectRoot, 'data/reviews.json');
  const reviewTextsDir = path.join(projectRoot, 'data/review-texts');

  console.log('Finding ground truth reviews...');
  const groundTruth = findGroundTruthReviews(reviewsJsonPath, reviewTextsDir);
  console.log(`Found ${groundTruth.length} reviews with numeric ratings`);

  const result = calculateGroundTruthCalibration(groundTruth, false);
  printGroundTruthReport(result);

  // Save results
  const outputPath = path.join(projectRoot, 'data/ground-truth-calibration.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}
