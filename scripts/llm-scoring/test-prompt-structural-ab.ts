#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * A/B Harness — SYSTEM_PROMPT_V5 vs SYSTEM_PROMPT_V5_STRUCTURAL
 *
 * Implements the CLAUDE.md rule 13 prompt-change contract.
 *
 * Selection: a stratified sample of N reviews (default 150) drawn from the last
 * `--days` of publish dates (default 180), with at least one review per scoring
 * bucket so the matrix isn't dominated by Positive/Mixed.
 *
 * For each review: scores it via the 3-model ensemble TWICE — once with the
 * current live prompt (PROMPT_VERSION) and once with the candidate
 * structural-review prompt (PROMPT_VERSION_CANDIDATE). Calls run in parallel.
 *
 * Pass criteria (rule 13):
 *   - max bucket-share shift < 5 percentage points
 *   - |mean signed drift| < 5 points
 *
 * Output: data/audit/llm-prompt-ab-${date}.json
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/llm-scoring/test-prompt-structural-ab.ts
 *   npx ts-node ... -- --n=50 --days=90 --verbose
 *   npx ts-node ... -- --quick   # dry-run on 6 fixed cases (Helen Shaw + 5 sanity)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReviewScorer } from './scorer';
import { OpenAIReviewScorer } from './openai-scorer';
import { GeminiScorer } from './gemini-scorer';
import { ensembleScore, toModelScore } from './ensemble';
import { buildScoringInput, ReviewInputData } from './input-builder';
import {
  SYSTEM_PROMPT_V5,
  SYSTEM_PROMPT_V5_STRUCTURAL,
  PROMPT_VERSION,
  PROMPT_VERSION_CANDIDATE,
  BUCKET_RANGES,
} from './config';
import { Bucket, ModelScore, EnsembleResult, SimplifiedLLMResult } from './types';

// Load .env so API keys are available in raw `node`/`ts-node` runs
try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
} catch {
  // dotenv optional — env may already be set in CI
}

const { EXCERPT_FIELDS } = require('../lib/excerpt-fields');

// ========================================
// CLI ARGS
// ========================================

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const arg = (name: string, def: string) => {
  const a = args.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : def;
};

const N = parseInt(arg('n', '150'));
const DAYS = parseInt(arg('days', '180'));
const VERBOSE = flag('verbose');
const QUICK = flag('quick');
const NO_WRITE = flag('no-write');

// Pass thresholds (rule 13)
const BUCKET_SHIFT_THRESHOLD = 5;  // percentage points
const MEAN_DRIFT_THRESHOLD = 5;    // score points

// ========================================
// SAMPLE SELECTION
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '../../data/review-texts');
const HELEN_SHAW_FIXTURE_PATH = path.join(__dirname, '../../tests/fixtures/llm-prompt/helen-shaw-nyt-lost-boys-2026.json');
const HELEN_SHAW_KEY = '__fixture__:helen-shaw-nyt-lost-boys-2026';

interface SampleReview {
  showId: string;
  outletId: string;
  filePath: string;
  text: string;
  context: string;
  oldScore: number;
  oldBucket: Bucket;
  publishDate: string | null;
}

interface RawReviewFile {
  showId?: string;
  outletId?: string;
  outlet?: string;
  criticName?: string;
  publishDate?: string | null;
  textFetchedAt?: string | null;
  fullText?: string | null;
  showTitle?: string;
  category?: string;
  venue?: string | null;
  bwwExcerpt?: string | null;
  dtliExcerpt?: string | null;
  showScoreExcerpt?: string | null;
  bwwThumb?: string | null;
  dtliThumb?: string | null;
  bwwScore?: number | null;
  originalScore?: number | string | null;
  originalRating?: string | null;
  llmScore?: { score?: number; bucket?: string };
  llmMetadata?: { promptVersion?: string };
  contentTier?: string;
  manualContentTier?: string;
  wrongShow?: boolean;
  wrongProduction?: boolean;
  isRoundupArticle?: boolean;
  fabricatedEntry?: boolean;
  duplicateOf?: string;
  scoreStatus?: string;
  // Allow dynamic excerpt-field reads
  [key: string]: any;
}

/**
 * Load shows.json once for show-title + category + venue lookups.
 */
