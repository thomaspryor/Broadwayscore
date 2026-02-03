#!/usr/bin/env node

/**
 * V5.2.0 A/B Evaluation Script
 *
 * Scores all ground truth reviews (with explicit star ratings or human overrides)
 * using the v5.2.0 prompt and compares against:
 * 1. Ground truth scores (from explicit ratings)
 * 2. Old v5.1.0 ensemble scores (from files)
 *
 * Does NOT modify any files — pure evaluation.
 *
 * Usage:
 *   source .env && node scripts/eval-v52.js [--limit=N] [--verbose]
 */

const fs = require('fs');
const path = require('path');

// Load .env file manually (source .env doesn't work in all environments)
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const OUTPUT_PATH = path.join(__dirname, '../data/audit/eval-v52-results.json');

// ========================================
// ARGS
// ========================================

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 0;
const VERBOSE = args.includes('--verbose');

// ========================================
// API SETUP
// ========================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!ANTHROPIC_API_KEY || !OPENAI_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY and OPENAI_API_KEY required');
  console.error('Usage: source .env && node scripts/eval-v52.js');
  process.exit(1);
}

// ========================================
// LOAD V5.2.0 PROMPT
// ========================================

// We need the compiled config - use ts-node register
require('ts-node').register({
  project: path.join(__dirname, 'tsconfig.json'),
  transpileOnly: true
});

const { SYSTEM_PROMPT_V5, buildPromptV5, PROMPT_VERSION, BUCKET_RANGES, clampScoreToBucket } = require('./llm-scoring/config');

console.log(`Prompt version: ${PROMPT_VERSION}`);
console.log(`System prompt length: ${SYSTEM_PROMPT_V5.length} chars\n`);

// ========================================
// FIND GROUND TRUTH REVIEWS
// ========================================

function findGroundTruthReviews() {
  const reviews = [];

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
    const fp = path.join(REVIEW_TEXTS_DIR, f);
    if (fs.lstatSync(fp).isSymbolicLink()) return false;
    return fs.statSync(fp).isDirectory();
  });

  for (const show of shows) {
    const dir = path.join(REVIEW_TEXTS_DIR, show);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        // Skip wrong show/production or excluded reviews
        if (data.wrongShow || data.wrongProduction) continue;
        if (data.excludeFromEval) continue;

        // Must have ground truth
        let groundScore = null;
        let groundSource = null;
        if (data.originalScoreNormalized) {
          groundScore = data.originalScoreNormalized;
          groundSource = `explicit: ${data.originalScore}`;
        } else if (data.humanReviewScore) {
          groundScore = data.humanReviewScore;
          groundSource = `human: ${data.humanReviewNote || ''}`.substring(0, 60);
        }
        if (groundScore == null) continue;

        // Must have scoreable text
        if (!data.fullText || data.fullText.length < 100) continue;

        // Get old ensemble score
        const oldScore = data.ensembleData
          ? Math.round((
              (data.ensembleData.claudeScore || 0) +
              (data.ensembleData.openaiScore || 0) +
              (data.ensembleData.geminiScore || 0)
            ) / [data.ensembleData.claudeScore, data.ensembleData.openaiScore, data.ensembleData.geminiScore].filter(s => s != null).length)
          : data.assignedScore;

        reviews.push({
          showId: data.showId,
          outletId: data.outletId,
          outlet: data.outlet,
          criticName: data.criticName,
          groundScore,
          groundSource,
          oldScore: oldScore || data.assignedScore,
          oldBucket: scoreToBucket(oldScore || data.assignedScore || 50),
          fullText: data.fullText,
          originalScore: data.originalScore,
          filePath
        });
      } catch (e) {}
    }
  }

  return reviews;
}

function scoreToBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

// ========================================
// SCORING FUNCTIONS
// ========================================

async function scoreWithClaude(reviewText, context) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = buildPromptV5(reviewText, context);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: SYSTEM_PROMPT_V5,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content.find(c => c.type === 'text')?.text;
  if (!text) return null;
  return parseResponse(text);
}

async function scoreWithOpenAI(reviewText, context) {
  const prompt = buildPromptV5(reviewText, context);
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_V5 },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.3
    })
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return parseResponse(content);
}

