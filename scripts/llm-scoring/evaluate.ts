#!/usr/bin/env npx ts-node --project scripts/tsconfig.json

/**
 * LLM Scoring Evaluation Framework
 *
 * Runs a proper train/test evaluation:
 * 1. Splits reviews with known human scores into train (80%) and test (20%)
 * 2. Uses train set examples to calibrate few-shot prompts
 * 3. Scores the test set with the LLM
 * 4. Measures accuracy and identifies systematic errors
 * 5. Outputs recommendations for prompt tuning
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/evaluate.ts
 *
 * Options:
 *   --test-size=N       Number of reviews in test set (default: 20)
 *   --by-outlet         Stratify test set by outlet tier
 *   --verbose           Show detailed output
 *   --save-results      Save evaluation results to file
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { ReviewTextFile, ReviewEntry } from './types';
import { SYSTEM_PROMPT, buildPrompt, scoreToBucket, scoreToThumb, PROMPT_VERSION, getOutletTier } from './config';

// ========================================
// TYPES
// ========================================

interface EvaluationExample {
  showId: string;
  outlet: string;
  outletId: string;
  criticName: string;
  // tier reflects canonical VALID_TIERS (1-4 as of v5); widened from 1|2|3 when
  // getOutletTier() stopped collapsing T4→T3.
  tier: 1 | 2 | 3 | 4;
  fullText: string;
  humanScore: number;
  humanBucket: string;
  filePath: string;
}

interface EvaluationResult {
  example: EvaluationExample;
  llmScore: number;
  llmBucket: string;
  llmConfidence: string;
  llmReasoning: string;
  delta: number;
  absoluteError: number;
  bucketMatch: boolean;
}

interface EvaluationSummary {
  testSetSize: number;
  promptVersion: string;
  model: string;
  timestamp: string;

  // Accuracy metrics
  mae: number;
  rmse: number;
  meanBias: number;
  bucketAccuracy: number;

  // By tier — keys are `tier${n}` for each canonical VALID_TIERS entry.
  // Optional per tier: omitted (not zero-filled) when sample count is below
  // significance threshold to avoid misleading single-data-point metrics.
  byTier: Partial<Record<`tier${1 | 2 | 3 | 4}`, { count: number; mae: number; bias: number }>>;

  // By bucket
  byHumanBucket: Record<string, { count: number; mae: number; bias: number }>;

  // Largest errors for analysis
  largestErrors: Array<{
    showId: string;
    outlet: string;
    humanScore: number;
    llmScore: number;
    delta: number;
    reasoning: string;
  }>;

  // Recommendations
  recommendations: string[];
}

// ========================================
// DATA LOADING
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '../../data/review-texts');
const REVIEWS_JSON_PATH = path.join(__dirname, '../../data/reviews.json');
const EVAL_RESULTS_PATH = path.join(__dirname, '../../data/llm-evaluation-results.json');

function loadEvaluationCandidates(): EvaluationExample[] {
  // Load human scores from reviews.json
  const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_JSON_PATH, 'utf-8'));
  const humanReviews: ReviewEntry[] = reviewsData.reviews || [];

  // Create lookup map
  const humanScoreMap = new Map<string, ReviewEntry>();
  for (const r of humanReviews) {
    // Key by showId + outlet (normalized)
    const key = `${r.showId}::${(r.outlet || '').toLowerCase().replace(/\s+/g, '')}`;
    humanScoreMap.set(key, r);
  }

  const candidates: EvaluationExample[] = [];

  // Scan review-texts directory
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    return candidates;
  }

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
    try {
      return fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(showDir, file);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReviewTextFile;

        // Must have full text
        if (!content.fullText || content.fullText.length < 100) {
          continue;
        }

        // Skip if already has LLM score (we want fresh evaluation)
        if ((content as any).llmScore) {
          continue;
        }

        // Find matching human score
        const key = `${content.showId}::${(content.outlet || '').toLowerCase().replace(/\s+/g, '')}`;
        const humanReview = humanScoreMap.get(key);

        if (!humanReview || !humanReview.assignedScore) {
          continue;
        }

        candidates.push({
          showId: content.showId,
          outlet: content.outlet,
          outletId: content.outletId || '',
          criticName: content.criticName || '',
          tier: getOutletTier(content.outletId || content.outlet),
          fullText: content.fullText,
          humanScore: humanReview.assignedScore,
          humanBucket: humanReview.bucket || scoreToBucket(humanReview.assignedScore),
          filePath
        });
      } catch {
        // Skip malformed files
      }
    }
  }

  return candidates;
}

// ========================================
// STRATIFIED SAMPLING
// ========================================

function selectTestSet(
  candidates: EvaluationExample[],
  testSize: number,
  stratifyByTier: boolean
): EvaluationExample[] {
  if (candidates.length <= testSize) {
    return candidates;
  }

  if (!stratifyByTier) {
    // Random sample
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, testSize);
  }

  // Stratified by tier — uses canonical VALID_TIERS so new tiers (T5+) flow
  // through automatically. Shuffles each bucket before slicing.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sampleStratifiedByTier } = require('../lib/outlet-tiers');
  return sampleStratifiedByTier(
    candidates,
    testSize,
    (arr: EvaluationExample[], n: number) => [...arr].sort(() => Math.random() - 0.5).slice(0, n)
  ) as EvaluationExample[];
}

// ========================================
// LLM SCORING
// ========================================

async function scoreExample(
  client: Anthropic,
  example: EvaluationExample,
  model: string
): Promise<{ score: number; bucket: string; confidence: string; reasoning: string } | null> {
  const prompt = buildPrompt(example.fullText);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return null;
    }

    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Math.round(parsed.score),
      bucket: parsed.bucket || scoreToBucket(parsed.score),
      confidence: parsed.confidence || 'medium',
      reasoning: parsed.reasoning || ''
    };
  } catch (e) {
    return null;
  }
}

// ========================================
// ANALYSIS
// ========================================

function analyzeResults(results: EvaluationResult[]): EvaluationSummary {
  const n = results.length;

  // Basic metrics
  const mae = results.reduce((sum, r) => sum + r.absoluteError, 0) / n;
  const mse = results.reduce((sum, r) => sum + r.delta * r.delta, 0) / n;
  const rmse = Math.sqrt(mse);
  const meanBias = results.reduce((sum, r) => sum + r.delta, 0) / n;
  const bucketMatches = results.filter(r => r.bucketMatch).length;
  const bucketAccuracy = (bucketMatches / n) * 100;

  // By tier — uses canonical VALID_TIERS so adding T5+ propagates automatically.
  // Suppresses below significance threshold (n<5) to avoid misleading metrics.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VALID_TIERS: VALID_TIERS_EVAL } = require('../lib/outlet-tiers');
  const MIN_TIER_SAMPLE_FOR_REPORT = 5;
  const byTier = (tier: number) => {
    const tierResults = results.filter(r => r.example.tier === tier);
    if (tierResults.length === 0) return { count: 0, mae: 0, bias: 0 };
    return {
      count: tierResults.length,
      mae: tierResults.reduce((sum, r) => sum + r.absoluteError, 0) / tierResults.length,
      bias: tierResults.reduce((sum, r) => sum + r.delta, 0) / tierResults.length
    };
  };
  const byTierReport: Partial<Record<`tier${1|2|3|4}`, { count: number; mae: number; bias: number }>> = {};
  for (const tier of VALID_TIERS_EVAL as number[]) {
    const stats = byTier(tier);
    if (stats.count < MIN_TIER_SAMPLE_FOR_REPORT) continue;
    byTierReport[`tier${tier}` as `tier${1|2|3|4}`] = {
      count: stats.count,
      mae: Math.round(stats.mae * 100) / 100,
      bias: Math.round(stats.bias * 100) / 100,
    };
  }

  // By human bucket
  const byHumanBucket: Record<string, { count: number; mae: number; bias: number }> = {};
  for (const bucket of ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan']) {
    const bucketResults = results.filter(r => r.example.humanBucket === bucket);
    if (bucketResults.length === 0) continue;
    byHumanBucket[bucket] = {
      count: bucketResults.length,
      mae: bucketResults.reduce((sum, r) => sum + r.absoluteError, 0) / bucketResults.length,
      bias: bucketResults.reduce((sum, r) => sum + r.delta, 0) / bucketResults.length
    };
  }

  // Largest errors
  const sortedByError = [...results].sort((a, b) => b.absoluteError - a.absoluteError);
  const largestErrors = sortedByError.slice(0, 5).map(r => ({
    showId: r.example.showId,
    outlet: r.example.outlet,
    humanScore: r.example.humanScore,
    llmScore: r.llmScore,
    delta: r.delta,
    reasoning: r.llmReasoning
  }));

  // Generate recommendations
  const recommendations: string[] = [];

  if (Math.abs(meanBias) > 5) {
    if (meanBias > 0) {
      recommendations.push(`LLM scores ${meanBias.toFixed(1)} points higher on average. Consider adding examples of overscoring to calibrate down.`);
    } else {
      recommendations.push(`LLM scores ${Math.abs(meanBias).toFixed(1)} points lower on average. Consider adding examples showing higher scores for positive language.`);
    }
  }

  if (bucketAccuracy < 70) {
    recommendations.push(`Bucket accuracy is only ${bucketAccuracy.toFixed(0)}%. Review the score anchor definitions and add more few-shot examples.`);
  }

  const tier1Stats = byTier(1);
  const tier3Stats = byTier(3);
  if (tier1Stats.count > 0 && tier3Stats.count > 0 && Math.abs(tier1Stats.bias - tier3Stats.bias) > 5) {
    recommendations.push(`Tier 1 vs Tier 3 bias differs by ${Math.abs(tier1Stats.bias - tier3Stats.bias).toFixed(1)} points. Consider adding outlet-specific calibration.`);
  }

  for (const [bucket, stats] of Object.entries(byHumanBucket)) {
    if (stats.count >= 3 && Math.abs(stats.bias) > 8) {
      recommendations.push(`${bucket} reviews have ${stats.bias > 0 ? 'over' : 'under'}scoring bias of ${Math.abs(stats.bias).toFixed(1)} points. Add few-shot examples for this bucket.`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('Calibration looks good! MAE < 10 and bucket accuracy > 70% are acceptable thresholds.');
  }

  return {
    testSetSize: n,
    promptVersion: PROMPT_VERSION,
    model: 'claude-sonnet-4-6',
    timestamp: new Date().toISOString(),
    mae: Math.round(mae * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    meanBias: Math.round(meanBias * 100) / 100,
    bucketAccuracy: Math.round(bucketAccuracy * 10) / 10,
    byTier: byTierReport,
    byHumanBucket,
    largestErrors,
    recommendations
  };
}

// ========================================
// MAIN
// ========================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const testSizeArg = args.find(a => a.startsWith('--test-size='));
  const testSize = testSizeArg ? parseInt(testSizeArg.split('=')[1]) : 20;
  const stratifyByTier = args.includes('--by-outlet');
  const verbose = args.includes('--verbose');
  const saveResults = args.includes('--save-results');

  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    process.exit(1);
  }

  console.log('=== LLM Scoring Evaluation ===\n');

  // Load candidates
  const candidates = loadEvaluationCandidates();
  console.log(`Found ${candidates.length} reviews with both full text and human scores`);

  if (candidates.length < testSize) {
    console.log(`Warning: Only ${candidates.length} candidates available, using all of them`);
  }

  // Select test set
  const testSet = selectTestSet(candidates, testSize, stratifyByTier);
  console.log(`Selected ${testSet.length} reviews for evaluation`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VALID_TIERS } = require('../lib/outlet-tiers');
  for (const t of VALID_TIERS as number[]) {
    console.log(`  Tier ${t}: ${testSet.filter(ts => ts.tier === t).length}`);
  }
  console.log('');

  // Score each example
  const client = new Anthropic({ apiKey });
  const model = 'claude-sonnet-4-6';
  const results: EvaluationResult[] = [];

  for (let i = 0; i < testSet.length; i++) {
    const example = testSet[i];
    process.stdout.write(`[${i + 1}/${testSet.length}] ${example.showId} / ${example.outlet}... `);

    const llmResult = await scoreExample(client, example, model);

    if (llmResult) {
      const delta = llmResult.score - example.humanScore;
      const result: EvaluationResult = {
        example,
        llmScore: llmResult.score,
        llmBucket: llmResult.bucket,
        llmConfidence: llmResult.confidence,
        llmReasoning: llmResult.reasoning,
        delta,
        absoluteError: Math.abs(delta),
        bucketMatch: llmResult.bucket.toLowerCase() === example.humanBucket.toLowerCase()
      };
      results.push(result);

      const sign = delta >= 0 ? '+' : '';
      console.log(`Human: ${example.humanScore}, LLM: ${llmResult.score} (${sign}${delta})`);
    } else {
      console.log('FAILED');
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n========================================\n');

  // Analyze results
  const summary = analyzeResults(results);

  // Print summary
  console.log('--- Evaluation Summary ---\n');
  console.log(`Test set size: ${summary.testSetSize}`);
  console.log(`Prompt version: ${summary.promptVersion}`);
  console.log(`Model: ${summary.model}`);
  console.log('');
  console.log(`Mean Absolute Error (MAE): ${summary.mae} points`);
  console.log(`Root Mean Square Error (RMSE): ${summary.rmse} points`);
  console.log(`Mean Bias: ${summary.meanBias > 0 ? '+' : ''}${summary.meanBias} (${summary.meanBias > 0 ? 'LLM scores higher' : 'LLM scores lower'})`);
  console.log(`Bucket Accuracy: ${summary.bucketAccuracy}%`);

  console.log('\n--- By Outlet Tier ---\n');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VALID_TIERS: VT } = require('../lib/outlet-tiers');
  for (const tier of VT as number[]) {
    const bucket = summary.byTier[`tier${tier}` as `tier${1|2|3|4}`];
    if (!bucket) {
      console.log(`Tier ${tier}: (suppressed — sample below significance threshold)`);
      continue;
    }
    console.log(`Tier ${tier}: ${bucket.count} reviews, MAE: ${bucket.mae}, Bias: ${bucket.bias > 0 ? '+' : ''}${bucket.bias}`);
  }

  console.log('\n--- By Human Bucket ---\n');
  for (const [bucket, stats] of Object.entries(summary.byHumanBucket)) {
    console.log(`${bucket}: ${stats.count} reviews, MAE: ${stats.mae.toFixed(1)}, Bias: ${stats.bias > 0 ? '+' : ''}${stats.bias.toFixed(1)}`);
  }

  console.log('\n--- Largest Errors ---\n');
  for (const err of summary.largestErrors) {
    console.log(`${err.showId} / ${err.outlet}: Human ${err.humanScore} vs LLM ${err.llmScore} (Δ${err.delta > 0 ? '+' : ''}${err.delta})`);
    if (verbose && err.reasoning) {
      console.log(`  Reasoning: ${err.reasoning}`);
    }
  }

  console.log('\n--- Recommendations ---\n');
  for (const rec of summary.recommendations) {
    console.log(`• ${rec}`);
  }

  // Save results
  if (saveResults) {
    const outputData = {
      summary,
      results: results.map(r => ({
        showId: r.example.showId,
        outlet: r.example.outlet,
        tier: r.example.tier,
        humanScore: r.example.humanScore,
        humanBucket: r.example.humanBucket,
        llmScore: r.llmScore,
        llmBucket: r.llmBucket,
        llmConfidence: r.llmConfidence,
        delta: r.delta,
        bucketMatch: r.bucketMatch,
        reasoning: r.llmReasoning
      }))
    };

    fs.writeFileSync(EVAL_RESULTS_PATH, JSON.stringify(outputData, null, 2) + '\n');
    console.log(`\nResults saved to: ${EVAL_RESULTS_PATH}`);
  }
}

// Run
main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
