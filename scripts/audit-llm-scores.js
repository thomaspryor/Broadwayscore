#!/usr/bin/env node
/**
 * LLM Score Audit — Cross-check LLM ensemble scores against review text.
 *
 * Two-pass audit:
 *   Pass 1: Free heuristic checks flag suspicious reviews (~30 seconds)
 *   Pass 2: Blind LLM re-scoring of flagged reviews (~$2.50 with GPT-4o)
 *
 * Usage:
 *   node scripts/audit-llm-scores.js [options]
 *
 * Options:
 *   --dry-run          Pass 1 only, show what would go to Pass 2
 *   --pass1-only       Heuristic checks only (no LLM calls)
 *   --limit=N          Cap Pass 2 reviews
 *   --concurrency=N    Parallel Gemini calls (default: 5)
 *   --threshold=N      Score delta to flag (default: 25)
 *   --max-cost=N       Budget cap in dollars (default: 0.50)
 *   --provider=NAME    claude (default) | gemini | openai
 *   --show=SLUG        Single show
 *   --verbose          Per-review details
 *
 * Env:
 *   ANTHROPIC_API_KEY  Required for claude provider (default)
 *   GEMINI_API_KEY     Required for gemini provider
 *   OPENAI_API_KEY     Required for openai provider
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { GEMINI_FLASH, GPT4O } = require('./lib/models');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PASS1_ONLY = args.includes('--pass1-only') || DRY_RUN;
const VERBOSE = args.includes('--verbose');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CONCURRENCY = parseInt((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 5;
const THRESHOLD = parseInt((args.find(a => a.startsWith('--threshold=')) || '').split('=')[1]) || 25;
const MAX_COST = parseFloat((args.find(a => a.startsWith('--max-cost=')) || '').split('=')[1]) || 5.00;
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const PROVIDER = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || 'claude';

// --- Paths ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const OUTPUT_FILE = path.join(AUDIT_DIR, 'llm-score-audit-REPORT-ONLY.json');

// --- Bucket definitions ---
const BUCKET_RANGES = {
  'Rave':     { min: 83, max: 100 },
  'Positive': { min: 70, max: 82 },
  'Mixed':    { min: 55, max: 69 },
  'Negative': { min: 35, max: 54 },
  'Pan':      { min: 0,  max: 34 }
};

function bucketForScore(score) {
  if (score >= 83) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

// --- Stats ---
const stats = {
  totalFiles: 0,
  withLlmScore: 0,
  pass1: {
    thumbMismatch: 0,
    ensembleDisagreement: 0,
    bothThumbsContradict: 0,
    explicitVsLlm: 0,
    contentTierConfidence: 0,
    totalFlagged: 0,
    advancingToPass2: 0
  },
  pass2: {
    calibrationRun: false,
    calibrationMAE: null,
    calibrationPassed: false,
    totalAudited: 0,
    flagged: 0,
    budgetUsed: 0,
    geminiCalls: 0,
    rateLimitHits: 0,
    errors: 0
  }
};

// Cost per call by provider (approximate, per call with ~2K input tokens)
const COST_BY_PROVIDER = {
  claude: 0.006,    // Sonnet 4.5: $3/1M input
  gemini: 0.0001,   // Flash 2.0: $0.10/1M input
  openai: 0.005     // GPT-4o: $2.50/1M input
};
const COST_PER_CALL = COST_BY_PROVIDER[PROVIDER] || 0.006;

// ============================================================
// LLM Providers
// ============================================================

function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 300,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.content?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Claude parse error: ${e.message}`));
          }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`Claude HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
    ],
    generationConfig: { temperature: 0.1, maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } }
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Gemini parse error: ${e.message}`));
          }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = JSON.stringify({
    model: GPT4O,
    temperature: 0.1,
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error(`OpenAI parse error: ${e.message}`));
          }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
        } else {
          reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callLLM(systemPrompt, userPrompt) {
  if (PROVIDER === 'claude') return callClaude(systemPrompt, userPrompt);
  if (PROVIDER === 'openai') return callOpenAI(systemPrompt, userPrompt);
  return callGemini(systemPrompt, userPrompt);
}

async function callLLMWithRetry(systemPrompt, userPrompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt);
    } catch (e) {
      if (e.message === 'RATE_LIMIT') {
        stats.pass2.rateLimitHits++;
        const delay = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s
        if (VERBOSE) console.log(`  Rate limited, waiting ${delay / 1000}s...`);
        await sleep(delay);
      } else if (attempt < maxRetries - 1) {
        await sleep(2000);
      } else {
        throw e;
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Pass 1: Heuristic Checks
// ============================================================

function runPass1Checks(data, filePath, liveScore) {
  const flags = [];

  const llmScore = data.llmScore;
  const ensemble = data.ensembleData;
  // Use live score from reviews.json (not stale file value)
  const assignedScore = liveScore ? liveScore.assignedScore : data.assignedScore;
  const scoreSource = liveScore ? liveScore.scoreSource : data.scoreSource;

  // Only audit LLM-scored reviews
  if (!llmScore || typeof llmScore.score !== 'number') return null;

  // Skip reviews already using ground-truth scores (explicit ratings, human review)
  if (scoreSource && /^(originalScore|explicit|human)/.test(scoreSource)) return null;

  // Check 1: Score vs thumb mismatch
  const thumb = data.dtliThumb || data.bwwThumb;
  if (thumb) {
    const score = assignedScore || llmScore.score;
    if (score > 65 && thumb === 'Down') {
      flags.push({ check: 'thumbMismatch', detail: `Score ${score} but thumb ${thumb}` });
      stats.pass1.thumbMismatch++;
    }
    if (score < 50 && thumb === 'Up') {
      flags.push({ check: 'thumbMismatch', detail: `Score ${score} but thumb ${thumb}` });
      stats.pass1.thumbMismatch++;
    }
  }

  // Check 2: Ensemble model disagreement
  if (ensemble) {
    const modelScores = [
      ensemble.claudeScore, ensemble.openaiScore,
      ensemble.geminiScore, ensemble.kimiScore
    ].filter(s => typeof s === 'number');

    if (modelScores.length >= 2) {
      const delta = Math.max(...modelScores) - Math.min(...modelScores);
      if (delta > 20) {
        flags.push({ check: 'ensembleDisagreement', detail: `Model delta ${delta} (scores: ${modelScores.join(', ')})` });
        stats.pass1.ensembleDisagreement++;
      }

      // Check bucket span
      const modelBuckets = [
        ensemble.claudeBucket, ensemble.openaiBucket,
        ensemble.geminiBucket, ensemble.kimiBucket
      ].filter(Boolean);
      const uniqueBuckets = [...new Set(modelBuckets)];
      if (uniqueBuckets.length >= 3) {
        flags.push({ check: 'ensembleDisagreement', detail: `${uniqueBuckets.length} different buckets: ${uniqueBuckets.join(', ')}` });
        stats.pass1.ensembleDisagreement++;
      }
    }
  }

  // Check 3: Both thumbs agree but contradict LLM
  const dtli = data.dtliThumb;
  const bww = data.bwwThumb;
  if (dtli && bww && dtli === bww) {
    const llmBucket = llmScore.bucket || bucketForScore(llmScore.score);
    const thumbsPositive = dtli === 'Up';
    const llmPositive = ['Rave', 'Positive'].includes(llmBucket);
    const thumbsNegative = dtli === 'Down';
    const llmNegative = ['Negative', 'Pan'].includes(llmBucket);

    if ((thumbsPositive && llmNegative) || (thumbsNegative && llmPositive)) {
      flags.push({
        check: 'bothThumbsContradict',
        detail: `Both thumbs=${dtli} but LLM bucket=${llmBucket} (score ${llmScore.score})`
      });
      stats.pass1.bothThumbsContradict++;
    }
  }

  // Check 4: Explicit rating vs LLM mismatch (ground truth)
  if (typeof data.originalScore === 'number' && typeof llmScore.score === 'number') {
    const delta = Math.abs(data.originalScore - llmScore.score);
    if (delta > 20) {
      flags.push({
        check: 'explicitVsLlm',
        detail: `originalScore=${data.originalScore} vs llmScore=${llmScore.score} (delta ${delta})`
      });
      stats.pass1.explicitVsLlm++;
    }
  }

  // Check 5: Content tier vs confidence mismatch
  const tier = data.contentTier;
  const conf = llmScore.confidence;
  if ((tier === 'excerpt' || tier === 'stub') && conf === 'high') {
    flags.push({
      check: 'contentTierConfidence',
      detail: `contentTier=${tier} but confidence=${conf}`
    });
    stats.pass1.contentTierConfidence++;
  }

  if (flags.length === 0) return null;

  stats.pass1.totalFlagged++;

  // Determine if this advances to Pass 2
  const fullText = data.fullText || data.cleanText || '';
  const advancesToPass2 = fullText.length > 200;
  if (advancesToPass2) stats.pass1.advancingToPass2++;

  return {
    file: filePath,
    showId: data.showId,
    outlet: data.outlet || data.outletId,
    critic: data.criticName,
    assignedScore: assignedScore,
    llmScore: llmScore.score,
    llmBucket: llmScore.bucket || bucketForScore(llmScore.score),
    llmConfidence: llmScore.confidence,
    scoreSource: scoreSource,
    originalScore: data.originalScore || null,
    pass1Flags: flags,
    advancesToPass2,
    fullTextLength: fullText.length,
    pass2: null,
    priority: null
  };
}

// ============================================================
// Pass 2: Blind LLM Re-Scoring
// ============================================================

const AUDIT_SYSTEM_PROMPT = `You are a Broadway theater critic score calibrator. Read the review text and independently assess the critic's overall sentiment toward the show on a 0-100 scale.

Scoring guide:
- 83-100 (Rave): Enthusiastic praise, strong recommendation, "don't miss this"
- 70-82 (Positive): Generally favorable, some reservations but overall positive
- 55-69 (Mixed): Balanced pros and cons, lukewarm, "has its moments"
- 35-54 (Negative): More criticism than praise, disappointed tone
- 0-34 (Pan): Harsh criticism, "avoid this", fundamental problems

Focus on the OVERALL sentiment, not individual elements. A review praising performances but criticizing the book is Mixed or Positive depending on balance.

Return ONLY a JSON object (no markdown, no explanation):
{"score": <0-100>, "bucket": "<Rave|Positive|Mixed|Negative|Pan>", "reasoning": "<1-2 sentences>"}`;

function buildAuditPrompt(fullText) {
  // Truncate to keep costs down — send first 2000 + last 1000 chars
  let text = fullText;
  if (fullText.length > 4000) {
    text = fullText.substring(0, 2500) + '\n\n[...middle truncated...]\n\n' + fullText.substring(fullText.length - 1500);
  }
  return `Review text:\n${text}`;
}

function parseAuditResponse(raw) {
  // Strip markdown code fences if present
  let text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const obj = JSON.parse(text);
    if (typeof obj.score === 'number' && obj.bucket && obj.reasoning) {
      return {
        auditScore: Math.max(0, Math.min(100, Math.round(obj.score))),
        auditBucket: obj.bucket,
        reasoning: obj.reasoning.substring(0, 300)
      };
    }
  } catch (e) {
    // Try to extract score from malformed response
    const scoreMatch = text.match(/"score"\s*:\s*(\d+)/);
    const bucketMatch = text.match(/"bucket"\s*:\s*"(\w+)"/);
    if (scoreMatch) {
      const score = Math.max(0, Math.min(100, parseInt(scoreMatch[1])));
      return {
        auditScore: score,
        auditBucket: bucketMatch ? bucketMatch[1] : bucketForScore(score),
        reasoning: '(parsed from malformed response)'
      };
    }
  }
  return null;
}

async function auditOneReview(entry, fullText) {
  const prompt = buildAuditPrompt(fullText);
  const raw = await callLLMWithRetry(AUDIT_SYSTEM_PROMPT, prompt);
  stats.pass2.geminiCalls++;
  stats.pass2.budgetUsed += COST_PER_CALL;

  const result = parseAuditResponse(raw);
  if (!result) {
    stats.pass2.errors++;
    return null;
  }

  const existingScore = entry.assignedScore || entry.llmScore;
  const delta = Math.abs(result.auditScore - existingScore);
  const existingBucket = entry.llmBucket || bucketForScore(existingScore);
  const bucketMismatch = result.auditBucket !== existingBucket;
  const flagged = delta > THRESHOLD || bucketMismatch;

  if (flagged) stats.pass2.flagged++;

  return {
    auditScore: result.auditScore,
    auditBucket: result.auditBucket,
    delta,
    bucketMismatch,
    flagged,
    reasoning: result.reasoning
  };
}

// ============================================================
// Calibration Gate
// ============================================================

async function runCalibrationGate(allEntries) {
  // Find reviews with originalScore AND scoreSource starting with "originalScore" or "explicit"
  // These have known ground-truth scores
  // NOTE: Always searches ALL shows (ignores SHOW_FILTER) to get enough calibration data
  const groundTruth = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const dir of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, dir.name))
      .filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, dir.name, file), 'utf8'));
        if (typeof data.originalScore === 'number' &&
            data.fullText && data.fullText.length > 200) {
          groundTruth.push({
            file: `${dir.name}/${file}`,
            originalScore: data.originalScore,
            fullText: data.fullText
          });
        }
      } catch (e) { /* skip */ }
    }
  }

  console.log(`\nCalibration: found ${groundTruth.length} ground-truth reviews (explicit ratings with fullText)`);
  if (groundTruth.length < 20) {
    console.log('WARNING: Not enough ground-truth reviews for calibration (need 20+). Proceeding anyway.');
    stats.pass2.calibrationRun = true;
    stats.pass2.calibrationMAE = null;
    stats.pass2.calibrationPassed = true;
    return true;
  }

  // Pick 50 random (or all if fewer)
  const sample = groundTruth
    .sort(() => Math.random() - 0.5)
    .slice(0, 50);

  console.log(`Calibrating on ${sample.length} reviews...`);

  let totalDelta = 0;
  let completed = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < sample.length; i += CONCURRENCY) {
    const batch = sample.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const prompt = buildAuditPrompt(entry.fullText);
        const raw = await callLLMWithRetry(AUDIT_SYSTEM_PROMPT, prompt);
        stats.pass2.geminiCalls++;
        stats.pass2.budgetUsed += COST_PER_CALL;
        const parsed = parseAuditResponse(raw);
        if (parsed) {
          const delta = Math.abs(parsed.auditScore - entry.originalScore);
          if (VERBOSE) {
            console.log(`  Calibration: ${entry.file} — original=${entry.originalScore}, audit=${parsed.auditScore}, delta=${delta}`);
          }
          return delta;
        }
        return null;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        totalDelta += r.value;
        completed++;
      }
    }
  }

  const mae = completed > 0 ? totalDelta / completed : Infinity;
  stats.pass2.calibrationRun = true;
  stats.pass2.calibrationMAE = Math.round(mae * 10) / 10;
  stats.pass2.calibrationPassed = mae <= 15;

  console.log(`Calibration MAE: ${mae.toFixed(1)} (threshold: 15.0) — ${stats.pass2.calibrationPassed ? 'PASSED' : 'FAILED'}`);
  console.log(`  Completed: ${completed}/${sample.length}, Budget so far: $${stats.pass2.budgetUsed.toFixed(4)}`);

  return stats.pass2.calibrationPassed;
}