async function scoreWithGemini(reviewText, context) {
  if (!GEMINI_API_KEY) return null;

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const client = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: { temperature: 0.3, topP: 0.8, maxOutputTokens: 500 }
  });

  const prompt = buildPromptV5(reviewText, context);
  const fullPrompt = SYSTEM_PROMPT_V5 + '\n\n' + prompt;
  const result = await model.generateContent(fullPrompt);
  const text = result.response.text();
  if (!text) return null;
  return parseResponse(text);
}

function parseResponse(responseText) {
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);

    // Check for rejection
    if (parsed.scoreable === false) {
      return { rejected: true, rejection: parsed.rejection, reasoning: parsed.reasoning };
    }

    const validBuckets = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
    let bucket = parsed.bucket;
    if (!validBuckets.includes(bucket)) {
      const map = { 'rave': 'Rave', 'positive': 'Positive', 'mixed': 'Mixed', 'negative': 'Negative', 'pan': 'Pan' };
      bucket = map[bucket?.toLowerCase()] || 'Mixed';
    }

    let score = typeof parsed.score === 'number' ? parsed.score : parseInt(parsed.score);
    if (isNaN(score)) {
      const range = BUCKET_RANGES[bucket];
      score = Math.floor((range.min + range.max) / 2);
    }
    score = clampScoreToBucket(score, bucket);

    return {
      rejected: false,
      bucket,
      score: Math.round(score),
      confidence: parsed.confidence || 'medium',
      reasoning: parsed.reasoning || ''
    };
  } catch (e) {
    return null;
  }
}

// ========================================
// ENSEMBLE SCORING
// ========================================

async function ensembleScore(reviewText, context) {
  const [claude, openai, gemini] = await Promise.all([
    scoreWithClaude(reviewText, context).catch(() => null),
    scoreWithOpenAI(reviewText, context).catch(() => null),
    scoreWithGemini(reviewText, context).catch(() => null)
  ]);

  const results = { claude, openai, gemini };

  // Check rejections
  const rejections = Object.entries(results).filter(([, r]) => r && r.rejected);
  if (rejections.length >= 2) {
    return {
      rejected: true,
      rejection: rejections[0][1].rejection,
      reasoning: rejections.map(([m, r]) => `${m}: ${r.reasoning}`).join('; '),
      modelResults: results
    };
  }

  // Collect valid scores (non-null, non-rejected)
  const validScores = Object.entries(results)
    .filter(([, r]) => r && !r.rejected && r.score != null)
    .map(([model, r]) => ({ model, ...r }));

  if (validScores.length === 0) {
    return { error: 'All models failed', modelResults: results };
  }

  // Majority bucket
  const bucketCounts = {};
  for (const r of validScores) {
    bucketCounts[r.bucket] = (bucketCounts[r.bucket] || 0) + 1;
  }
  const majorityBucket = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0][0];
  const majorityCount = bucketCounts[majorityBucket];

  // Score from majority models
  const majorityScores = validScores.filter(r => r.bucket === majorityBucket);
  const avgScore = Math.round(majorityScores.reduce((s, r) => s + r.score, 0) / majorityScores.length);
  const finalScore = clampScoreToBucket(avgScore, majorityBucket);

  return {
    rejected: false,
    score: finalScore,
    bucket: majorityBucket,
    source: majorityCount === validScores.length ? 'unanimous' : majorityCount >= 2 ? 'majority' : 'average',
    modelResults: results,
    claudeScore: claude && !claude.rejected ? claude.score : null,
    openaiScore: openai && !openai.rejected ? openai.score : null,
    geminiScore: gemini && !gemini.rejected ? gemini.score : null
  };
}

// ========================================
// MAIN
// ========================================

