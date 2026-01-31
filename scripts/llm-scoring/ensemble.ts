/**
 * Ensemble Voting Module
 *
 * Implements 3-model voting logic with graceful degradation:
 * - 3 models: Use majority voting or average if unanimous
 * - 2 models: Average with disagreement detection
 * - 1 model: Single model fallback
 * - 0 models: Failure
 */

import { SimplifiedLLMResult, ModelScore, EnsembleResult, Bucket } from './types';
import { BUCKET_RANGES, clampScoreToBucket } from './config';

// ========================================
// CONSTANTS
// ========================================

const BUCKET_ORDER: Bucket[] = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];

/**
 * Maximum score delta to consider "agreement"
 */
const TIGHT_AGREEMENT_THRESHOLD = 5;
const MODERATE_AGREEMENT_THRESHOLD = 12;
const HIGH_DISAGREEMENT_THRESHOLD = 15;

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Convert a score to its bucket
 */
export function scoreToBucket(score: number): Bucket {
  for (const bucket of BUCKET_ORDER) {
    const range = BUCKET_RANGES[bucket];
    if (score >= range.min && score <= range.max) {
      return bucket;
    }
  }
  // Edge case: score exactly 0 or below
  return 'Pan';
}

/**
 * Get the distance between two buckets (0 = same, 1 = adjacent, etc.)
 */
export function bucketDistance(bucket1: Bucket, bucket2: Bucket): number {
  const idx1 = BUCKET_ORDER.indexOf(bucket1);
  const idx2 = BUCKET_ORDER.indexOf(bucket2);
  return Math.abs(idx1 - idx2);
}

/**
 * Find the median of an array of numbers
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find the mean of an array of numbers
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Get the majority bucket from model results
 */
function getMajorityBucket(results: ModelScore[]): { bucket: Bucket; count: number; models: string[] } | null {
  const bucketCounts: Record<Bucket, { count: number; models: string[] }> = {
    Rave: { count: 0, models: [] },
    Positive: { count: 0, models: [] },
    Mixed: { count: 0, models: [] },
    Negative: { count: 0, models: [] },
    Pan: { count: 0, models: [] }
  };

  for (const result of results) {
    bucketCounts[result.bucket].count++;
    bucketCounts[result.bucket].models.push(result.model);
  }

  // Find the bucket with the most votes
  let majority: { bucket: Bucket; count: number; models: string[] } | null = null;
  for (const bucket of BUCKET_ORDER) {
    if (bucketCounts[bucket].count > (majority?.count || 0)) {
      majority = { bucket, ...bucketCounts[bucket] };
    }
  }

  return majority;
}

/**
 * Find the outlier model when 2 agree and 1 disagrees
 */
function findOutlier(results: ModelScore[]): { model: string; bucket: Bucket; score: number } | null {
  if (results.length !== 3) return null;

  const majority = getMajorityBucket(results);
  if (!majority || majority.count !== 2) return null;

  const outlierResult = results.find(r => r.bucket !== majority.bucket);
  if (!outlierResult) return null;

  return {
    model: outlierResult.model,
    bucket: outlierResult.bucket,
    score: outlierResult.score
  };
}

// ========================================
// ENSEMBLE LOGIC
// ========================================

/**
 * Process 3-model ensemble results
 */
function threeModelEnsemble(results: ModelScore[]): EnsembleResult {
  const majority = getMajorityBucket(results);
  const scores = results.map(r => r.score);
  const avgScore = mean(scores);
  const medScore = median(scores);
  const spread = Math.max(...scores) - Math.min(...scores);

  // Check if all 3 models agree on bucket (unanimous)
  if (majority && majority.count === 3) {
    // All agree - use average score
    const finalScore = Math.round(avgScore);
    const clampedScore = clampScoreToBucket(finalScore, majority.bucket);

    return {
      score: clampedScore,
      bucket: majority.bucket,
      confidence: spread <= TIGHT_AGREEMENT_THRESHOLD ? 'high' : 'medium',
      source: 'ensemble-unanimous',
      agreement: `All 3 models agree: ${majority.bucket}`,
      modelResults: buildModelResultsMap(results),
      needsReview: false
    };
  }

  // Check if 2/3 models agree (majority)
  if (majority && majority.count === 2) {
    const outlier = findOutlier(results);
    const majorityResults = results.filter(r => r.bucket === majority.bucket);
    const majorityAvg = mean(majorityResults.map(r => r.score));
    const finalScore = Math.round(majorityAvg);
    const clampedScore = clampScoreToBucket(finalScore, majority.bucket);

    // Check if outlier is severe (>1 bucket away)
    const needsReview = outlier ? bucketDistance(majority.bucket, outlier.bucket) > 1 : false;

    return {
      score: clampedScore,
      bucket: majority.bucket,
      confidence: 'medium',
      source: 'ensemble-majority',
      agreement: `2/3 models agree: ${majority.bucket}`,
      outlier: outlier || undefined,
      modelResults: buildModelResultsMap(results),
      needsReview,
      reviewReason: needsReview ? `Outlier ${outlier?.model} chose ${outlier?.bucket}, 2+ buckets from majority` : undefined
    };
  }

  // No consensus (all 3 picked different buckets)
  // Fall back to average score and derive bucket from that
  const finalScore = Math.round(medScore); // Use median to reduce outlier influence
  const derivedBucket = scoreToBucket(finalScore);

  return {
    score: finalScore,
    bucket: derivedBucket,
    confidence: 'low',
    source: 'ensemble-no-consensus',
    agreement: 'No bucket consensus - using median score',
    note: `Buckets: ${results.map(r => `${r.model}=${r.bucket}`).join(', ')}`,
    modelResults: buildModelResultsMap(results),
    needsReview: true,
    reviewReason: '3-way bucket disagreement'
  };
}