function loadShowsIndex(): Map<string, { title: string; category: string; venue: string | null }> {
  const map = new Map<string, { title: string; category: string; venue: string | null }>();
  try {
    const showsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf-8'));
    for (const show of (showsRaw.shows || showsRaw)) {
      if (show.id) {
        map.set(show.id, {
          title: show.title || show.id,
          category: show.category || 'broadway',
          venue: show.venue || null,
        });
      }
    }
  } catch {
    // Fall through — input-builder will use defaults
  }
  return map;
}

/**
 * Load all eligible reviews and stratified-sample N of them.
 *
 * Eligibility:
 *   - has llmScore.score (so we have an "old" score to diff against)
 *   - has fullText >= 800 chars (excerpts confound prompt comparison)
 *   - publishDate within --days
 *   - not flagged wrongShow/wrongProduction/fabricated/duplicate/roundup
 *   - contentTier in {complete, truncated} (excludes invalid/excerpt/stub)
 *
 * Stratification: targets equal counts per bucket (Rave/Positive/Mixed/
 * Negative/Pan) up to N/5 each, then fills remaining slots with the bucket
 * distribution found on disk.
 */
function selectSample(targetN: number, daysWindow: number): SampleReview[] {
  const showsIndex = loadShowsIndex();
  const cutoff = new Date(Date.now() - daysWindow * 86400_000);

  const eligible: SampleReview[] = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
    if (f.startsWith('_') || f.startsWith('.')) return false;
    return fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory();
  });

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      let data: RawReviewFile;
      try {
        data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf-8'));
      } catch {
        continue;
      }

      // Filter
      if (!data.llmScore?.score) continue;
      if (data.wrongShow || data.wrongProduction || data.fabricatedEntry) continue;
      if (data.isRoundupArticle || data.duplicateOf) continue;
      const tier = data.manualContentTier || data.contentTier;
      if (tier && !['complete', 'truncated'].includes(tier)) continue;
      if (!data.fullText || data.fullText.length < 800) continue;
      if (data.scoreStatus === 'GARBAGE_TEXT') continue;

      // Ship-check P1 fix (Claude reviewer 2026-04-27): exclude reviews where
      // llmScore was overridden by a manual lock — protectedFields includes
      // 'llmScore' and the on-disk score doesn't reflect ensemble output.
      // Helen Shaw is the canonical example (ensemble said 68 Mixed, manual
      // override locked 78 Positive) — that score in the baseline pool would
      // bias the "old prompt drift" measurement.
      const protectedFields: string[] = (data as any).protectedFields || [];
      if (protectedFields.includes('llmScore') || protectedFields.includes('humanReviewScore')) continue;

      // Ship-check P1 fix: only include reviews scored under the live prompt
      // version. Mixing v5.0/5.1/5.2 baseline scores with a v5.3 vs v5.4-cand
      // comparison conflates prompt-version drift with the structural-prompt
      // change we're actually testing.
      const storedVersion = (data as any).llmMetadata?.promptVersion;
      if (storedVersion && storedVersion !== PROMPT_VERSION) continue;

      const publishDate = data.publishDate || data.textFetchedAt || null;
      if (!publishDate) continue;
      const d = new Date(publishDate);
      if (isNaN(d.getTime()) || d < cutoff) continue;

      // Build context using the same input-builder the production scorer uses,
      // so the A/B mirrors live behavior — including market label, original
      // rating, truncation warnings, etc.
      const showInfo = showsIndex.get(data.showId || showDir);
      const excerptData: Record<string, string | null> = {};
      for (const ef of EXCERPT_FIELDS) {
        excerptData[ef] = (data as any)[ef] ?? null;
      }
      const reviewData: ReviewInputData = {
        showId: data.showId || showDir,
        showTitle: data.showTitle || showInfo?.title,
        outletId: data.outletId,
        outlet: data.outlet,
        criticName: data.criticName,
        publishDate: publishDate,
        category: data.category || showInfo?.category,
        venue: data.venue || showInfo?.venue || undefined,
        fullText: data.fullText,
        ...excerptData,
        bwwThumb: data.bwwThumb,
        dtliThumb: data.dtliThumb,
        bwwScore: data.bwwScore ?? null,
        originalScore: data.originalScore != null ? String(data.originalScore) : null,
        originalRating: data.originalRating,
      };

      const built = buildScoringInput(reviewData);
      if (!built.text || built.text.length < 200) continue;

      eligible.push({
        showId: data.showId || showDir,
        outletId: data.outletId || file.split('--')[0],
        filePath: path.join(dirPath, file),
        text: built.text,
        context: built.context,
        oldScore: data.llmScore.score!,
        oldBucket: scoreBucket(data.llmScore.score!),
        publishDate: publishDate,
      });
    }
  }

  // Stratify: bucket the eligible pool, take up to N/5 from each bucket,
  // then fill remaining slots from the largest leftover pool.
  const buckets: Bucket[] = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
  const perBucket = Math.floor(targetN / buckets.length);
  const byBucket: Record<Bucket, SampleReview[]> = {
    Rave: [], Positive: [], Mixed: [], Negative: [], Pan: []
  };
  for (const r of eligible) byBucket[r.oldBucket].push(r);

  // Shuffle each bucket
  const rng = mulberry32(42);
  for (const b of buckets) {
    byBucket[b].sort(() => rng() - 0.5);
  }

  const sample: SampleReview[] = [];
  for (const b of buckets) {
    sample.push(...byBucket[b].slice(0, perBucket));
  }
  // Fill remaining slots from the bucket-shuffled overflow
  const remaining = targetN - sample.length;
  if (remaining > 0) {
    const overflow: SampleReview[] = [];
    for (const b of buckets) {
      overflow.push(...byBucket[b].slice(perBucket));
    }
    overflow.sort(() => rng() - 0.5);
    sample.push(...overflow.slice(0, remaining));
  }

  // Final shuffle so the run order isn't bucket-correlated
  sample.sort(() => rng() - 0.5);

  // Ship-check P0 fix (both reviewers, 2026-04-27): inject the Helen Shaw row
  // from the FROZEN fixture, NOT the live disk file. Disk file can drift
  // (manual edits, conflict-marker corruption, file deletion) and silently
  // bypass the regression. Replace any disk-sampled Helen Shaw with the
  // fixture, or prepend if not in the random sample at all.
  const fixtureRow = loadHelenShawFromFixture();
  if (fixtureRow) {
    const existingIdx = sample.findIndex(s => s.outletId === 'nytimes' && s.showId === 'the-lost-boys-2026');
    if (existingIdx >= 0) {
      sample[existingIdx] = fixtureRow;
    } else {
      // Replace last slot rather than grow beyond N — keeps sample size honest
      if (sample.length >= targetN) sample[sample.length - 1] = fixtureRow;
      else sample.push(fixtureRow);
    }
  }

  return sample;
}

