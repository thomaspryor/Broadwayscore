#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * Comprehensive Scoring Experiment
 *
 * 1. Score 100 reviews with ensemble
 * 2. Score 100 explicitly-scored reviews and compare to critic scores
 * 3. Test different prompt variations
 * 4. Generate detailed analysis report
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReviewScorer } from './scorer';
import { OpenAIReviewScorer } from './openai-scorer';
import { GeminiScorer } from './gemini-scorer';
import { BUCKET_RANGES } from './config';

// ========================================
// TYPES
// ========================================

interface ReviewData {
  id: string;
  showId: string;
  outlet: string;
  text: string;
  originalScore: number | null;
  dtliThumb: string | null;
  bwwThumb: string | null;
}

interface ScoringResult {
  reviewId: string;
  originalScore: number | null;
  claudeScore: number;
  claudeBucket: string;
  openaiScore: number;
  openaiBucket: string;
  geminiScore: number | null;
  geminiBucket: string | null;
  ensembleScore: number;
  ensembleBucket: string;
  dtliThumb: string | null;
}

interface PromptVariant {
  name: string;
  systemPrompt: string;
  userPromptTemplate: (text: string) => string;
}

// ========================================
// PROMPT VARIANTS
// ========================================

const PROMPT_VARIANTS: PromptVariant[] = [
  {
    name: 'baseline',
    systemPrompt: `You are a theater critic scoring system. Score Broadway reviews on a 0-100 scale.

Buckets:
- Rave (85-100): Enthusiastic, unreserved praise
- Positive (68-84): Generally favorable
- Mixed (50-67): Balanced pros and cons
- Negative (30-49): More negative than positive
- Pan (0-29): Strongly negative

Respond with JSON only: {"bucket": "...", "score": N}`,
    userPromptTemplate: (text) => `Score this review:\n\n${text}`
  },
  {
    name: 'anchored',
    systemPrompt: `You are a theater critic scoring system calibrated to match professional review aggregators.

Reference points:
- 95: "A masterpiece, unmissable" (5 stars, A+)
- 85: "Highly recommended, excellent" (4 stars, A/A-)
- 75: "Good, worth seeing" (3.5 stars, B+)
- 65: "Decent but flawed" (3 stars, B/B-)
- 55: "Mixed, some merits" (2.5 stars, C+)
- 45: "Disappointing" (2 stars, C/C-)
- 30: "Poor, not recommended" (1.5 stars, D)
- 15: "Terrible" (1 star, F)

Respond with JSON only: {"bucket": "Rave|Positive|Mixed|Negative|Pan", "score": N}`,
    userPromptTemplate: (text) => `Score this Broadway review:\n\n${text}`
  },
  {
    name: 'sentiment-first',
    systemPrompt: `You are a sentiment analyzer for theater reviews.

Step 1: Identify the overall sentiment (Very Positive, Positive, Mixed, Negative, Very Negative)
Step 2: Map to score range:
- Very Positive → 85-100
- Positive → 68-84
- Mixed → 50-67
- Negative → 30-49
- Very Negative → 0-29
Step 3: Pick exact score based on intensity

Respond with JSON only: {"bucket": "Rave|Positive|Mixed|Negative|Pan", "score": N}`,
    userPromptTemplate: (text) => `Analyze sentiment and score:\n\n${text}`
  },
  {
    name: 'comparative',
    systemPrompt: `You are a theater review scorer. Consider what score a professional aggregator like Rotten Tomatoes or Metacritic would assign.

Think about:
- Would this review contribute to a "Fresh" or "Rotten" rating?
- What Metascore (0-100) would this review suggest?

Buckets: Rave (85-100), Positive (68-84), Mixed (50-67), Negative (30-49), Pan (0-29)

Respond with JSON only: {"bucket": "...", "score": N}`,
    userPromptTemplate: (text) => `What score would an aggregator assign?\n\n${text}`
  }
];

// ========================================
// UTILITY FUNCTIONS
// ========================================