async function main() {
  console.log('=== V5.2.0 A/B Evaluation ===\n');

  const allReviews = findGroundTruthReviews();
  console.log(`Found ${allReviews.length} ground truth reviews with full text.\n`);

  // Sort by ground score to process negatives/pans first (most important for this eval)
  allReviews.sort((a, b) => a.groundScore - b.groundScore);

  const reviews = LIMIT > 0 ? allReviews.slice(0, LIMIT) : allReviews;
  console.log(`Scoring ${reviews.length} reviews...\n`);

  const results = [];
  let scored = 0;
  let rejected = 0;
  let errors = 0;

  for (let i = 0; i < reviews.length; i++) {
    const r = reviews[i];
    process.stdout.write(`  [${i + 1}/${reviews.length}] ${r.showId} / ${r.outlet}... `);

    try {
      const context = r.originalScore ? `Original rating: ${r.originalScore}` : '';
      const result = await ensembleScore(r.fullText, context);

      if (result.error) {
        console.log('FAILED');
        errors++;
        continue;
      }

      if (result.rejected) {
        console.log(`REJECTED (${result.rejection})`);
        rejected++;
        results.push({
          ...r,
          fullText: undefined,
          v52Score: null,
          v52Bucket: null,
          rejected: true,
          rejection: result.rejection
        });
        continue;
      }

      const diff = result.score - r.groundScore;
      const oldDiff = r.oldScore - r.groundScore;
      const match = result.bucket === scoreToBucket(r.groundScore);
      const improved = Math.abs(diff) < Math.abs(oldDiff);

      console.log(
        `v5.2: ${result.bucket}(${result.score}) vs GT:${r.groundScore} ` +
        `[${diff >= 0 ? '+' : ''}${diff}] ` +
        `old:${r.oldScore}[${oldDiff >= 0 ? '+' : ''}${oldDiff}] ` +
        `${improved ? 'BETTER' : Math.abs(diff) === Math.abs(oldDiff) ? 'SAME' : 'WORSE'}`
      );

      scored++;
      results.push({
        showId: r.showId,
        outletId: r.outletId,
        outlet: r.outlet,
        groundScore: r.groundScore,
        groundSource: r.groundSource,
        groundBucket: scoreToBucket(r.groundScore),
        oldScore: r.oldScore,
        oldBucket: r.oldBucket,
        v52Score: result.score,
        v52Bucket: result.bucket,
        diff,
        oldDiff,
        improved,
        bucketMatch: match,
        oldBucketMatch: r.oldBucket === scoreToBucket(r.groundScore),
        claudeScore: result.claudeScore,
        openaiScore: result.openaiScore,
        geminiScore: result.geminiScore,
        source: result.source
      });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }

    // Rate limit
    if (i < reviews.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  // ========================================
  // ANALYSIS
  // ========================================

  const scoredResults = results.filter(r => r.v52Score != null);

  console.log('\n' + '='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80));
  console.log(`\nScored: ${scored}, Rejected: ${rejected}, Errors: ${errors}\n`);

  if (scoredResults.length === 0) {
    console.log('No scored results to analyze.');
    return;
  }

  // Overall metrics
  const v52Diffs = scoredResults.map(r => r.diff);
  const oldDiffs = scoredResults.map(r => r.oldDiff);

  const v52MAE = v52Diffs.reduce((s, d) => s + Math.abs(d), 0) / v52Diffs.length;
  const oldMAE = oldDiffs.reduce((s, d) => s + Math.abs(d), 0) / oldDiffs.length;
  const v52MeanBias = v52Diffs.reduce((s, d) => s + d, 0) / v52Diffs.length;
  const oldMeanBias = oldDiffs.reduce((s, d) => s + d, 0) / oldDiffs.length;
  const v52BucketAcc = scoredResults.filter(r => r.bucketMatch).length / scoredResults.length;
  const oldBucketAcc = scoredResults.filter(r => r.oldBucketMatch).length / scoredResults.length;
  const improved = scoredResults.filter(r => r.improved).length;
  const worsened = scoredResults.filter(r => !r.improved && Math.abs(r.diff) > Math.abs(r.oldDiff)).length;

  console.log('--- Overall ---');
  console.log(`                    v5.1.0     v5.2.0    Change`);
  console.log(`  MAE:              ${oldMAE.toFixed(1).padStart(6)}     ${v52MAE.toFixed(1).padStart(6)}    ${(v52MAE - oldMAE) >= 0 ? '+' : ''}${(v52MAE - oldMAE).toFixed(1)}`);
  console.log(`  Mean Bias:        ${oldMeanBias >= 0 ? '+' : ''}${oldMeanBias.toFixed(1).padStart(5)}     ${v52MeanBias >= 0 ? '+' : ''}${v52MeanBias.toFixed(1).padStart(5)}`);
  console.log(`  Bucket Accuracy:  ${(oldBucketAcc * 100).toFixed(1)}%     ${(v52BucketAcc * 100).toFixed(1)}%`);
  console.log(`  Improved: ${improved}/${scoredResults.length} (${(improved / scoredResults.length * 100).toFixed(0)}%)`);
  console.log(`  Worsened: ${worsened}/${scoredResults.length} (${(worsened / scoredResults.length * 100).toFixed(0)}%)`);

  // Per-bucket metrics
  console.log('\n--- By Bucket (Ground Truth) ---');
  for (const bucket of ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan']) {
    const bucketResults = scoredResults.filter(r => r.groundBucket === bucket);
    if (bucketResults.length === 0) continue;

    const bV52MAE = bucketResults.reduce((s, r) => s + Math.abs(r.diff), 0) / bucketResults.length;
    const bOldMAE = bucketResults.reduce((s, r) => s + Math.abs(r.oldDiff), 0) / bucketResults.length;
    const bV52Bias = bucketResults.reduce((s, r) => s + r.diff, 0) / bucketResults.length;
    const bOldBias = bucketResults.reduce((s, r) => s + r.oldDiff, 0) / bucketResults.length;
    const bV52Acc = bucketResults.filter(r => r.bucketMatch).length;
    const bOldAcc = bucketResults.filter(r => r.oldBucketMatch).length;

    console.log(`\n  ${bucket} (n=${bucketResults.length}):`);
    console.log(`    MAE:     v5.1=${bOldMAE.toFixed(1)}, v5.2=${bV52MAE.toFixed(1)} (${(bV52MAE - bOldMAE) >= 0 ? '+' : ''}${(bV52MAE - bOldMAE).toFixed(1)})`);
    console.log(`    Bias:    v5.1=${bOldBias >= 0 ? '+' : ''}${bOldBias.toFixed(1)}, v5.2=${bV52Bias >= 0 ? '+' : ''}${bV52Bias.toFixed(1)}`);
    console.log(`    Bucket:  v5.1=${bOldAcc}/${bucketResults.length}, v5.2=${bV52Acc}/${bucketResults.length}`);
  }

  // Worst outliers (v5.2.0)
  const outliers = [...scoredResults].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10);
  console.log('\n--- Top 10 Outliers (v5.2.0 vs Ground Truth) ---');
  for (const r of outliers) {
    console.log(`  ${r.showId} / ${r.outlet}: v5.2=${r.v52Score} GT=${r.groundScore} diff=${r.diff >= 0 ? '+' : ''}${r.diff} (old diff=${r.oldDiff >= 0 ? '+' : ''}${r.oldDiff}) ${r.groundSource}`);
  }

  // Biggest improvements
  const improvements = [...scoredResults]
    .map(r => ({ ...r, improvementPts: Math.abs(r.oldDiff) - Math.abs(r.diff) }))
    .sort((a, b) => b.improvementPts - a.improvementPts)
    .slice(0, 10);
  console.log('\n--- Top 10 Improvements (v5.1 → v5.2) ---');
  for (const r of improvements) {
    console.log(`  ${r.showId} / ${r.outlet}: old=${r.oldScore}(${r.oldDiff >= 0 ? '+' : ''}${r.oldDiff}) → v5.2=${r.v52Score}(${r.diff >= 0 ? '+' : ''}${r.diff}) improved by ${r.improvementPts} pts`);
  }

  // Biggest regressions
  const regressions = [...scoredResults]
    .map(r => ({ ...r, regressionPts: Math.abs(r.diff) - Math.abs(r.oldDiff) }))
    .sort((a, b) => b.regressionPts - a.regressionPts)
    .slice(0, 10);
  console.log('\n--- Top 10 Regressions (v5.1 → v5.2) ---');
  for (const r of regressions) {
    if (r.regressionPts <= 0) { console.log('  (none)'); break; }
    console.log(`  ${r.showId} / ${r.outlet}: old=${r.oldScore}(${r.oldDiff >= 0 ? '+' : ''}${r.oldDiff}) → v5.2=${r.v52Score}(${r.diff >= 0 ? '+' : ''}${r.diff}) regressed by ${r.regressionPts} pts`);
  }

  // Save results
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    promptVersion: PROMPT_VERSION,
    runAt: new Date().toISOString(),
    totalReviews: reviews.length,
    scored,
    rejected,
    errors,
    metrics: {
      v52: { mae: v52MAE, meanBias: v52MeanBias, bucketAccuracy: v52BucketAcc },
      v51: { mae: oldMAE, meanBias: oldMeanBias, bucketAccuracy: oldBucketAcc }
    },
    results
  }, null, 2) + '\n');
  console.log(`\nResults saved to: ${OUTPUT_PATH}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