/**
 * Process 2-model ensemble results (fallback when one model fails)
 */
function twoModelEnsemble(results: ModelScore[]): EnsembleResult {
  const scores = results.map(r => r.score);
  const avgScore = Math.round(mean(scores));
  const delta = Math.abs(scores[0] - scores[1]);

  // Check if buckets match
  if (results[0].bucket === results[1].bucket) {
    const bucket = results[0].bucket;
    const clampedScore = clampScoreToBucket(avgScore, bucket);

    return {
      score: clampedScore,
      bucket,
      confidence: delta <= TIGHT_AGREEMENT_THRESHOLD ? 'high' : 'medium',
      source: 'two-model-fallback',
      agreement: `Both models agree: ${bucket}`,
      modelResults: buildModelResultsMap(results),
      needsReview: delta > HIGH_DISAGREEMENT_THRESHOLD,
      reviewReason: delta > HIGH_DISAGREEMENT_THRESHOLD ? `Score delta ${delta} exceeds threshold` : undefined
    };
  }

  // Buckets differ - use average and derive bucket
  const derivedBucket = scoreToBucket(avgScore);
  const needsReview = bucketDistance(results[0].bucket, results[1].bucket) > 1;

  return {
    score: avgScore,
    bucket: derivedBucket,
    confidence: 'low',
    source: 'two-model-fallback',
    agreement: `Bucket disagreement: ${results[0].model}=${results[0].bucket}, ${results[1].model}=${results[1].bucket}`,
    modelResults: buildModelResultsMap(results),
    needsReview,
    reviewReason: needsReview ? 'Bucket disagreement > 1 bucket apart' : undefined
  };
}

/**
 * Process single-model result (fallback when two models fail)
 */
function singleModelFallback(result: ModelScore): EnsembleResult {
  const clampedScore = clampScoreToBucket(result.score, result.bucket);

  return {
    score: clampedScore,
    bucket: result.bucket,
    confidence: 'low',
    source: 'single-model-fallback',
    note: `Only ${result.model} succeeded`,
    modelResults: buildModelResultsMap([result]),
    needsReview: true,
    reviewReason: 'Single model fallback'
  };
}

/**
 * Build the modelResults map for storage
 */
function buildModelResultsMap(results: ModelScore[]): EnsembleResult['modelResults'] {
  const map: EnsembleResult['modelResults'] = {};

  for (const result of results) {
    map[result.model] = result;
  }

  return map;
}

// ========================================
// MAIN ENSEMBLE FUNCTION
// ========================================

/**
 * Combine model results into a final ensemble score
 *
 * Graceful degradation:
 * - 3 valid results: Use majority voting
 * - 2 valid results: Use average with disagreement detection
 * - 1 valid result: Use that model's score
 * - 0 valid results: Return failure
 */
export function ensembleScore(
  claudeResult: ModelScore | null,
  openaiResult: ModelScore | null,
  geminiResult: ModelScore | null
): EnsembleResult {
  // Collect valid results
  const validResults: ModelScore[] = [];

  if (claudeResult && !claudeResult.error) {
    validResults.push(claudeResult);
  }
  if (openaiResult && !openaiResult.error) {
    validResults.push(openaiResult);
  }
  if (geminiResult && !geminiResult.error) {
    validResults.push(geminiResult);
  }

  // Handle based on number of valid results
  switch (validResults.length) {
    case 3:
      return threeModelEnsemble(validResults);

    case 2:
      return twoModelEnsemble(validResults);

    case 1:
      return singleModelFallback(validResults[0]);

    case 0:
    default:
      // All models failed
      return {
        score: 50, // Neutral fallback
        bucket: 'Mixed',
        confidence: 'low',
        source: 'single-model-fallback',
        note: 'All models failed',
        modelResults: {},
        needsReview: true,
        reviewReason: 'All models failed to score'
      };
  }
}

/**
 * Convert a SimplifiedLLMResult to a ModelScore
 */
export function toModelScore(
  result: SimplifiedLLMResult | null,
  model: 'claude' | 'openai' | 'gemini',
  error?: string
): ModelScore {
  if (!result || error) {
    return {
      model,
      bucket: 'Mixed',
      score: 50,
      confidence: 'low',
      error: error || 'No result'
    };
  }

  return {
    model,
    bucket: result.bucket,
    score: result.score,
    confidence: result.confidence,
    verdict: result.verdict,
    keyQuote: result.keyQuote,
    reasoning: result.reasoning
  };
}

/**
 * Get the agreement level for logging
 */
export function getAgreementLevel(results: ModelScore[]): string {
  const validResults = results.filter(r => !r.error);

  if (validResults.length < 2) return 'insufficient';

  const buckets = validResults.map(r => r.bucket);
  const uniqueBuckets = new Set(buckets);

  if (uniqueBuckets.size === 1) return 'unanimous';
  if (validResults.length === 3 && uniqueBuckets.size === 2) return 'majority';
  return 'split';
}