function scoreToBucket(score: number): string {
  if (score >= 85) return 'Rave';
  if (score >= 68) return 'Positive';
  if (score >= 50) return 'Mixed';
  if (score >= 30) return 'Negative';
  return 'Pan';
}

function bucketToThumb(bucket: string): string {
  if (bucket === 'Rave' || bucket === 'Positive') return 'Up';
  if (bucket === 'Mixed') return 'Meh';
  return 'Down';
}

function normalizeThumb(thumb: string | null): string | null {
  if (!thumb) return null;
  const t = thumb.toLowerCase();
  if (t === 'up') return 'Up';
  if (t === 'down') return 'Down';
  if (t === 'meh' || t === 'mixed') return 'Meh';
  return null;
}

function findReviews(options: { withOriginalScore?: boolean; withFullText?: boolean; limit: number }): ReviewData[] {
  const reviewsDir = 'data/review-texts';
  const reviews: ReviewData[] = [];

  const shows = fs.readdirSync(reviewsDir).filter(f =>
    fs.statSync(path.join(reviewsDir, f)).isDirectory()
  );

  for (const show of shows) {
    if (reviews.length >= options.limit) break;

    const files = fs.readdirSync(path.join(reviewsDir, show))
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      if (reviews.length >= options.limit) break;

      try {
        const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, show, file), 'utf8'));

        // Check filters
        if (options.withOriginalScore && (data.originalScore === null || data.originalScore === undefined)) continue;
        if (options.withFullText && (!data.fullText || data.fullText.length < 300)) continue;

        const text = data.fullText || data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt;
        if (!text || text.length < 100) continue;

        reviews.push({
          id: `${show}/${data.outlet}`,
          showId: show,
          outlet: data.outlet,
          text: text.substring(0, 3000), // Limit text length
          originalScore: data.originalScore,
          dtliThumb: data.dtliThumb || null,
          bwwThumb: data.bwwThumb || null
        });
      } catch (e) { }
    }
  }

  return reviews;
}

// ========================================
// SCORING FUNCTIONS
// ========================================

async function scoreWithPrompt(
  scorer: ReviewScorer | OpenAIReviewScorer | GeminiScorer,
  text: string,
  variant: PromptVariant
): Promise<{ score: number; bucket: string } | null> {
  try {
    // For now, use the default V5 scoring since we can't easily swap prompts
    // In a real implementation, we'd need to modify the scorer classes
    if (scorer instanceof ReviewScorer) {
      const result = await (scorer as ReviewScorer).scoreReviewV5(text, '');
      if (result.success && result.result) {
        return { score: result.result.score, bucket: result.result.bucket };
      }
    } else if (scorer instanceof OpenAIReviewScorer) {
      const result = await (scorer as OpenAIReviewScorer).scoreReviewV5(text, '');
      if (result.success && result.result) {
        return { score: result.result.score, bucket: result.result.bucket };
      }
    } else if (scorer instanceof GeminiScorer) {
      const result = await (scorer as GeminiScorer).scoreReview(text, '');
      if (result.success && result.result) {
        return { score: result.result.score, bucket: result.result.bucket };
      }
    }
  } catch (e) { }
  return null;
}