// ============================================================
// Checkpoint
// ============================================================

function writeCheckpoint(report) {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2) + '\n');
}

function loadCheckpoint() {
  try {
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    if (data.flaggedReviews) {
      const audited = new Set();
      for (const r of data.flaggedReviews) {
        if (r.pass2) audited.add(r.file);
      }
      return audited;
    }
  } catch (e) { /* no checkpoint */ }
  return new Set();
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('=== LLM Score Audit ===');
  console.log(`Options: provider=${PROVIDER}, threshold=${THRESHOLD}, concurrency=${CONCURRENCY}, max-cost=$${MAX_COST}`);
  if (SHOW_FILTER) console.log(`Filtering to show: ${SHOW_FILTER}`);
  if (PASS1_ONLY) console.log('Mode: Pass 1 only (no LLM calls)');
  console.log();

  // --- Load reviews.json for live scores ---
  // review-text files have stale assignedScore — reviews.json has the real scores
  const liveScores = {};
  try {
    const revData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8'));
    const revList = revData.reviews || revData;
    const arr = Array.isArray(revList) ? revList : Object.values(revList);
    for (const r of arr) {
      if (r.showId && r.outletId) {
        // Key by showId/outletId--critic to match file paths
        const critic = (r.critic || 'unknown').toLowerCase().replace(/\s+/g, '-');
        const key = `${r.showId}/${r.outletId}--${critic}.json`;
        liveScores[key] = {
          assignedScore: r.assignedScore,
          scoreSource: r.scoreSource
        };
      }
    }
    console.log(`Loaded ${Object.keys(liveScores).length} live scores from reviews.json`);
  } catch (e) {
    console.log('WARNING: Could not load reviews.json — using stale file scores');
  }

  // --- Pass 1: Heuristic checks ---
  console.log('--- Pass 1: Heuristic Checks ---');

  const flaggedReviews = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .filter(d => !SHOW_FILTER || d === SHOW_FILTER);

  // Map to read fullText for Pass 2 candidates
  const fullTextMap = {};

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    } catch (e) { continue; }

    for (const file of files) {
      stats.totalFiles++;
      const filePath = path.join(dirPath, file);
      const relPath = `${showDir}/${file}`;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) { continue; }

      // Skip excluded reviews
      if (data.wrongProduction || data.wrongShow || data.isRoundupArticle) continue;

      if (data.llmScore && typeof data.llmScore.score === 'number') {
        stats.withLlmScore++;
      }

      const entry = runPass1Checks(data, relPath, liveScores[relPath]);
      if (entry) {
        flaggedReviews.push(entry);
        if (entry.advancesToPass2) {
          fullTextMap[relPath] = data.fullText || data.cleanText || '';
        }
        if (VERBOSE) {
          console.log(`  FLAG: ${relPath} — ${entry.pass1Flags.map(f => f.check).join(', ')}`);
        }
      }
    }
  }

  // Pass 1 summary
  console.log(`\nPass 1 Summary:`);
  console.log(`  Total files scanned: ${stats.totalFiles}`);
  console.log(`  With LLM scores: ${stats.withLlmScore}`);
  console.log(`  Flagged reviews: ${stats.pass1.totalFlagged}`);
  console.log(`    thumbMismatch: ${stats.pass1.thumbMismatch}`);
  console.log(`    ensembleDisagreement: ${stats.pass1.ensembleDisagreement}`);
  console.log(`    bothThumbsContradict: ${stats.pass1.bothThumbsContradict}`);
  console.log(`    explicitVsLlm: ${stats.pass1.explicitVsLlm}`);
  console.log(`    contentTierConfidence: ${stats.pass1.contentTierConfidence}`);
  console.log(`  Advancing to Pass 2: ${stats.pass1.advancingToPass2}`);

  if (PASS1_ONLY) {
    // Write Pass 1 report and exit
    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        mode: DRY_RUN ? 'dry-run' : 'pass1-only',
        threshold: THRESHOLD,
        pass1Stats: stats.pass1,
        pass2Stats: null
      },
      flaggedReviews: flaggedReviews.map(e => ({
        ...e,
        priority: determinePriority(e)
      }))
    };
    writeCheckpoint(report);
    console.log(`\nReport written to ${OUTPUT_FILE}`);

    // Show top 20 by severity
    const sorted = flaggedReviews
      .sort((a, b) => {
        const pa = priorityRank(determinePriority(a));
        const pb = priorityRank(determinePriority(b));
        return pa - pb || b.pass1Flags.length - a.pass1Flags.length;
      });
    console.log(`\nTop 20 flagged reviews:`);
    for (const e of sorted.slice(0, 20)) {
      const p = determinePriority(e);
      console.log(`  [${p}] ${e.file} — score=${e.assignedScore || e.llmScore}, flags: ${e.pass1Flags.map(f => f.detail).join('; ')}`);
    }
    return;
  }

  // --- Pass 2: Blind LLM Re-Scoring ---
  console.log('\n--- Pass 2: Blind LLM Re-Scoring ---');

  // Check API key for chosen provider
  const keyMap = { claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };
  const requiredKey = keyMap[PROVIDER] || 'ANTHROPIC_API_KEY';
  if (!process.env[requiredKey]) {
    console.error(`ERROR: ${requiredKey} not set. Cannot run Pass 2 with provider=${PROVIDER}.`);
    process.exit(1);
  }

  // Get reviews advancing to Pass 2
  let pass2Candidates = flaggedReviews.filter(e => e.advancesToPass2);
  if (LIMIT && pass2Candidates.length > LIMIT) {
    pass2Candidates = pass2Candidates.slice(0, LIMIT);
    console.log(`Limited to ${LIMIT} reviews`);
  }

  const maxCallsBudget = Math.floor(MAX_COST / COST_PER_CALL);
  // Calibration uses ~50 calls, subtract that
  const calibrationBudget = 55;
  const mainBudget = maxCallsBudget - calibrationBudget;

  console.log(`Budget: $${MAX_COST} → ~${maxCallsBudget} calls (${calibrationBudget} calibration + ${mainBudget} main)`);

  if (pass2Candidates.length > mainBudget) {
    console.log(`WARNING: ${pass2Candidates.length} candidates but only ${mainBudget} budget. Will process first ${mainBudget}.`);
    pass2Candidates = pass2Candidates.slice(0, mainBudget);
  }

  // Calibration gate
  console.log('\nRunning calibration gate...');
  const calPassed = await runCalibrationGate(flaggedReviews);
  if (!calPassed) {
    console.error('\nABORT: Calibration failed (MAE > 15). The audit prompt needs tuning.');
    console.error('The Pass 1 report has been saved. Fix the prompt and re-run.');
    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        mode: 'calibration-failed',
        threshold: THRESHOLD,
        pass1Stats: stats.pass1,
        pass2Stats: stats.pass2
      },
      flaggedReviews: flaggedReviews.map(e => ({
        ...e,
        priority: determinePriority(e)
      }))
    };
    writeCheckpoint(report);
    process.exit(1);
  }

  // Check for existing checkpoint (resume support)
  const alreadyAudited = loadCheckpoint();
  if (alreadyAudited.size > 0) {
    console.log(`Resuming: ${alreadyAudited.size} reviews already audited`);
  }

  // Main Pass 2 loop
  console.log(`\nAuditing ${pass2Candidates.length} reviews...`);
  let audited = 0;
  const CHUNK_SIZE = 1000;

  for (let chunkStart = 0; chunkStart < pass2Candidates.length; chunkStart += CHUNK_SIZE) {
    if (chunkStart > 0) {
      console.log('Pausing 60s between chunks...');
      await sleep(60000);
    }

    const chunk = pass2Candidates.slice(chunkStart, chunkStart + CHUNK_SIZE);

    // Process in batches of CONCURRENCY
    for (let i = 0; i < chunk.length; i += CONCURRENCY) {
      const batch = chunk.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          if (alreadyAudited.has(entry.file)) return { entry, result: 'skipped' };

          // Budget check
          if (stats.pass2.budgetUsed >= MAX_COST) return { entry, result: 'budget-exceeded' };

          const fullText = fullTextMap[entry.file];
          if (!fullText || fullText.length < 200) return { entry, result: 'no-text' };

          try {
            const auditResult = await auditOneReview(entry, fullText);
            stats.pass2.totalAudited++;
            return { entry, result: auditResult };
          } catch (e) {
            stats.pass2.errors++;
            if (VERBOSE) console.log(`  ERROR: ${entry.file} — ${e.message}`);
            return { entry, result: null };
          }
        })
      );

      // Apply results
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const { entry, result } = r.value;
          if (result && result !== 'skipped' && result !== 'budget-exceeded' && result !== 'no-text') {
            entry.pass2 = result;
            entry.priority = determinePriority(entry);
            if (VERBOSE && result.flagged) {
              console.log(`  AUDIT FLAG: ${entry.file} — assigned=${entry.assignedScore || entry.llmScore}, audit=${result.auditScore}, delta=${result.delta}, ${result.reasoning}`);
            }
          }
          if (result === 'budget-exceeded') {
            console.log(`\nBudget exhausted ($${stats.pass2.budgetUsed.toFixed(4)} / $${MAX_COST})`);
          }
        }
      }

      audited += batch.length;

      // Checkpoint every 100 reviews
      if (audited % 100 < CONCURRENCY) {
        const report = buildReport(flaggedReviews);
        writeCheckpoint(report);
        if (VERBOSE) console.log(`  Checkpoint: ${stats.pass2.totalAudited} audited, ${stats.pass2.flagged} flagged`);
      }

      // Stop if budget exhausted
      if (stats.pass2.budgetUsed >= MAX_COST) {
        console.log('Budget exhausted. Stopping Pass 2.');
        break;
      }
    }

    if (stats.pass2.budgetUsed >= MAX_COST) break;
  }

  // Final report
  const report = buildReport(flaggedReviews);
  writeCheckpoint(report);

  // Summary
  console.log(`\nPass 2 Summary:`);
  console.log(`  Reviews audited: ${stats.pass2.totalAudited}`);
  console.log(`  Flagged (delta>${THRESHOLD} or bucket mismatch): ${stats.pass2.flagged}`);
  console.log(`  Gemini calls: ${stats.pass2.geminiCalls}`);
  console.log(`  Rate limit hits: ${stats.pass2.rateLimitHits}`);
  console.log(`  Errors: ${stats.pass2.errors}`);
  console.log(`  Budget used: $${stats.pass2.budgetUsed.toFixed(4)}`);
  console.log(`  Calibration MAE: ${stats.pass2.calibrationMAE}`);

  // Show top flagged
  const pass2Flagged = flaggedReviews
    .filter(e => e.pass2 && e.pass2.flagged)
    .sort((a, b) => (b.pass2?.delta || 0) - (a.pass2?.delta || 0));

  if (pass2Flagged.length > 0) {
    console.log(`\nTop Pass 2 flags (by delta):`);
    for (const e of pass2Flagged.slice(0, 30)) {
      console.log(`  [${e.priority}] ${e.file} — assigned=${e.assignedScore || e.llmScore}, audit=${e.pass2.auditScore}, delta=${e.pass2.delta}, bucket: ${e.llmBucket}→${e.pass2.auditBucket}`);
      if (e.pass2.reasoning) console.log(`    ${e.pass2.reasoning}`);
    }
  }

  console.log(`\nReport written to ${OUTPUT_FILE}`);
}

