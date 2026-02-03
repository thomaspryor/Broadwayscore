#!/usr/bin/env node

/**
 * Kimi K2.5 Comparison vs Ground Truth
 *
 * Scores reviews with explicit ratings (star/letter/numeric) using Kimi K2.5
 * via OpenRouter and compares against:
 * 1. Ground truth scores (from explicit ratings or human overrides)
 * 2. Existing ensemble scores (Claude + GPT-4o + Gemini, already computed)
 *
 * Does NOT modify any files — pure evaluation.
 *
 * Usage:
 *   node scripts/kimi-dry-run.js [--limit=500] [--verbose]
 */

const fs = require('fs');
const path = require('path');

// Load .env file manually
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ========================================
// CONFIG
// ========================================

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const KIMI_MODEL = 'moonshotai/kimi-k2.5';
const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500;
const VERBOSE = args.includes('--verbose');

// Load the actual V5.2.0 prompt from config
require('ts-node').register({
  project: path.join(__dirname, 'tsconfig.json'),
  transpileOnly: true
});
const { SYSTEM_PROMPT_V5, buildPromptV5, PROMPT_VERSION, BUCKET_RANGES, clampScoreToBucket } = require('./llm-scoring/config');

console.log(`Prompt version: ${PROMPT_VERSION}`);

// ========================================
// HELPERS
// ========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scoreToBucket(score) {
  if (score >= 85) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

function parseKimiResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);

    // Handle rejection (scoreability check)
    if (parsed.scoreable === false) {
      return { rejected: true, rejection: parsed.rejection || 'unknown', reasoning: parsed.reasoning || '' };
    }

    const validBuckets = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
    let bucket = parsed.bucket;
    if (!validBuckets.includes(bucket)) {
      const map = { 'RAVE': 'Rave', 'rave': 'Rave', 'POSITIVE': 'Positive', 'positive': 'Positive',
                     'MIXED': 'Mixed', 'mixed': 'Mixed', 'NEGATIVE': 'Negative', 'negative': 'Negative',
                     'PAN': 'Pan', 'pan': 'Pan' };
      bucket = map[parsed.bucket] || null;
    }
    let score = typeof parsed.score === 'number' ? parsed.score : parseInt(parsed.score);
    if (isNaN(score) || !bucket) return null;
    score = clampScoreToBucket(score, bucket);
    return { rejected: false, bucket, score, confidence: parsed.confidence || 'unknown', reasoning: parsed.reasoning || '' };
  } catch (e) {
    // Try regex extraction
    const bucketMatch = text.match(/"bucket"\s*:\s*"(Rave|Positive|Mixed|Negative|Pan)"/i);
    const scoreMatch = text.match(/"score"\s*:\s*(\d+)/);
    if (bucketMatch && scoreMatch) {
      const bucket = bucketMatch[1].charAt(0).toUpperCase() + bucketMatch[1].slice(1).toLowerCase();
      const score = clampScoreToBucket(parseInt(scoreMatch[1]), bucket);
      return { rejected: false, bucket, score, confidence: 'low', reasoning: 'Extracted from malformed response' };
    }
    return null;
  }
}