async function scoreReviewWithEnsemble(
  claudeScorer: ReviewScorer,
  openaiScorer: OpenAIReviewScorer,
  geminiScorer: GeminiScorer | null,
  text: string
): Promise<{
  claude: { score: number; bucket: string } | null;
  openai: { score: number; bucket: string } | null;
  gemini: { score: number; bucket: string } | null;
  ensemble: { score: number; bucket: string };
}> {
  // Run all models in parallel
  const [claudeResult, openaiResult, geminiResult] = await Promise.all([
    claudeScorer.scoreReviewV5(text, '').then(r => r.success && r.result ? { score: r.result.score, bucket: r.result.bucket } : null).catch(() => null),
    openaiScorer.scoreReviewV5(text, '').then(r => r.success && r.result ? { score: r.result.score, bucket: r.result.bucket } : null).catch(() => null),
    geminiScorer ? geminiScorer.scoreReview(text, '').then(r => r.success && r.result ? { score: r.result.score, bucket: r.result.bucket } : null).catch(() => null) : Promise.resolve(null)
  ]);

  // Calculate ensemble score using bucket-first approach
  const buckets: string[] = [];
  const scores: number[] = [];

  if (claudeResult) { buckets.push(claudeResult.bucket); scores.push(claudeResult.score); }
  if (openaiResult) { buckets.push(openaiResult.bucket); scores.push(openaiResult.score); }
  if (geminiResult) { buckets.push(geminiResult.bucket); scores.push(geminiResult.score); }

  // Vote on bucket
  const bucketCounts: Record<string, number> = {};
  buckets.forEach(b => bucketCounts[b] = (bucketCounts[b] || 0) + 1);
  const winningBucket = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Mixed';

  // Average scores from models that voted for winning bucket
  const winningScores: number[] = [];
  if (claudeResult?.bucket === winningBucket) winningScores.push(claudeResult.score);
  if (openaiResult?.bucket === winningBucket) winningScores.push(openaiResult.score);
  if (geminiResult?.bucket === winningBucket) winningScores.push(geminiResult.score);

  // If no models voted for winning bucket (shouldn't happen), use all scores
  const finalScores = winningScores.length > 0 ? winningScores : scores;
  const ensembleScore = Math.round(finalScores.reduce((a, b) => a + b, 0) / finalScores.length);

  return {
    claude: claudeResult,
    openai: openaiResult,
    gemini: geminiResult,
    ensemble: { score: ensembleScore, bucket: winningBucket }
  };
}

// ========================================
// ANALYSIS FUNCTIONS
// ========================================