/**
 * Load the Helen Shaw row from the frozen fixture (not from live disk).
 * Returns null if fixture is missing — the harness will exit with a hard
 * error rather than silently running without the regression check.
 */
function loadHelenShawFromFixture(): SampleReview | null {
  if (!fs.existsSync(HELEN_SHAW_FIXTURE_PATH)) {
    console.warn(`⚠️  Helen Shaw fixture missing at ${HELEN_SHAW_FIXTURE_PATH} — regression check WILL FAIL.`);
    return null;
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(HELEN_SHAW_FIXTURE_PATH, 'utf-8'));
  } catch (e: any) {
    console.warn(`⚠️  Helen Shaw fixture parse error: ${e.message}`);
    return null;
  }
  if (!raw.fullText || raw.fullText.length < 200) return null;

  const built = buildScoringInput({
    showId: raw.source.showId,
    showTitle: raw.source.showTitle,
    outlet: raw.source.outlet,
    outletId: raw.source.outletId,
    criticName: raw.source.criticName,
    publishDate: raw.source.publishDate,
    category: raw.source.category,
    venue: raw.source.venue,
    fullText: raw.fullText,
  });
  // Use the v5.3.0 ensemble baseline score from the fixture (68 Mixed) as
  // oldStored, NOT the manual-override 78 — the override is for the live site,
  // the A/B comparison should measure the prompt's effect against ensemble
  // output, not against human-locked values.
  const ensembleBaseline = raw.baseline?.ensembleScore ?? 68;
  return {
    showId: raw.source.showId,
    outletId: raw.source.outletId,
    filePath: HELEN_SHAW_FIXTURE_PATH,
    text: built.text,
    context: built.context,
    oldScore: ensembleBaseline,
    oldBucket: scoreBucket(ensembleBaseline),
    publishDate: raw.source.publishDate,
  };
}