async function scoreWithKimi(reviewText, context) {
  const prompt = buildPromptV5(reviewText, context);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(OPENROUTER_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://broadwayscorecard.com',
          'X-Title': 'Broadway Scorecard Kimi Comparison'
        },
        body: JSON.stringify({
          model: KIMI_MODEL,
          temperature: 0.3,
          max_tokens: 4000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_V5 },
            { role: 'user', content: prompt }
          ]
        })
      });

      if (response.status === 429) {
        const wait = Math.pow(2, attempt) * 3000;
        console.log(`  Rate limited, waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.substring(0, 200)}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');

      const parsed = parseKimiResponse(content);
      if (!parsed) throw new Error(`Parse failed: ${content.substring(0, 200)}`);

      return { success: true, ...parsed };
    } catch (err) {
      if (attempt === 3) return { success: false, error: err.message };
      await sleep(2000 * attempt);
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

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

        if (data.wrongShow || data.wrongProduction) continue;
        if (data.excludeFromEval) continue;

        // Must have ground truth from explicit rating or human override
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

        // Get existing ensemble score
        const ensembleScore = data.ensembleData
          ? Math.round((
              (data.ensembleData.claudeScore || 0) +
              (data.ensembleData.openaiScore || 0) +
              (data.ensembleData.geminiScore || 0)
            ) / [data.ensembleData.claudeScore, data.ensembleData.openaiScore, data.ensembleData.geminiScore].filter(s => s != null).length)
          : data.assignedScore;

        reviews.push({
          showId: data.showId,
          outletId: data.outletId,
          outlet: data.outlet || data.outletId,
          criticName: data.criticName,
          groundScore,
          groundSource,
          groundBucket: scoreToBucket(groundScore),
          ensembleScore: ensembleScore || data.assignedScore,
          ensembleBucket: data.ensembleData?.claudeBucket || scoreToBucket(ensembleScore || data.assignedScore || 50),
          claudeScore: data.ensembleData?.claudeScore,
          openaiScore: data.ensembleData?.openaiScore,
          geminiScore: data.ensembleData?.geminiScore,
          fullText: data.fullText,
          originalScore: data.originalScore,
          filePath
        });
      } catch (e) { /* skip */ }
    }
  }

  return reviews;
}

// ========================================
// MAIN
// ========================================

async function main() {
  if (!OPENROUTER_API_KEY) {
    console.error('ERROR: OPENROUTER_API_KEY not set. Check .env file.');
    process.exit(1);
  }

  console.log(`\n=== Kimi K2.5 Ground Truth Comparison ===`);
  console.log(`Model: ${KIMI_MODEL} via OpenRouter`);
  console.log(`Limit: ${LIMIT} reviews\n`);

  // Find all ground truth reviews
  console.log('Finding ground truth reviews...');
  const allReviews = findGroundTruthReviews();
  console.log(`Found ${allReviews.length} ground truth reviews with scoreable text.`);

  // Count by bucket
  const bucketCounts = {};
  for (const r of allReviews) {
    bucketCounts[r.groundBucket] = (bucketCounts[r.groundBucket] || 0) + 1;
  }
  console.log('Distribution:', Object.entries(bucketCounts).map(([k,v]) => `${k}:${v}`).join(', '));

  // Shuffle and limit
  const shuffled = allReviews.sort(() => Math.random() - 0.5);
  const reviews = shuffled.slice(0, LIMIT);
  console.log(`\nScoring ${reviews.length} reviews with Kimi K2.5...\n`);

  // Score with Kimi in parallel batches
  const BATCH_SIZE = 10;
  const results = [];
  let successes = 0;
  let failures = 0;
  let rejections = 0;
  const startTime = Date.now();

  for (let batchStart = 0; batchStart < reviews.length; batchStart += BATCH_SIZE) {
    const batch = reviews.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(reviews.length / BATCH_SIZE);
    console.log(`  Batch ${batchNum}/${totalBatches} (reviews ${batchStart + 1}-${batchStart + batch.length})...`);

    const batchPromises = batch.map(async (review, idx) => {
      const context = `Show: ${review.showId}\nOutlet: ${review.outlet}\nCritic: ${review.criticName}`;
      const kimiResult = await scoreWithKimi(review.fullText, context);
      return { review, kimiResult, globalIdx: batchStart + idx };
    });

    const batchResults = await Promise.all(batchPromises);

    for (const { review, kimiResult, globalIdx } of batchResults) {
      if (!kimiResult.success) {
        failures++;
        console.log(`    [${globalIdx + 1}] ${review.showId} / ${review.outlet}: FAILED (${kimiResult.error})`);
        results.push({ ...review, kimiScore: null, kimiBucket: null, rejected: false, error: kimiResult.error });
      } else if (kimiResult.rejected) {
        rejections++;
        console.log(`    [${globalIdx + 1}] ${review.showId} / ${review.outlet}: REJECTED (${kimiResult.rejection})`);
        results.push({ ...review, kimiScore: null, kimiBucket: null, rejected: true, rejectionReason: kimiResult.rejection });
      } else {
        successes++;
        const gtDiff = kimiResult.score - review.groundScore;
        const ensDiff = kimiResult.score - review.ensembleScore;
        console.log(`    [${globalIdx + 1}] ${review.showId} / ${review.outlet}: Kimi=${kimiResult.bucket}(${kimiResult.score}) GT:${review.groundScore} [${gtDiff > 0 ? '+' : ''}${gtDiff}] Ens:${review.ensembleScore}`);

        results.push({
          ...review,
          kimiScore: kimiResult.score,
          kimiBucket: kimiResult.bucket,
          kimiConfidence: kimiResult.confidence,
          kimiReasoning: kimiResult.reasoning,
          rejected: false,
          kimiVsGT: gtDiff,
          kimiVsEnsemble: ensDiff,
          ensVsGT: review.ensembleScore - review.groundScore
        });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const done = batchStart + batch.length;
    const rate = (done / (Date.now() - startTime) * 60000).toFixed(0);
    console.log(`  --- ${done}/${reviews.length} done (${successes}ok/${rejections}rej/${failures}err) ${elapsed}s, ~${rate} reviews/min ---\n`);

    // Small delay between batches to avoid overwhelming the API
    if (batchStart + BATCH_SIZE < reviews.length) await sleep(1000);
  }

  // ========================================
  // ANALYSIS
  // ========================================

  console.log('\n' + '='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80) + '\n');

  const scored = results.filter(r => r.kimiScore != null);
  console.log(`Scored: ${scored.length}, Rejected: ${rejections}, Errors: ${failures}\n`);

  if (scored.length === 0) {
    console.log('No successful scores. Check API key and try again.');
    process.exit(1);
  }

  // --- Overall: Kimi vs Ground Truth ---
  const kimiGtDiffs = scored.map(r => r.kimiVsGT);
  const kimiGtAbsDiffs = kimiGtDiffs.map(d => Math.abs(d));
  const kimiMAE = (kimiGtAbsDiffs.reduce((a, b) => a + b, 0) / kimiGtAbsDiffs.length).toFixed(1);
  const kimiBias = (kimiGtDiffs.reduce((a, b) => a + b, 0) / kimiGtDiffs.length).toFixed(1);
  const kimiBucketMatch = scored.filter(r => r.kimiBucket === r.groundBucket).length;

  // --- Overall: Ensemble vs Ground Truth ---
  const ensGtDiffs = scored.map(r => r.ensVsGT);
  const ensGtAbsDiffs = ensGtDiffs.map(d => Math.abs(d));
  const ensMAE = (ensGtAbsDiffs.reduce((a, b) => a + b, 0) / ensGtAbsDiffs.length).toFixed(1);
  const ensBias = (ensGtDiffs.reduce((a, b) => a + b, 0) / ensGtDiffs.length).toFixed(1);
  const ensBucketMatch = scored.filter(r => scoreToBucket(r.ensembleScore) === r.groundBucket).length;

  // --- Kimi vs Ensemble ---
  const kimiEnsDiffs = scored.map(r => r.kimiVsEnsemble);
  const kimiEnsAbsDiffs = kimiEnsDiffs.map(d => Math.abs(d));
  const kimiEnsMAE = (kimiEnsAbsDiffs.reduce((a, b) => a + b, 0) / kimiEnsAbsDiffs.length).toFixed(1);
  const kimiEnsBucketMatch = scored.filter(r => r.kimiBucket === scoreToBucket(r.ensembleScore)).length;

  console.log('--- Overall ---');
  console.log(`                  Kimi     Ensemble`);
  console.log(`  MAE vs GT:      ${kimiMAE.padEnd(8)} ${ensMAE}`);
  console.log(`  Bias vs GT:     ${(kimiBias > 0 ? '+' : '') + kimiBias.padEnd(8)} ${(ensBias > 0 ? '+' : '') + ensBias}`);
  console.log(`  Bucket Acc:     ${((kimiBucketMatch / scored.length) * 100).toFixed(1)}%    ${((ensBucketMatch / scored.length) * 100).toFixed(1)}%`);
  console.log(`  Kimi vs Ens MAE: ${kimiEnsMAE}`);
  console.log(`  Kimi-Ens Bucket: ${((kimiEnsBucketMatch / scored.length) * 100).toFixed(1)}%`);

  // --- Per-bucket breakdown ---
  console.log('\n--- By Bucket (Ground Truth) ---\n');
  for (const bucket of ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan']) {
    const inBucket = scored.filter(r => r.groundBucket === bucket);
    if (inBucket.length === 0) continue;

    const kimiMAEB = (inBucket.map(r => Math.abs(r.kimiVsGT)).reduce((a, b) => a + b, 0) / inBucket.length).toFixed(1);
    const ensMAEB = (inBucket.map(r => Math.abs(r.ensVsGT)).reduce((a, b) => a + b, 0) / inBucket.length).toFixed(1);
    const kimiBiasB = (inBucket.map(r => r.kimiVsGT).reduce((a, b) => a + b, 0) / inBucket.length).toFixed(1);
    const ensBiasB = (inBucket.map(r => r.ensVsGT).reduce((a, b) => a + b, 0) / inBucket.length).toFixed(1);
    const kimiBucketB = inBucket.filter(r => r.kimiBucket === r.groundBucket).length;
    const ensBucketB = inBucket.filter(r => scoreToBucket(r.ensembleScore) === r.groundBucket).length;

    console.log(`  ${bucket} (n=${inBucket.length}):`);
    console.log(`    MAE:     Kimi=${kimiMAEB}, Ensemble=${ensMAEB} (${parseFloat(kimiMAEB) < parseFloat(ensMAEB) ? 'Kimi better' : parseFloat(kimiMAEB) > parseFloat(ensMAEB) ? 'Ensemble better' : 'Tied'})`);
    console.log(`    Bias:    Kimi=${kimiBiasB > 0 ? '+' : ''}${kimiBiasB}, Ensemble=${ensBiasB > 0 ? '+' : ''}${ensBiasB}`);
    console.log(`    Bucket:  Kimi=${kimiBucketB}/${inBucket.length}, Ensemble=${ensBucketB}/${inBucket.length}`);
  }

  // --- Kimi vs each existing model ---
  console.log('\n--- Kimi vs Each Model (mean absolute diff) ---');
  const withClaude = scored.filter(r => r.claudeScore != null);
  const withOpenai = scored.filter(r => r.openaiScore != null);
  const withGemini = scored.filter(r => r.geminiScore != null);
  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'N/A';
  console.log(`  vs Claude (n=${withClaude.length}):  ${avg(withClaude.map(r => Math.abs(r.kimiScore - r.claudeScore)))} pts`);
  console.log(`  vs GPT-4o (n=${withOpenai.length}):  ${avg(withOpenai.map(r => Math.abs(r.kimiScore - r.openaiScore)))} pts`);
  console.log(`  vs Gemini (n=${withGemini.length}):  ${avg(withGemini.map(r => Math.abs(r.kimiScore - r.geminiScore)))} pts`);

  // --- Wins comparison ---
  console.log('\n--- Head-to-Head: Kimi vs Ensemble (vs Ground Truth) ---');
  const kimiWins = scored.filter(r => Math.abs(r.kimiVsGT) < Math.abs(r.ensVsGT)).length;
  const ensWins = scored.filter(r => Math.abs(r.ensVsGT) < Math.abs(r.kimiVsGT)).length;
  const ties = scored.filter(r => Math.abs(r.kimiVsGT) === Math.abs(r.ensVsGT)).length;
  console.log(`  Kimi closer to GT: ${kimiWins} (${((kimiWins / scored.length) * 100).toFixed(1)}%)`);
  console.log(`  Ensemble closer:   ${ensWins} (${((ensWins / scored.length) * 100).toFixed(1)}%)`);
  console.log(`  Tied:              ${ties} (${((ties / scored.length) * 100).toFixed(1)}%)`);

  // --- What if Kimi were added as 4th model? ---
  console.log('\n--- Hypothetical 4-Model Ensemble (Kimi as 4th) ---');
  const fourModelScored = scored.filter(r => r.claudeScore && r.openaiScore && r.geminiScore);
  if (fourModelScored.length > 0) {
    const fourModelMAE = fourModelScored.map(r => {
      const avg4 = Math.round((r.claudeScore + r.openaiScore + r.geminiScore + r.kimiScore) / 4);
      return Math.abs(avg4 - r.groundScore);
    });
    const fourMAE = (fourModelMAE.reduce((a, b) => a + b, 0) / fourModelMAE.length).toFixed(1);

    const threeModelMAE = fourModelScored.map(r => {
      const avg3 = Math.round((r.claudeScore + r.openaiScore + r.geminiScore) / 3);
      return Math.abs(avg3 - r.groundScore);
    });
    const threeMAE = (threeModelMAE.reduce((a, b) => a + b, 0) / threeModelMAE.length).toFixed(1);

    console.log(`  3-model ensemble MAE: ${threeMAE} (n=${fourModelScored.length})`);
    console.log(`  4-model ensemble MAE: ${fourMAE} (n=${fourModelScored.length})`);
    console.log(`  Delta: ${(parseFloat(fourMAE) - parseFloat(threeMAE)).toFixed(1)} (${parseFloat(fourMAE) < parseFloat(threeMAE) ? 'Kimi HELPS' : parseFloat(fourMAE) > parseFloat(threeMAE) ? 'Kimi HURTS' : 'No change'})`);

    // Per-bucket 4-model check
    for (const bucket of ['Rave', 'Positive', 'Mixed', 'Negative']) {
      const inB = fourModelScored.filter(r => r.groundBucket === bucket);
      if (inB.length < 3) continue;
      const mae3 = (inB.map(r => Math.abs(Math.round((r.claudeScore + r.openaiScore + r.geminiScore) / 3) - r.groundScore)).reduce((a, b) => a + b, 0) / inB.length).toFixed(1);
      const mae4 = (inB.map(r => Math.abs(Math.round((r.claudeScore + r.openaiScore + r.geminiScore + r.kimiScore) / 4) - r.groundScore)).reduce((a, b) => a + b, 0) / inB.length).toFixed(1);
      console.log(`    ${bucket} (n=${inB.length}): 3-model=${mae3}, 4-model=${mae4} (${(parseFloat(mae4) - parseFloat(mae3)).toFixed(1)})`);
    }
  }

  // --- Top outliers ---
  console.log('\n--- Top 10 Kimi Outliers (vs Ground Truth) ---');
  const sortedByDiff = [...scored].sort((a, b) => Math.abs(b.kimiVsGT) - Math.abs(a.kimiVsGT));
  for (const r of sortedByDiff.slice(0, 10)) {
    console.log(`  ${r.showId} / ${r.outlet}: Kimi=${r.kimiScore} GT=${r.groundScore} [${r.kimiVsGT > 0 ? '+' : ''}${r.kimiVsGT}] Ens=${r.ensembleScore} [${r.ensVsGT > 0 ? '+' : ''}${r.ensVsGT}] ${r.groundSource}`);
  }

  // --- Verdict ---
  console.log('\n' + '='.repeat(80));
  console.log('VERDICT');
  console.log('='.repeat(80));

  const kimiMAENum = parseFloat(kimiMAE);
  const ensMAENum = parseFloat(ensMAE);
  if (kimiMAENum < ensMAENum) {
    console.log(`Kimi K2.5 outperforms the 3-model ensemble (MAE ${kimiMAE} vs ${ensMAE}).`);
    console.log('Consider adding Kimi as a 4th model or replacing the weakest model.');
  } else if (kimiMAENum < ensMAENum + 2) {
    console.log(`Kimi K2.5 performs comparably to the ensemble (MAE ${kimiMAE} vs ${ensMAE}).`);
    console.log('May add value as a 4th model for diversity and stability.');
  } else {
    console.log(`Kimi K2.5 underperforms the ensemble (MAE ${kimiMAE} vs ${ensMAE}).`);
    console.log('Not recommended for inclusion without calibration.');
  }

  // Save results
  const outputPath = path.join(__dirname, '..', 'data', 'audit', 'kimi-500-results.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    runAt: new Date().toISOString(),
    model: KIMI_MODEL,
    promptVersion: PROMPT_VERSION,
    reviewsAttempted: reviews.length,
    reviewsScored: scored.length,
    rejections,
    failures,
    overall: {
      kimiMAE: parseFloat(kimiMAE),
      kimiBias: parseFloat(kimiBias),
      kimiBucketAccuracy: parseFloat(((kimiBucketMatch / scored.length) * 100).toFixed(1)),
      ensembleMAE: parseFloat(ensMAE),
      ensembleBias: parseFloat(ensBias),
      ensembleBucketAccuracy: parseFloat(((ensBucketMatch / scored.length) * 100).toFixed(1)),
      kimiVsEnsembleMAE: parseFloat(kimiEnsMAE),
      kimiWins, ensWins, ties
    },
    results: scored.map(r => ({
      showId: r.showId, outlet: r.outlet, critic: r.criticName,
      groundScore: r.groundScore, groundSource: r.groundSource, groundBucket: r.groundBucket,
      ensembleScore: r.ensembleScore, claudeScore: r.claudeScore, openaiScore: r.openaiScore, geminiScore: r.geminiScore,
      kimiScore: r.kimiScore, kimiBucket: r.kimiBucket, kimiConfidence: r.kimiConfidence,
      kimiVsGT: r.kimiVsGT, ensVsGT: r.ensVsGT, kimiVsEnsemble: r.kimiVsEnsemble
    }))
  }, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nResults saved to: ${outputPath}`);
  console.log(`Total time: ${elapsed} minutes`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