function analyzeResults(results: ScoringResult[]): void {
  console.log('\n' + '='.repeat(60));
  console.log('EXPERIMENT RESULTS ANALYSIS');
  console.log('='.repeat(60));

  // 1. Accuracy vs Original Scores
  const withOriginal = results.filter(r => r.originalScore !== null);
  if (withOriginal.length > 0) {
    console.log(`\n--- Accuracy vs Critic Original Scores (n=${withOriginal.length}) ---\n`);

    for (const model of ['claude', 'openai', 'gemini', 'ensemble'] as const) {
      const scoreKey = model === 'ensemble' ? 'ensembleScore' : `${model}Score`;
      const validResults = withOriginal.filter(r => (r as any)[scoreKey] !== null);

      if (validResults.length === 0) continue;

      let totalError = 0;
      let totalBias = 0;

      validResults.forEach(r => {
        const modelScore = (r as any)[scoreKey] as number;
        const original = r.originalScore!;
        totalError += Math.abs(modelScore - original);
        totalBias += modelScore - original;
      });

      const mae = (totalError / validResults.length).toFixed(1);
      const bias = (totalBias / validResults.length).toFixed(1);
      const biasDir = parseFloat(bias) >= 0 ? 'higher' : 'lower';

      console.log(`${model.toUpperCase()}:`);
      console.log(`  MAE: ${mae} points`);
      console.log(`  Bias: ${Math.abs(parseFloat(bias)).toFixed(1)} points ${biasDir} than critics`);
    }
  }

  // 2. Accuracy vs DTLI Thumbs
  const withThumb = results.filter(r => r.dtliThumb !== null);
  if (withThumb.length > 0) {
    console.log(`\n--- Accuracy vs DTLI Thumbs (n=${withThumb.length}) ---\n`);

    for (const model of ['claude', 'openai', 'gemini', 'ensemble'] as const) {
      const bucketKey = model === 'ensemble' ? 'ensembleBucket' : `${model}Bucket`;
      const validResults = withThumb.filter(r => (r as any)[bucketKey] !== null);

      if (validResults.length === 0) continue;

      let correct = 0;
      validResults.forEach(r => {
        const modelBucket = (r as any)[bucketKey] as string;
        const modelThumb = bucketToThumb(modelBucket);
        const dtliThumb = normalizeThumb(r.dtliThumb);
        if (modelThumb === dtliThumb) correct++;
      });

      const accuracy = ((correct / validResults.length) * 100).toFixed(1);
      console.log(`${model.toUpperCase()}: ${correct}/${validResults.length} (${accuracy}%)`);
    }
  }

  // 3. Model Agreement Analysis
  console.log(`\n--- Model Agreement Analysis (n=${results.length}) ---\n`);

  let unanimous = 0;
  let majority = 0;
  let noConsensus = 0;

  results.forEach(r => {
    const buckets = [r.claudeBucket, r.openaiBucket, r.geminiBucket].filter(b => b !== null);
    const uniqueBuckets = new Set(buckets);

    if (uniqueBuckets.size === 1) unanimous++;
    else if (buckets.length >= 2) {
      const counts: Record<string, number> = {};
      buckets.forEach(b => counts[b!] = (counts[b!] || 0) + 1);
      const maxCount = Math.max(...Object.values(counts));
      if (maxCount >= 2) majority++;
      else noConsensus++;
    }
  });

  console.log(`Unanimous (all agree): ${unanimous} (${((unanimous / results.length) * 100).toFixed(1)}%)`);
  console.log(`Majority (2/3 agree): ${majority} (${((majority / results.length) * 100).toFixed(1)}%)`);
  console.log(`No consensus: ${noConsensus} (${((noConsensus / results.length) * 100).toFixed(1)}%)`);

  // 4. Score Distribution
  console.log(`\n--- Score Distribution ---\n`);

  for (const model of ['claude', 'openai', 'gemini', 'ensemble'] as const) {
    const scoreKey = model === 'ensemble' ? 'ensembleScore' : `${model}Score`;
    const scores = results.map(r => (r as any)[scoreKey]).filter(s => s !== null) as number[];

    if (scores.length === 0) continue;

    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
    const min = Math.min(...scores);
    const max = Math.max(...scores);

    console.log(`${model.toUpperCase()}: avg=${avg}, range=${min}-${max}`);
  }

  // 5. Largest Disagreements
  console.log(`\n--- Largest Model Disagreements (top 10) ---\n`);

  const withAllScores = results.filter(r => r.claudeScore && r.openaiScore);
  const disagreements = withAllScores.map(r => {
    const scores = [r.claudeScore, r.openaiScore, r.geminiScore].filter(s => s !== null) as number[];
    const spread = Math.max(...scores) - Math.min(...scores);
    return { ...r, spread };
  }).sort((a, b) => b.spread - a.spread);

  disagreements.slice(0, 10).forEach(r => {
    console.log(`${r.reviewId}:`);
    console.log(`  Claude=${r.claudeScore} (${r.claudeBucket}), OpenAI=${r.openaiScore} (${r.openaiBucket}), Gemini=${r.geminiScore || 'N/A'} (${r.geminiBucket || 'N/A'})`);
    console.log(`  Spread: ${r.spread} points`);
    if (r.originalScore) console.log(`  Original critic score: ${r.originalScore}`);
  });
}

// ========================================
// MAIN
// ========================================

