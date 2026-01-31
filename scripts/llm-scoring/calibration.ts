/**
 * Calibration Module
 *
 * Compares LLM-generated scores against human-assigned scores to:
 * - Track accuracy metrics (MAE, RMSE, bucket accuracy)
 * - Identify per-outlet biases
 * - Detect systematic over/under scoring
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CalibrationDataPoint,
  CalibrationStats,
  ReviewEntry,
  ScoredReviewFile
} from './types';
import { getOutletTier, scoreToBucket } from './config';

// ========================================
// DATA LOADING
// ========================================

/**
 * Load human-assigned reviews from reviews.json
 */
function loadHumanReviews(): ReviewEntry[] {
  const reviewsPath = path.join(__dirname, '../../data/reviews.json');
  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
  return data.reviews || [];
}

/**
 * Load LLM-scored review files from review-texts directory
 */
function loadLLMScoredReviews(): ScoredReviewFile[] {
  const reviewTextsDir = path.join(__dirname, '../../data/review-texts');
  const scored: ScoredReviewFile[] = [];

  if (!fs.existsSync(reviewTextsDir)) {
    return scored;
  }

  const shows = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const show of shows) {
    const showDir = path.join(reviewTextsDir, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8'));
        // Only include reviews that have LLM scores
        if (content.llmScore && typeof content.llmScore.score === 'number') {
          scored.push(content as ScoredReviewFile);
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  return scored;
}

// ========================================
// MATCHING LOGIC
// ========================================

/**
 * Normalize strings for matching
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Match LLM-scored reviews to human-assigned reviews
 */
function matchReviews(
  humanReviews: ReviewEntry[],
  llmReviews: ScoredReviewFile[]
): CalibrationDataPoint[] {
  const dataPoints: CalibrationDataPoint[] = [];

  for (const llmReview of llmReviews) {
    // Find matching human review
    const humanReview = humanReviews.find(hr => {
      // Match by show and outlet
      const showMatch = normalize(hr.showId) === normalize(llmReview.showId);
      const outletMatch =
        normalize(hr.outlet) === normalize(llmReview.outlet) ||
        normalize(hr.outletId || '') === normalize(llmReview.outletId || '');

      if (!showMatch || !outletMatch) return false;

      // Optionally match by critic name if available
      if (hr.criticName && llmReview.criticName) {
        return normalize(hr.criticName) === normalize(llmReview.criticName);
      }

      return true;
    });

    if (humanReview) {
      const delta = llmReview.llmScore.score - humanReview.assignedScore;
      const llmBucket = llmReview.llmScore.bucket;
      const humanBucket = humanReview.bucket || scoreToBucket(humanReview.assignedScore);

      dataPoints.push({
        showId: llmReview.showId,
        outletId: llmReview.outletId || humanReview.outletId || '',
        outlet: llmReview.outlet,
        criticName: llmReview.criticName || humanReview.criticName || '',
        humanScore: humanReview.assignedScore,
        llmScore: llmReview.llmScore.score,
        delta,
        absoluteError: Math.abs(delta),
        llmConfidence: llmReview.llmScore.confidence,
        humanBucket,
        llmBucket,
        bucketMatch: normalize(llmBucket) === normalize(humanBucket)
      });
    }
  }

  return dataPoints;
}

// ========================================
// STATISTICS CALCULATION
// ========================================

/**
 * Calculate calibration statistics from data points
 */
function calculateStats(dataPoints: CalibrationDataPoint[]): CalibrationStats {
  if (dataPoints.length === 0) {
    return {
      count: 0,
      mae: 0,
      rmse: 0,
      meanBias: 0,
      stdDev: 0,
      bucketAccuracy: 0,
      byConfidence: {
        high: { count: 0, mae: 0 },
        medium: { count: 0, mae: 0 },
        low: { count: 0, mae: 0 }
      },
      outletBias: {}
    };
  }

  // Basic metrics
  const count = dataPoints.length;
  const mae = dataPoints.reduce((sum, dp) => sum + dp.absoluteError, 0) / count;
  const mse = dataPoints.reduce((sum, dp) => sum + dp.delta * dp.delta, 0) / count;
  const rmse = Math.sqrt(mse);
  const meanBias = dataPoints.reduce((sum, dp) => sum + dp.delta, 0) / count;

  // Standard deviation
  const variance = dataPoints.reduce((sum, dp) => {
    return sum + Math.pow(dp.delta - meanBias, 2);
  }, 0) / count;
  const stdDev = Math.sqrt(variance);

  // Bucket accuracy
  const bucketMatches = dataPoints.filter(dp => dp.bucketMatch).length;
  const bucketAccuracy = (bucketMatches / count) * 100;

  // By confidence level
  const byConfidence = {
    high: { count: 0, mae: 0 },
    medium: { count: 0, mae: 0 },
    low: { count: 0, mae: 0 }
  };

  for (const dp of dataPoints) {
    const conf = dp.llmConfidence || 'medium';
    byConfidence[conf].count++;
    byConfidence[conf].mae += dp.absoluteError;
  }

  for (const level of ['high', 'medium', 'low'] as const) {
    if (byConfidence[level].count > 0) {
      byConfidence[level].mae /= byConfidence[level].count;
    }
  }

  // By outlet (bias tracking)
  const outletBias: Record<string, { count: number; totalDelta: number }> = {};

  for (const dp of dataPoints) {
    const outlet = dp.outlet || dp.outletId;
    if (!outletBias[outlet]) {
      outletBias[outlet] = { count: 0, totalDelta: 0 };
    }
    outletBias[outlet].count++;
    outletBias[outlet].totalDelta += dp.delta;
  }

  const outletBiasFinal: Record<string, { count: number; meanBias: number }> = {};
  for (const [outlet, data] of Object.entries(outletBias)) {
    if (data.count >= 2) { // Only include outlets with 2+ reviews
      outletBiasFinal[outlet] = {
        count: data.count,
        meanBias: data.totalDelta / data.count
      };
    }
  }

  // By tier
  const byTier = {
    tier1: { count: 0, totalError: 0, totalDelta: 0 },
    tier2: { count: 0, totalError: 0, totalDelta: 0 },
    tier3: { count: 0, totalError: 0, totalDelta: 0 }
  };

  for (const dp of dataPoints) {
    const tier = getOutletTier(dp.outletId || dp.outlet);
    const tierKey = `tier${tier}` as 'tier1' | 'tier2' | 'tier3';
    byTier[tierKey].count++;
    byTier[tierKey].totalError += dp.absoluteError;
    byTier[tierKey].totalDelta += dp.delta;
  }

  return {
    count,
    mae: Math.round(mae * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    meanBias: Math.round(meanBias * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    bucketAccuracy: Math.round(bucketAccuracy * 10) / 10,
    byConfidence: {
      high: {
        count: byConfidence.high.count,
        mae: Math.round(byConfidence.high.mae * 100) / 100
      },
      medium: {
        count: byConfidence.medium.count,
        mae: Math.round(byConfidence.medium.mae * 100) / 100
      },
      low: {
        count: byConfidence.low.count,
        mae: Math.round(byConfidence.low.mae * 100) / 100
      }
    },
    byTier: {
      tier1: {
        count: byTier.tier1.count,
        mae: byTier.tier1.count > 0
          ? Math.round((byTier.tier1.totalError / byTier.tier1.count) * 100) / 100
          : 0,
        meanBias: byTier.tier1.count > 0
          ? Math.round((byTier.tier1.totalDelta / byTier.tier1.count) * 100) / 100
          : 0
      },
      tier2: {
        count: byTier.tier2.count,
        mae: byTier.tier2.count > 0
          ? Math.round((byTier.tier2.totalError / byTier.tier2.count) * 100) / 100
          : 0,
        meanBias: byTier.tier2.count > 0
          ? Math.round((byTier.tier2.totalDelta / byTier.tier2.count) * 100) / 100
          : 0
      },
      tier3: {
        count: byTier.tier3.count,
        mae: byTier.tier3.count > 0
          ? Math.round((byTier.tier3.totalError / byTier.tier3.count) * 100) / 100
          : 0,
        meanBias: byTier.tier3.count > 0
          ? Math.round((byTier.tier3.totalDelta / byTier.tier3.count) * 100) / 100
          : 0
      }
    },
    outletBias: outletBiasFinal
  };
}

// ========================================
// MAIN FUNCTIONS
// ========================================

/**
 * Run calibration analysis
 */
export function runCalibration(verbose: boolean = false): CalibrationStats {
  if (verbose) {
    console.log('\n=== Calibration Analysis ===\n');
  }

  const humanReviews = loadHumanReviews();
  const llmReviews = loadLLMScoredReviews();

  if (verbose) {
    console.log(`Human reviews loaded: ${humanReviews.length}`);
    console.log(`LLM-scored reviews loaded: ${llmReviews.length}`);
  }

  const dataPoints = matchReviews(humanReviews, llmReviews);

  if (verbose) {
    console.log(`Matched reviews: ${dataPoints.length}`);
  }

  const stats = calculateStats(dataPoints);

  if (verbose) {
    printCalibrationReport(stats, dataPoints);
  }

  return stats;
}

/**
 * Print a formatted calibration report
 */
export function printCalibrationReport(
  stats: CalibrationStats,
  dataPoints: CalibrationDataPoint[]
): void {
  console.log('\n--- Calibration Report ---\n');
  console.log(`Total matched reviews: ${stats.count}`);
  console.log(`Mean Absolute Error (MAE): ${stats.mae} points`);
  console.log(`Root Mean Square Error (RMSE): ${stats.rmse} points`);
  console.log(`Mean Bias: ${stats.meanBias > 0 ? '+' : ''}${stats.meanBias} (${stats.meanBias > 0 ? 'LLM scores higher' : 'LLM scores lower'})`);
  console.log(`Standard Deviation: ${stats.stdDev} points`);
  console.log(`Bucket Accuracy: ${stats.bucketAccuracy}%`);

  console.log('\n--- By Confidence Level ---\n');
  console.log(`High confidence: ${stats.byConfidence.high.count} reviews, MAE: ${stats.byConfidence.high.mae}`);
  console.log(`Medium confidence: ${stats.byConfidence.medium.count} reviews, MAE: ${stats.byConfidence.medium.mae}`);
  console.log(`Low confidence: ${stats.byConfidence.low.count} reviews, MAE: ${stats.byConfidence.low.mae}`);

  if (stats.byTier) {
    console.log('\n--- By Outlet Tier ---\n');
    console.log(`Tier 1: ${stats.byTier.tier1.count} reviews, MAE: ${stats.byTier.tier1.mae}, Bias: ${stats.byTier.tier1.meanBias > 0 ? '+' : ''}${stats.byTier.tier1.meanBias}`);
    console.log(`Tier 2: ${stats.byTier.tier2.count} reviews, MAE: ${stats.byTier.tier2.mae}, Bias: ${stats.byTier.tier2.meanBias > 0 ? '+' : ''}${stats.byTier.tier2.meanBias}`);
    console.log(`Tier 3: ${stats.byTier.tier3.count} reviews, MAE: ${stats.byTier.tier3.mae}, Bias: ${stats.byTier.tier3.meanBias > 0 ? '+' : ''}${stats.byTier.tier3.meanBias}`);
  }

  // Show outlets with significant bias
  const biasedOutlets = Object.entries(stats.outletBias)
    .filter(([_, data]) => Math.abs(data.meanBias) >= 5)
    .sort((a, b) => Math.abs(b[1].meanBias) - Math.abs(a[1].meanBias));

  if (biasedOutlets.length > 0) {
    console.log('\n--- Outlets with Significant Bias (|bias| >= 5) ---\n');
    for (const [outlet, data] of biasedOutlets) {
      const direction = data.meanBias > 0 ? 'over' : 'under';
      console.log(`  ${outlet}: ${direction}scores by ${Math.abs(data.meanBias).toFixed(1)} points (n=${data.count})`);
    }
  }

  // Show largest errors
  if (dataPoints.length > 0) {
    const largestErrors = dataPoints
      .slice()
      .sort((a, b) => b.absoluteError - a.absoluteError)
      .slice(0, 5);

    console.log('\n--- Largest Errors ---\n');
    for (const dp of largestErrors) {
      console.log(`  ${dp.showId} / ${dp.outlet}: Human ${dp.humanScore} vs LLM ${dp.llmScore} (Δ${dp.delta > 0 ? '+' : ''}${dp.delta})`);
    }
  }
}

/**
 * Get individual calibration data points for further analysis
 */
export function getCalibrationData(): CalibrationDataPoint[] {
  const humanReviews = loadHumanReviews();
  const llmReviews = loadLLMScoredReviews();
  return matchReviews(humanReviews, llmReviews);
}

// ========================================
// ENSEMBLE CALIBRATION (3-model)
// ========================================

interface EnsembleModelStats {
  model: string;
  count: number;
  mae: number;
  meanBias: number;
  bucketAccuracy: number;
}

interface EnsembleCalibrationResult {
  totalReviews: number;
  reviewsWithEnsembleData: number;
  modelStats: EnsembleModelStats[];
  ensembleStats: {
    mae: number;
    meanBias: number;
    bucketAccuracy: number;
  };
  agreementStats: {
    unanimous: number;
    majority: number;
    noConsensus: number;
    twoModel: number;
    singleModel: number;
  };
  recommendedGeminiOffset: number;
}

/**
 * Run ensemble-specific calibration to analyze individual model performance
 */
export function runEnsembleCalibration(verbose: boolean = false): EnsembleCalibrationResult | null {
  if (verbose) {
    console.log('\n=== Ensemble Calibration Analysis ===\n');
  }

  const humanReviews = loadHumanReviews();
  const llmReviews = loadLLMScoredReviews();

  // Filter to reviews with ensemble data
  const ensembleReviews = llmReviews.filter(r => r.ensembleData && r.ensembleData.claudeScore !== null);

  if (ensembleReviews.length === 0) {
    if (verbose) {
      console.log('No ensemble-scored reviews found.');
    }
    return null;
  }

  // Match with human reviews
  const matched: Array<{
    humanScore: number;
    humanBucket: string;
    claudeScore: number | null;
    openaiScore: number | null;
    geminiScore: number | null;
    ensembleScore: number;
    ensembleBucket: string;
    ensembleSource: string;
  }> = [];

  for (const llmReview of ensembleReviews) {
    const humanReview = humanReviews.find(hr => {
      const showMatch = normalize(hr.showId) === normalize(llmReview.showId);
      const outletMatch =
        normalize(hr.outlet) === normalize(llmReview.outlet) ||
        normalize(hr.outletId || '') === normalize(llmReview.outletId || '');
      return showMatch && outletMatch;
    });

    if (humanReview && llmReview.ensembleData) {
      matched.push({
        humanScore: humanReview.assignedScore,
        humanBucket: humanReview.bucket || scoreToBucket(humanReview.assignedScore),
        claudeScore: llmReview.ensembleData.claudeScore,
        openaiScore: llmReview.ensembleData.openaiScore,
        geminiScore: llmReview.ensembleData.geminiScore ?? null,
        ensembleScore: llmReview.llmScore.score,
        ensembleBucket: llmReview.llmScore.bucket,
        ensembleSource: llmReview.ensembleData.ensembleSource || 'unknown'
      });
    }
  }

  if (verbose) {
    console.log(`Total ensemble reviews: ${ensembleReviews.length}`);
    console.log(`Matched with human scores: ${matched.length}`);
  }

  if (matched.length === 0) {
    return null;
  }

  // Calculate per-model stats
  const modelStats: EnsembleModelStats[] = [];

  for (const model of ['claude', 'openai', 'gemini'] as const) {
    const scoreField = `${model}Score` as 'claudeScore' | 'openaiScore' | 'geminiScore';
    const reviewsWithModel = matched.filter(m => m[scoreField] !== null);

    if (reviewsWithModel.length === 0) continue;

    const errors = reviewsWithModel.map(m => m[scoreField]! - m.humanScore);
    const absErrors = errors.map(e => Math.abs(e));

    const mae = absErrors.reduce((a, b) => a + b, 0) / reviewsWithModel.length;
    const meanBias = errors.reduce((a, b) => a + b, 0) / reviewsWithModel.length;

    // Calculate bucket accuracy for this model
    const bucketMatches = reviewsWithModel.filter(m => {
      const modelBucket = scoreToBucket(m[scoreField]!);
      return normalize(modelBucket) === normalize(m.humanBucket);
    }).length;

    modelStats.push({
      model,
      count: reviewsWithModel.length,
      mae: Math.round(mae * 100) / 100,
      meanBias: Math.round(meanBias * 100) / 100,
      bucketAccuracy: Math.round((bucketMatches / reviewsWithModel.length) * 1000) / 10
    });
  }

  // Calculate ensemble stats
  const ensembleErrors = matched.map(m => m.ensembleScore - m.humanScore);
  const ensembleAbsErrors = ensembleErrors.map(e => Math.abs(e));
  const ensembleBucketMatches = matched.filter(m =>
    normalize(m.ensembleBucket) === normalize(m.humanBucket)
  ).length;

  const ensembleStats = {
    mae: Math.round((ensembleAbsErrors.reduce((a, b) => a + b, 0) / matched.length) * 100) / 100,
    meanBias: Math.round((ensembleErrors.reduce((a, b) => a + b, 0) / matched.length) * 100) / 100,
    bucketAccuracy: Math.round((ensembleBucketMatches / matched.length) * 1000) / 10
  };

  // Count agreement types
  const agreementStats = {
    unanimous: matched.filter(m => m.ensembleSource === 'ensemble-unanimous').length,
    majority: matched.filter(m => m.ensembleSource === 'ensemble-majority').length,
    noConsensus: matched.filter(m => m.ensembleSource === 'ensemble-no-consensus').length,
    twoModel: matched.filter(m => m.ensembleSource === 'two-model-fallback').length,
    singleModel: matched.filter(m => m.ensembleSource === 'single-model-fallback').length
  };

  // Calculate recommended Gemini offset
  const geminiStats = modelStats.find(s => s.model === 'gemini');
  const claudeStats = modelStats.find(s => s.model === 'claude');
  const recommendedGeminiOffset = geminiStats && claudeStats
    ? Math.round((claudeStats.meanBias - geminiStats.meanBias) * 100) / 100
    : 0;

  if (verbose) {
    console.log('\n--- Per-Model Performance ---\n');
    for (const stats of modelStats) {
      console.log(`${stats.model}: n=${stats.count}, MAE=${stats.mae}, Bias=${stats.meanBias > 0 ? '+' : ''}${stats.meanBias}, Bucket=${stats.bucketAccuracy}%`);
    }

    console.log('\n--- Ensemble Performance ---\n');
    console.log(`MAE: ${ensembleStats.mae}, Bias: ${ensembleStats.meanBias > 0 ? '+' : ''}${ensembleStats.meanBias}, Bucket: ${ensembleStats.bucketAccuracy}%`);

    console.log('\n--- Agreement Distribution ---\n');
    console.log(`Unanimous: ${agreementStats.unanimous} (${Math.round(agreementStats.unanimous / matched.length * 100)}%)`);
    console.log(`Majority: ${agreementStats.majority} (${Math.round(agreementStats.majority / matched.length * 100)}%)`);
    console.log(`No consensus: ${agreementStats.noConsensus} (${Math.round(agreementStats.noConsensus / matched.length * 100)}%)`);
    console.log(`Two-model fallback: ${agreementStats.twoModel} (${Math.round(agreementStats.twoModel / matched.length * 100)}%)`);
    console.log(`Single-model fallback: ${agreementStats.singleModel} (${Math.round(agreementStats.singleModel / matched.length * 100)}%)`);

    if (recommendedGeminiOffset !== 0) {
      console.log(`\n--- Recommended Adjustments ---\n`);
      console.log(`Gemini offset: ${recommendedGeminiOffset > 0 ? '+' : ''}${recommendedGeminiOffset} (to align with Claude)`);
    }
  }

  return {
    totalReviews: ensembleReviews.length,
    reviewsWithEnsembleData: matched.length,
    modelStats,
    ensembleStats,
    agreementStats,
    recommendedGeminiOffset
  };
}