function scoreBucket(score: number): Bucket {
  if (score >= BUCKET_RANGES.Rave.min) return 'Rave';
  if (score >= BUCKET_RANGES.Positive.min) return 'Positive';
  if (score >= BUCKET_RANGES.Mixed.min) return 'Mixed';
  if (score >= BUCKET_RANGES.Negative.min) return 'Negative';
  return 'Pan';
}

// Deterministic shuffle so reruns hit the same sample
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ========================================
// SCORE WITH A GIVEN PROMPT
// ========================================

interface PromptRunResult {
  score: number;
  bucket: Bucket;
  confidence: 'high' | 'medium' | 'low';
  source: string;
  models: { claude: number | null; openai: number | null; gemini: number | null };
  modelBuckets: { claude: Bucket | null; openai: Bucket | null; gemini: Bucket | null };
  rejected?: boolean;
  rejection?: string;
  error?: string;
}

async function scoreWithPrompt(
  scorers: { claude: ReviewScorer; openai: OpenAIReviewScorer; gemini: GeminiScorer },
  text: string,
  context: string,
  systemPrompt: string
): Promise<PromptRunResult> {
  // Score all three models in parallel with the given prompt
  const [claudeOutcome, openaiOutcome, geminiOutcome] = await Promise.all([
    scorers.claude.scoreReviewV5(text, context, systemPrompt).catch(e => ({ success: false, error: e.message } as any)),
    scorers.openai.scoreReviewV5(text, context, systemPrompt).catch(e => ({ success: false, error: e.message } as any)),
    scorers.gemini.scoreReview(text, context, systemPrompt).catch(e => ({ success: false, error: e.message } as any)),
  ]);

  // Treat rejections + errors as null model scores
  const claudeResult = (claudeOutcome.success && !claudeOutcome.rejected) ? claudeOutcome.result! : null;
  const openaiResult = (openaiOutcome.success && !openaiOutcome.rejected) ? openaiOutcome.result! : null;
  const geminiResult = (geminiOutcome.success && !geminiOutcome.rejected) ? geminiOutcome.result! : null;

  // Consensus rejection (≥2 models rejecting)
  const rejectionCount = [claudeOutcome, openaiOutcome, geminiOutcome].filter((o: any) => o.rejected).length;
  if (rejectionCount >= 2) {
    const firstRej: any = [claudeOutcome, openaiOutcome, geminiOutcome].find((o: any) => o.rejected);
    return {
      score: -1,
      bucket: 'Mixed',
      confidence: 'low',
      source: 'rejected',
      models: { claude: null, openai: null, gemini: null },
      modelBuckets: { claude: null, openai: null, gemini: null },
      rejected: true,
      rejection: firstRej?.rejection,
    };
  }

  const claudeMs = toModelScore(claudeResult, 'claude', claudeOutcome.error);
  const openaiMs = toModelScore(openaiResult, 'openai', openaiOutcome.error);
  const geminiMs = toModelScore(geminiResult, 'gemini', geminiOutcome.error);

  const ens: EnsembleResult = ensembleScore(
    claudeResult ? claudeMs : null,
    openaiResult ? openaiMs : null,
    geminiResult ? geminiMs : null
  );

  return {
    score: ens.score,
    bucket: ens.bucket,
    confidence: ens.confidence,
    source: ens.source,
    models: {
      claude: claudeResult?.score ?? null,
      openai: openaiResult?.score ?? null,
      gemini: geminiResult?.score ?? null,
    },
    modelBuckets: {
      claude: claudeResult?.bucket ?? null,
      openai: openaiResult?.bucket ?? null,
      gemini: geminiResult?.bucket ?? null,
    },
  };
}

// ========================================
// MAIN
// ========================================

interface PerReviewResult {
  showId: string;
  outletId: string;
  publishDate: string | null;
  oldStored: { score: number; bucket: Bucket };
  oldPrompt: PromptRunResult;
  newPrompt: PromptRunResult;
  drift: number;        // newPrompt.score - oldPrompt.score
  bucketChanged: boolean;
}