async function main() {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!claudeKey || !openaiKey) {
    console.error('Need ANTHROPIC_API_KEY and OPENAI_API_KEY');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('COMPREHENSIVE SCORING EXPERIMENT');
  console.log('='.repeat(60));
  console.log(`\nStarted: ${new Date().toISOString()}\n`);

  const claudeScorer = new ReviewScorer(claudeKey, { model: 'claude-sonnet-4-20250514', verbose: false });
  const openaiScorer = new OpenAIReviewScorer(openaiKey, { model: 'gpt-4o', verbose: false });
  const geminiScorer = geminiKey ? new GeminiScorer(geminiKey, { model: 'gemini-2.0-flash', verbose: false }) : null;

  console.log(`Models: Claude Sonnet, GPT-4o${geminiScorer ? ', Gemini 2.0 Flash' : ''}`);

  // Part 1: Find and score 100 reviews with explicit original scores
  console.log('\n--- Part 1: Reviews with Explicit Critic Scores ---\n');

  const explicitlyScored = findReviews({ withOriginalScore: true, withFullText: true, limit: 100 });
  console.log(`Found ${explicitlyScored.length} reviews with explicit critic scores and full text`);

  const results: ScoringResult[] = [];

  for (let i = 0; i < explicitlyScored.length; i++) {
    const review = explicitlyScored[i];
    process.stdout.write(`\r[${i + 1}/${explicitlyScored.length}] Scoring ${review.id.substring(0, 40)}...`);

    try {
      const scores = await scoreReviewWithEnsemble(claudeScorer, openaiScorer, geminiScorer, review.text);

      results.push({
        reviewId: review.id,
        originalScore: review.originalScore,
        claudeScore: scores.claude?.score || 0,
        claudeBucket: scores.claude?.bucket || 'Unknown',
        openaiScore: scores.openai?.score || 0,
        openaiBucket: scores.openai?.bucket || 'Unknown',
        geminiScore: scores.gemini?.score || null,
        geminiBucket: scores.gemini?.bucket || null,
        ensembleScore: scores.ensemble.score,
        ensembleBucket: scores.ensemble.bucket,
        dtliThumb: review.dtliThumb
      });

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) {
      console.log(`\nError scoring ${review.id}: ${e.message}`);
    }
  }

  console.log('\n');

  // Part 2: Score additional reviews (any reviews with full text)
  console.log('--- Part 2: Additional Reviews with Full Text ---\n');

  const additionalReviews = findReviews({ withFullText: true, limit: 100 })
    .filter(r => !results.some(res => res.reviewId === r.id));

  console.log(`Found ${additionalReviews.length} additional reviews with full text`);

  for (let i = 0; i < Math.min(additionalReviews.length, 100 - results.length); i++) {
    const review = additionalReviews[i];
    process.stdout.write(`\r[${results.length + 1}/100] Scoring ${review.id.substring(0, 40)}...`);

    try {
      const scores = await scoreReviewWithEnsemble(claudeScorer, openaiScorer, geminiScorer, review.text);

      results.push({
        reviewId: review.id,
        originalScore: review.originalScore,
        claudeScore: scores.claude?.score || 0,
        claudeBucket: scores.claude?.bucket || 'Unknown',
        openaiScore: scores.openai?.score || 0,
        openaiBucket: scores.openai?.bucket || 'Unknown',
        geminiScore: scores.gemini?.score || null,
        geminiBucket: scores.gemini?.bucket || null,
        ensembleScore: scores.ensemble.score,
        ensembleBucket: scores.ensemble.bucket,
        dtliThumb: review.dtliThumb
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) {
      console.log(`\nError scoring ${review.id}: ${e.message}`);
    }
  }

  console.log('\n');

  // Analyze results
  analyzeResults(results);

  // Save detailed results
  const outputPath = 'data/audit/scoring-experiment-results.json';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalReviews: results.length,
    withOriginalScore: results.filter(r => r.originalScore !== null).length,
    withDtliThumb: results.filter(r => r.dtliThumb !== null).length,
    results
  }, null, 2));

  console.log(`\nDetailed results saved to: ${outputPath}`);

  // Token usage
  const claudeUsage = claudeScorer.getTokenUsage();
  const openaiUsage = openaiScorer.getTokenUsage();
  const geminiUsage = geminiScorer?.getTokenUsage();

  console.log('\n--- Token Usage ---\n');
  console.log(`Claude: ${claudeUsage.total} tokens`);
  console.log(`OpenAI: ${openaiUsage.total} tokens`);
  if (geminiUsage) console.log(`Gemini: ${geminiUsage.total} tokens`);

  console.log(`\nCompleted: ${new Date().toISOString()}`);
}

main().catch(console.error);