// ============================================================
// Priority & Report
// ============================================================

function determinePriority(entry) {
  const flags = entry.pass1Flags || [];
  const hasGroundTruthConflict = flags.some(f => f.check === 'explicitVsLlm');
  const hasBothThumbs = flags.some(f => f.check === 'bothThumbsContradict');
  const pass2Delta = entry.pass2?.delta || 0;
  const pass2BucketMismatch = entry.pass2?.bucketMismatch || false;

  // Critical: ground truth conflict + pass2 confirms, or pass2 delta > 40
  if (hasGroundTruthConflict && entry.pass2?.flagged) return 'critical';
  if (pass2Delta > 40) return 'critical';

  // Warning: pass2 flagged, or both thumbs contradict
  if (entry.pass2?.flagged) return 'warning';
  if (hasBothThumbs) return 'warning';
  if (hasGroundTruthConflict) return 'warning';

  return 'info';
}

function priorityRank(p) {
  if (p === 'critical') return 0;
  if (p === 'warning') return 1;
  return 2;
}

function buildReport(flaggedReviews) {
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: PASS1_ONLY ? (DRY_RUN ? 'dry-run' : 'pass1-only') : 'full',
      threshold: THRESHOLD,
      maxCost: MAX_COST,
      showFilter: SHOW_FILTER || null,
      pass1Stats: stats.pass1,
      pass2Stats: PASS1_ONLY ? null : stats.pass2
    },
    flaggedReviews: flaggedReviews.map(e => ({
      file: e.file,
      showId: e.showId,
      outlet: e.outlet,
      critic: e.critic,
      assignedScore: e.assignedScore,
      llmScore: e.llmScore,
      llmBucket: e.llmBucket,
      llmConfidence: e.llmConfidence,
      scoreSource: e.scoreSource,
      originalScore: e.originalScore,
      pass1Flags: e.pass1Flags.map(f => f.check),
      pass1Details: e.pass1Flags.map(f => f.detail),
      pass2: e.pass2,
      priority: e.priority || determinePriority(e)
    }))
  };
}

// ============================================================
// Run
// ============================================================
main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