async function main() {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;

  if (!claudeKey || !openaiKey || !geminiKey) {
    console.error('Missing API key(s). Need ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.');
    console.error(`  ANTHROPIC: ${claudeKey ? 'set' : 'MISSING'}`);
    console.error(`  OPENAI:    ${openaiKey ? 'set' : 'MISSING'}`);
    console.error(`  GEMINI:    ${geminiKey ? 'set' : 'MISSING'}`);
    process.exit(1);
  }

  const scorers = {
    claude: new ReviewScorer(claudeKey, { model: 'claude-sonnet-4-6', verbose: false }),
    openai: new OpenAIReviewScorer(openaiKey, { model: 'gpt-4o', verbose: false }),
    // gemini-2.5-flash has separate quota pool from 2.0-flash; A/B uses 2.5
    // because the production 2.0 quota is exhausted by daily CI cycles.
    // Production scorer still uses 2.0-flash — slight model mismatch in A/B
    // is acceptable since both are Gemini Flash family with similar behavior.
    gemini: new GeminiScorer(geminiKey, { model: 'gemini-2.5-flash' as any, verbose: false }),
  };

  console.log('='.repeat(70));
  console.log(`  PROMPT A/B HARNESS — rule 13 contract`);
  console.log(`  Old: SYSTEM_PROMPT_V5 (${PROMPT_VERSION})`);
  console.log(`  New: SYSTEM_PROMPT_V5_STRUCTURAL (${PROMPT_VERSION_CANDIDATE})`);
  console.log('='.repeat(70));

  // ----------------- Sample selection -----------------
  let sample: SampleReview[];
  if (QUICK) {
    sample = await loadQuickSample();
    console.log(`\nQuick mode: ${sample.length} fixed cases (incl. Helen Shaw fixture).`);
  } else {
    console.log(`\nSelecting up to ${N} reviews from last ${DAYS} days...`);
    sample = selectSample(N, DAYS);
    console.log(`Selected ${sample.length} reviews.`);
    if (sample.length < 50) {
      console.error(`⛔ Too few eligible reviews (${sample.length}). Pass --days=365 or --n=50 to relax.`);
      process.exit(2);
    }
  }

  // Bucket distribution preview
  const sampleByBucket: Record<Bucket, number> = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  for (const r of sample) sampleByBucket[r.oldBucket]++;
  console.log('Sample bucket distribution (from existing scores):');
  for (const b of Object.keys(sampleByBucket) as Bucket[]) {
    console.log(`  ${b.padEnd(10)} ${String(sampleByBucket[b]).padStart(4)}`);
  }
  console.log();

  // ----------------- Score everything -----------------
  const perReview: PerReviewResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    process.stdout.write(`[${i + 1}/${sample.length}] ${r.showId.slice(0, 32).padEnd(32)} / ${r.outletId.slice(0, 14).padEnd(14)} ... `);

    try {
      // Run old + new in parallel — same review, two prompts
      const [oldRun, newRun] = await Promise.all([
        scoreWithPrompt(scorers, r.text, r.context, SYSTEM_PROMPT_V5),
        scoreWithPrompt(scorers, r.text, r.context, SYSTEM_PROMPT_V5_STRUCTURAL),
      ]);

      const drift = newRun.score - oldRun.score;
      const bucketChanged = oldRun.bucket !== newRun.bucket;
      const dir = drift > 0 ? '↑' : drift < 0 ? '↓' : '=';
      const flag = bucketChanged ? ` ${oldRun.bucket}→${newRun.bucket}` : '';
      console.log(`${oldRun.score}→${newRun.score} (${dir}${Math.abs(drift)})${flag}`);

      perReview.push({
        showId: r.showId,
        outletId: r.outletId,
        publishDate: r.publishDate,
        oldStored: { score: r.oldScore, bucket: r.oldBucket },
        oldPrompt: oldRun,
        newPrompt: newRun,
        drift,
        bucketChanged,
      });
    } catch (e: any) {
      console.log(`ERROR: ${e.message?.slice(0, 80)}`);
    }

    // Light pacing — combined 6 API calls per loop, but parallel
    await new Promise(r => setTimeout(r, 200));
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\nScored ${perReview.length}/${sample.length} reviews in ${elapsed}s.\n`);

  // ----------------- Aggregate diffs -----------------
  const summary = aggregate(perReview);

  // ----------------- Pretty-print -----------------
  printSummary(summary);

  // ----------------- Helen Shaw assertion -----------------
  // Ship-check P0 fix: pass criteria require Helen Shaw to PASS, not just
  // "not fail." 'absent' is now a hard fail — the fixture is injected
  // unconditionally in selectSample, so absence indicates a wiring bug.
  // Match by exact outletId + showId, not regex (avoids alias drift).
  const helenShaw = perReview.find(r => r.showId === 'the-lost-boys-2026' && r.outletId === 'nytimes');
  let helenShawStatus: 'pass' | 'fail' | 'absent' = 'absent';
  if (helenShaw) {
    const ns = helenShaw.newPrompt.score;
    helenShawStatus = (ns >= 75 && ns <= 82) ? 'pass' : 'fail';
    console.log(`\nHelen Shaw fixture: new-prompt score = ${ns}, target 75-82 → ${helenShawStatus.toUpperCase()}`);
    console.log(`  old-prompt: ${helenShaw.oldPrompt.score} (${helenShaw.oldPrompt.bucket})`);
    console.log(`  new-prompt: ${helenShaw.newPrompt.score} (${helenShaw.newPrompt.bucket})`);
  } else {
    console.log(`\n⛔ Helen Shaw fixture: ABSENT from sample — fixture-injection failed. Hard fail.`);
  }

  // ----------------- Verdict -----------------
  const passed =
    summary.maxBucketShift < BUCKET_SHIFT_THRESHOLD &&
    Math.abs(summary.meanDrift) < MEAN_DRIFT_THRESHOLD &&
    helenShawStatus === 'pass';

  console.log('\n' + '='.repeat(70));
  if (passed) {
    console.log(`  ✅ A/B PASSED — prompt change ships.`);
    console.log(`     Max bucket shift: ${summary.maxBucketShift.toFixed(1)}pp (limit ${BUCKET_SHIFT_THRESHOLD}pp)`);
    console.log(`     Mean signed drift: ${summary.meanDrift > 0 ? '+' : ''}${summary.meanDrift.toFixed(1)} pts (limit ±${MEAN_DRIFT_THRESHOLD})`);
    if (helenShawStatus === 'pass') {
      console.log(`     Helen Shaw fixture: PASSED (75-82 range)`);
    }
  } else {
    console.log(`  ⛔ A/B FAILED — do NOT ship this prompt.`);
    if (summary.maxBucketShift >= BUCKET_SHIFT_THRESHOLD) {
      console.log(`     Max bucket shift: ${summary.maxBucketShift.toFixed(1)}pp ≥ ${BUCKET_SHIFT_THRESHOLD}pp`);
    }
    if (Math.abs(summary.meanDrift) >= MEAN_DRIFT_THRESHOLD) {
      console.log(`     Mean signed drift: ${summary.meanDrift > 0 ? '+' : ''}${summary.meanDrift.toFixed(1)} pts ≥ ±${MEAN_DRIFT_THRESHOLD}`);
    }
    if (helenShawStatus === 'fail') {
      console.log(`     Helen Shaw fixture FAILED (new score ${helenShaw!.newPrompt.score} outside 75-82)`);
    }
    console.log(`     Iterate the prompt with less aggressive guidance and rerun.`);
  }
  console.log('='.repeat(70) + '\n');

  // ----------------- Persist -----------------
  // Ship-check P1 fix: full ISO timestamp in filename so same-day reruns
  // (common when iterating prompt wording) don't overwrite prior results.
  // Symlink llm-prompt-ab-latest.json to the most recent for easy access.
  if (!NO_WRITE) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(__dirname, '../../data/audit');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `llm-prompt-ab-${ts}.json`);
    const payload = {
      schemaVersion: 1,
      runAt: new Date().toISOString(),
      mode: QUICK ? 'quick' : 'full',
      promptOld: { version: PROMPT_VERSION, label: 'SYSTEM_PROMPT_V5' },
      promptNew: { version: PROMPT_VERSION_CANDIDATE, label: 'SYSTEM_PROMPT_V5_STRUCTURAL' },
      sampleSize: sample.length,
      scoredCount: perReview.length,
      windowDays: DAYS,
      thresholds: {
        bucketShiftPp: BUCKET_SHIFT_THRESHOLD,
        meanDriftPts: MEAN_DRIFT_THRESHOLD,
      },
      summary,
      helenShaw: helenShaw ? {
        status: helenShawStatus,
        oldScore: helenShaw.oldPrompt.score,
        newScore: helenShaw.newPrompt.score,
        target: '75-82',
        oldBucket: helenShaw.oldPrompt.bucket,
        newBucket: helenShaw.newPrompt.bucket,
      } : null,
      passed,
      perReview,
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`Output saved: ${outPath}\n`);
  }

  process.exit(passed ? 0 : 1);
}

// ========================================
// AGGREGATION + REPORTING
// ========================================

interface SummaryStats {
  scoredCount: number;
  meanDrift: number;
  meanAbsDrift: number;
  bucketChangeCount: number;
  bucketChangePct: number;
  oldBucketShare: Record<Bucket, number>;
  newBucketShare: Record<Bucket, number>;
  bucketShiftPp: Record<Bucket, number>;
  maxBucketShift: number;
  migrationMatrix: Record<Bucket, Record<Bucket, number>>;
  perOutletDrift: Record<string, { count: number; meanDrift: number }>;
}

function aggregate(rows: PerReviewResult[]): SummaryStats {
  const buckets: Bucket[] = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
  const oldCounts: Record<Bucket, number> = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  const newCounts: Record<Bucket, number> = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  const matrix: Record<Bucket, Record<Bucket, number>> = {} as any;
  for (const b of buckets) {
    matrix[b] = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  }
  const drifts: number[] = [];
  const perOutlet: Record<string, { count: number; sumDrift: number }> = {};

  for (const r of rows) {
    if (r.oldPrompt.rejected || r.newPrompt.rejected) continue;
    // Ship-check P1 fix (Codex reviewer 2026-04-27): exclude rows where
    // either run fell back to fewer than 3 models. A 2-model or 1-model
    // ensemble result is not a valid A/B data point — Gemini 429s during the
    // run can silently degrade rows that get aggregated as if they were
    // 3-model evidence.
    if (r.oldPrompt.source !== 'ensemble-unanimous' && r.oldPrompt.source !== 'ensemble-majority' && r.oldPrompt.source !== 'ensemble-no-consensus') continue;
    if (r.newPrompt.source !== 'ensemble-unanimous' && r.newPrompt.source !== 'ensemble-majority' && r.newPrompt.source !== 'ensemble-no-consensus') continue;
    oldCounts[r.oldPrompt.bucket]++;
    newCounts[r.newPrompt.bucket]++;
    matrix[r.oldPrompt.bucket][r.newPrompt.bucket]++;
    drifts.push(r.drift);
    if (!perOutlet[r.outletId]) perOutlet[r.outletId] = { count: 0, sumDrift: 0 };
    perOutlet[r.outletId].count++;
    perOutlet[r.outletId].sumDrift += r.drift;
  }

  const n = drifts.length || 1;
  const meanDrift = drifts.reduce((a, b) => a + b, 0) / n;
  const meanAbsDrift = drifts.map(d => Math.abs(d)).reduce((a, b) => a + b, 0) / n;
  const bucketChangeCount = rows.filter(r => r.bucketChanged && !r.oldPrompt.rejected && !r.newPrompt.rejected).length;
  const bucketChangePct = (bucketChangeCount / n) * 100;

  const oldShare: Record<Bucket, number> = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  const newShare: Record<Bucket, number> = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  const shiftPp: Record<Bucket, number> = { Rave: 0, Positive: 0, Mixed: 0, Negative: 0, Pan: 0 };
  let maxShift = 0;
  for (const b of buckets) {
    oldShare[b] = (oldCounts[b] / n) * 100;
    newShare[b] = (newCounts[b] / n) * 100;
    shiftPp[b] = newShare[b] - oldShare[b];
    if (Math.abs(shiftPp[b]) > maxShift) maxShift = Math.abs(shiftPp[b]);
  }

  const perOutletDrift: Record<string, { count: number; meanDrift: number }> = {};
  for (const [outlet, info] of Object.entries(perOutlet)) {
    perOutletDrift[outlet] = { count: info.count, meanDrift: info.sumDrift / info.count };
  }

  return {
    scoredCount: n,
    meanDrift,
    meanAbsDrift,
    bucketChangeCount,
    bucketChangePct,
    oldBucketShare: oldShare,
    newBucketShare: newShare,
    bucketShiftPp: shiftPp,
    maxBucketShift: maxShift,
    migrationMatrix: matrix,
    perOutletDrift,
  };
}

function printSummary(s: SummaryStats): void {
  const buckets: Bucket[] = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];

  console.log('─'.repeat(70));
  console.log(`  A/B SUMMARY (n=${s.scoredCount})`);
  console.log('─'.repeat(70));
  console.log(`  Mean signed drift:    ${s.meanDrift > 0 ? '+' : ''}${s.meanDrift.toFixed(2)} pts`);
  console.log(`  Mean absolute drift:  ${s.meanAbsDrift.toFixed(2)} pts`);
  console.log(`  Bucket changes:       ${s.bucketChangeCount} (${s.bucketChangePct.toFixed(1)}%)`);
  console.log();
  console.log('  Bucket-share shift:');
  console.log('  Bucket        Old%    New%    Shift');
  for (const b of buckets) {
    const sign = s.bucketShiftPp[b] > 0 ? '+' : '';
    const flag = Math.abs(s.bucketShiftPp[b]) >= BUCKET_SHIFT_THRESHOLD ? ' ⚠️' : '';
    console.log(`  ${b.padEnd(12)} ${s.oldBucketShare[b].toFixed(1).padStart(5)}%  ${s.newBucketShare[b].toFixed(1).padStart(5)}%  ${sign}${s.bucketShiftPp[b].toFixed(1)}pp${flag}`);
  }
  console.log();
  console.log('  Migration matrix (rows=old, cols=new):');
  console.log('  ' + 'old\\new'.padEnd(12) + buckets.map(b => b.slice(0, 4).padStart(6)).join(' '));
  for (const oldB of buckets) {
    const row = buckets.map(newB => String(s.migrationMatrix[oldB][newB]).padStart(6)).join(' ');
    console.log(`  ${oldB.padEnd(12)}${row}`);
  }
}

// ========================================
// QUICK SAMPLE — Helen Shaw + 5 calibrated cases
// ========================================

async function loadQuickSample(): Promise<SampleReview[]> {
  const showsIndex = loadShowsIndex();
  const targets = [
    // Helen Shaw — must be in any quick run
    { showId: 'the-lost-boys-2026', file: 'nytimes--helen-shaw.json' },
    // A handful of varied buckets across recent shows for sanity
    { showId: 'the-lost-boys-2026', file: 'talkinbroadway--howard-miller.json' },
    { showId: 'the-lost-boys-2026', file: 'nypost--johnny-oleksinski.json' },
    { showId: 'the-lost-boys-2026', file: 'timeout--adam-feldman.json' },
    { showId: 'the-lost-boys-2026', file: 'guardian--jesse-hassenger.json' },
    { showId: 'the-lost-boys-2026', file: 'theatermania--david-gordon.json' },
  ];

  const sample: SampleReview[] = [];
  for (const t of targets) {
    const filePath = path.join(REVIEW_TEXTS_DIR, t.showId, t.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️  Missing: ${filePath}`);
      continue;
    }
    const data: RawReviewFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data.fullText || data.fullText.length < 200) continue;

    const showInfo = showsIndex.get(data.showId || t.showId);
    const excerptData: Record<string, string | null> = {};
    for (const ef of EXCERPT_FIELDS) excerptData[ef] = (data as any)[ef] ?? null;
    const built = buildScoringInput({
      showId: data.showId || t.showId,
      showTitle: data.showTitle || showInfo?.title,
      outletId: data.outletId,
      outlet: data.outlet,
      criticName: data.criticName,
      publishDate: data.publishDate || '',
      category: data.category || showInfo?.category,
      venue: data.venue || showInfo?.venue || undefined,
      fullText: data.fullText,
      ...excerptData,
      bwwThumb: data.bwwThumb,
      dtliThumb: data.dtliThumb,
      bwwScore: data.bwwScore ?? null,
      originalScore: data.originalScore != null ? String(data.originalScore) : null,
      originalRating: data.originalRating,
    });

    const oldScore = data.llmScore?.score ?? 50;
    sample.push({
      showId: data.showId || t.showId,
      outletId: data.outletId || t.file.split('--')[0],
      filePath,
      text: built.text,
      context: built.context,
      oldScore,
      oldBucket: scoreBucket(oldScore),
      publishDate: data.publishDate || null,
    });
  }
  return sample;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(99);
});
