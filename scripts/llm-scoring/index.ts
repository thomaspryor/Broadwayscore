#!/usr/bin/env npx ts-node --project scripts/tsconfig.json

/**
 * LLM Review Scoring Pipeline
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts [options]
 *
 * Options:
 *   --show=<slug>         Process only one show
 *   --all                 Process all shows (default if no --show)
 *   --unscored-only       Only score reviews without existing LLM scores (default: true)
 *   --rescore             Re-score even if already scored
 *   --needs-rescore       Only score reviews flagged with needsRescore=true (excerpt→fullText upgrades)
 *   --outdated            Re-score reviews with promptVersion older than current PROMPT_VERSION
 *   --force-full-run      Skip the A/B distribution check (required for --outdated runs >100 reviews)
 *   --stale-scores        Score reviews with stale excerpt-based scores that now have fullText
 *   --retry-emergency     Retry stuck singleModelEmergency reviews once (clears flag if 2+ models succeed)
 *   --ensemble-source=X   Only rescore reviews with this ensembleSource (e.g. two-model-fallback)
 *   --score-range=MIN-MAX Only process reviews with existing LLM score in this range (e.g. 78-82)
 *   --dry-run             Don't save results, just print what would happen
 *   --verbose             Detailed logging
 *   --limit=N             Only process N reviews
 *   --calibrate           Run calibration analysis after scoring
 *   --validate            Run aggregator validation after scoring
 *   --model=<model>       Claude model to use (sonnet or haiku)
 *   --ensemble            Use ensemble mode (Claude + OpenAI for triangulation)
 *   --ground-truth        Run ground truth calibration against numeric ratings
 *   --rate-limit=N        Delay between API calls in ms (default: 100)
 *
 * Examples:
 *   # Score all unscored reviews for one show
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --show=cabaret-2024
 *
 *   # Score with ensemble mode (Claude + OpenAI)
 *   ANTHROPIC_API_KEY=sk-... OPENAI_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --ensemble --limit=10
 *
 *   # Score all shows, run calibration and validation
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --all --calibrate --validate
 *
 *   # Dry run with verbose output
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --dry-run --verbose --limit=5
 *
 *   # Run ground truth calibration against numeric ratings
 *   npx ts-node scripts/llm-scoring/index.ts --ground-truth
 *
 *   # Just run calibration (no scoring)
 *   npx ts-node scripts/llm-scoring/index.ts --calibrate-only
 *
 *   # Just run validation (no scoring)
 *   npx ts-node scripts/llm-scoring/index.ts --validate-only
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ReviewScorer } from './scorer';
import { EnsembleReviewScorer, ModelOutcome, ScoreReviewFileResult } from './ensemble-scorer';
import {
  assembleRequests,
  estimateBatchUsage,
  submitBatches,
  pollUntilTerminal,
  fetchAndMerge,
  outcomesForItem,
  buildBatchState,
  computeInputHash,
  BatchState,
  PendingBatchItem,
} from './batch-runner';
import { runCalibration, runEnsembleCalibration } from './calibration';
import { runValidation } from './validation';
import { findGroundTruthReviews, calculateGroundTruthCalibration, printGroundTruthReport } from './ground-truth';
import { ReviewTextFile, ScoringPipelineOptions, PipelineRunSummary } from './types';

// Import content quality module for garbage detection
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assessTextQuality, detectGarbageFromReasoning } = require('../lib/content-quality.js');
const { EXCERPT_FIELDS, hasExcerpt: hasAnyExcerptField } = require('../lib/excerpt-fields');

import { detectMultiShow } from './multi-show-detector';
import { trimMultiShowText } from './trim-multi-show';
import { PROMPT_VERSION, SYSTEM_PROMPT_V5, buildPromptV5, BUCKET_RANGES } from './config';
import { isScoreable } from './is-scoreable';
const { emitStage } = require('../lib/stage-latency');
const { clearFailureFlags } = require('../lib/clear-failure-flags');
const { isInFallbackCooldown } = require('../lib/manual-clear-fallback-cooldown');
const { markRescoreComplete, stampTerminalScoringFailure, isBlockedFromRescore, isDeterministicTextGateFailure } = require('../lib/rescore-lifecycle');
const { pushWithRetry } = require('../lib/push-with-retry.js');
// venue-classification import removed — market context now passed via input-builder

// ========================================
// SEMVER COMPARISON
// ========================================

/**
 * Compare two semver strings. Returns <0 if a<b, 0 if equal, >0 if a>b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ========================================
// A/B DISTRIBUTION CHECK (RESCORE GUARDRAIL)
// ========================================

const AB_SAMPLE_SIZE = 50;
const AB_BUCKET_SHIFT_THRESHOLD = 5; // % shift in any bucket triggers warning

interface ABCheckResult {
  passed: boolean;
  sampleSize: number;
  bucketShifts: Record<string, { old: number; new: number; shift: number }>;
  meanSignedDrift: number;
  meanAbsDrift: number;
  details: string;
}

/**
 * Before a bulk rescore, sample N reviews, score them with the new prompt,
 * and compare against their existing scores. If the distribution shifts
 * significantly, refuse to proceed without --force-full-run.
 */
async function runABDistributionCheck(
  files: Array<{ path: string; data: ReviewTextFile }>,
  getScorableText: (data: ReviewTextFile, filePath: string) => string | null,
  scorer: EnsembleReviewScorer,
  verbose: boolean
): Promise<ABCheckResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESCORE A/B DISTRIBUTION CHECK`);
  console.log(`  Scoring ${AB_SAMPLE_SIZE} random reviews with new prompt (v${PROMPT_VERSION})`);
  console.log(`  to compare against their existing scores.`);
  console.log(`${'='.repeat(60)}\n`);

  // Sample reviews that have existing scores (for comparison)
  const withScores = files.filter(f => (f.data as any).llmScore?.score != null);
  const shuffled = [...withScores].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, AB_SAMPLE_SIZE);

  const buckets = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'] as const;
  const oldBucketCounts: Record<string, number> = {};
  const newBucketCounts: Record<string, number> = {};
  for (const b of buckets) { oldBucketCounts[b] = 0; newBucketCounts[b] = 0; }

  const drifts: number[] = [];
  let scored = 0;

  for (let i = 0; i < sample.length; i++) {
    const { path: filePath, data: reviewFile } = sample[i];
    const text = getScorableText(reviewFile, filePath);
    if (!text) continue;

    const oldScore = (reviewFile as any).llmScore.score as number;
    const oldBucket = (reviewFile as any).llmScore.bucket as string;

    process.stdout.write(`  [${i + 1}/${sample.length}] ${reviewFile.showId} / ${reviewFile.outletId || ''}... `);

    try {
      const result = await scorer.scoreReview(text);
      if (!result || !('score' in result)) {
        console.log('SKIPPED (rejection/error)');
        continue;
      }

      const newScore = result.score;
      const newBucket = result.bucket;
      const drift = newScore - oldScore;
      drifts.push(drift);

      oldBucketCounts[oldBucket] = (oldBucketCounts[oldBucket] || 0) + 1;
      newBucketCounts[newBucket] = (newBucketCounts[newBucket] || 0) + 1;
      scored++;

      const dir = drift > 0 ? '↑' : drift < 0 ? '↓' : '=';
      console.log(`${oldScore}→${newScore} (${dir}${Math.abs(drift)}) [${oldBucket}→${newBucket}]`);
    } catch (e: any) {
      console.log(`ERROR: ${e.message?.slice(0, 60)}`);
    }
  }

  if (scored < 10) {
    return {
      passed: true,
      sampleSize: scored,
      bucketShifts: {},
      meanSignedDrift: 0,
      meanAbsDrift: 0,
      details: 'Too few reviews scored for comparison — proceeding.'
    };
  }

  // Calculate stats
  const meanSigned = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const meanAbs = drifts.map(d => Math.abs(d)).reduce((a, b) => a + b, 0) / drifts.length;

  // Bucket shifts as percentages
  const bucketShifts: Record<string, { old: number; new: number; shift: number }> = {};
  let maxShift = 0;
  for (const b of buckets) {
    const oldPct = (oldBucketCounts[b] / scored) * 100;
    const newPct = (newBucketCounts[b] / scored) * 100;
    const shift = newPct - oldPct;
    bucketShifts[b] = { old: Math.round(oldPct), new: Math.round(newPct), shift: Math.round(shift) };
    maxShift = Math.max(maxShift, Math.abs(shift));
  }

  // Print report
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`  A/B CHECK RESULTS (n=${scored})`);
  console.log(`${'─'.repeat(55)}`);
  console.log(`  Mean signed drift:   ${meanSigned > 0 ? '+' : ''}${meanSigned.toFixed(1)} pts`);
  console.log(`  Mean absolute drift: ${meanAbs.toFixed(1)} pts`);
  console.log('');
  console.log('  Bucket        Old%   New%   Shift');
  for (const b of buckets) {
    const s = bucketShifts[b];
    const sign = s.shift > 0 ? '+' : '';
    const flag = Math.abs(s.shift) >= AB_BUCKET_SHIFT_THRESHOLD ? ' ⚠️' : '';
    console.log(`  ${b.padEnd(12)} ${String(s.old).padStart(4)}%  ${String(s.new).padStart(4)}%  ${sign}${s.shift}%${flag}`);
  }

  const passed = maxShift < AB_BUCKET_SHIFT_THRESHOLD && Math.abs(meanSigned) < 5;

  if (!passed) {
    console.log(`\n  ⛔ DISTRIBUTION SHIFT DETECTED`);
    console.log(`  A bucket shifted by ≥${AB_BUCKET_SHIFT_THRESHOLD}% or mean drift ≥5 pts.`);
    console.log(`  This suggests the prompt change has unintended side effects.`);
    console.log(`  Pass --force-full-run to override this check.`);
  } else {
    console.log(`\n  ✅ Distribution looks stable. Proceeding.`);
  }
  console.log('');

  return {
    passed,
    sampleSize: scored,
    bucketShifts,
    meanSignedDrift: meanSigned,
    meanAbsDrift: meanAbs,
    details: passed
      ? `Distribution stable: max bucket shift ${maxShift.toFixed(0)}%, mean drift ${meanSigned > 0 ? '+' : ''}${meanSigned.toFixed(1)}`
      : `Distribution shifted: max bucket shift ${maxShift.toFixed(0)}%, mean drift ${meanSigned > 0 ? '+' : ''}${meanSigned.toFixed(1)}`
  };
}

// ========================================
// CONSTANTS
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '../../data/review-texts');
const SHOWS_JSON_PATH = path.join(__dirname, '../../data/shows.json');
const RUNS_LOG_PATH = path.join(__dirname, '../../data/llm-scoring-runs.json');
const GARBAGE_SKIPS_PATH = path.join(__dirname, '../../data/llm-scoring-garbage-skips.json');
const PROJECT_ROOT = path.join(__dirname, '../..');
const SCORING_PROGRESS_PATH = path.join(PROJECT_ROOT, 'data', 'collection-state', 'scoring-progress.json');
// In-flight batch state lives in its OWN file, not inside scoring-progress.json.
// scoring-progress.json is rewritten wholesale by every run (including parallel
// rescore lanes, which get their own workflow concurrency group), and
// gitCheckpoint resolves push conflicts with `merge -X ours` — so a concurrent
// run's stale copy could erase the vendor batch IDs from origin and make the
// next scheduled run resubmit a batch we had already paid for. A file only the
// batch path ever writes has no such second writer. (task #516 ship-check)
const SCORING_BATCH_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'collection-state', 'scoring-batch-state.json');

// Every saveReviewFile() call increments this, regardless of whether the
// file ended up scored or merely rejected/flagged. `processed` alone misses
// all-rejected batches — the CI gate (scripts/lib/scoring-progress-gate.js)
// reads this to know real review-text writes happened even when zero files
// scored (P1 352637c5-416f-81ab).
let filesModifiedCount = 0;

// ========================================
// SCORING PRIORITY
// ========================================

interface ShowPriorityInfo {
  status: string;
  openingDate: string | null;
  category: string;
  venue: string | null;
  type: string | null;
}

/**
 * Load show metadata for scoring prioritization.
 * Returns a map of showId → { status, openingDate }.
 */
function loadShowPriority(): Map<string, ShowPriorityInfo> {
  const map = new Map<string, ShowPriorityInfo>();
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf-8'));
    for (const show of (shows.shows || shows)) {
      map.set(show.id, {
        status: show.status || 'closed',
        openingDate: show.openingDate || null,
        category: show.category || 'broadway',
        venue: show.venue || null,
        type: show.type || null,
      });
    }
  } catch {
    // Fall through — no prioritization if shows.json missing
  }
  return map;
}

/**
 * Load show ID → title mapping for quality checks.
 * assessTextQuality needs the human-readable title to validate show mentions.
 */
function loadShowTitles(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_JSON_PATH, 'utf-8'));
    for (const show of (shows.shows || shows)) {
      if (show.id && show.title) {
        map.set(show.id, show.title);
      }
    }
  } catch {
    // Fall through
  }
  return map;
}

/**
 * Sort reviews by scoring priority:
 *   1. Full-text reviews before excerpt-only
 *   2. Open shows before previews before closed
 *   3. Newer opening dates first
 */
function prioritizeReviews(
  files: Array<{ path: string; data: ReviewTextFile }>,
  showPriority: Map<string, ShowPriorityInfo>
): Array<{ path: string; data: ReviewTextFile }> {
  const statusOrder: Record<string, number> = { open: 0, previews: 1, closed: 2 };

  return [...files].sort((a, b) => {
    // 1. Full text first
    const aHasText = !!(a.data as any).fullText && (a.data as any).fullText.length >= 200;
    const bHasText = !!(b.data as any).fullText && (b.data as any).fullText.length >= 200;
    if (aHasText !== bHasText) return aHasText ? -1 : 1;

    // 2. Show status: open > previews > closed
    const aShow = showPriority.get((a.data as any).showId || '');
    const bShow = showPriority.get((b.data as any).showId || '');
    const aStatus = statusOrder[aShow?.status || 'closed'] ?? 2;
    const bStatus = statusOrder[bShow?.status || 'closed'] ?? 2;
    if (aStatus !== bStatus) return aStatus - bStatus;

    // 3. Newer opening date first
    const aDate = aShow?.openingDate || '1900-01-01';
    const bDate = bShow?.openingDate || '1900-01-01';
    if (aDate !== bDate) return bDate.localeCompare(aDate);

    return 0;
  });
}

// ========================================
// LIVE PROGRESS REPORTING
// ========================================

/**
 * Write live progress to GITHUB_STEP_SUMMARY (visible in Actions UI during run)
 * and to a progress JSON file that gets committed at each checkpoint.
 */
function writeProgress(
  processedSoFar: number,
  totalFiles: number,
  errors: number,
  skipped: number,
  startTime: number,
  globalCounts?: { totalReviewFiles: number; totalScored: number; totalUnscored: number; totalSkipped: number }
): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const elapsedMin = Math.round(elapsed / 60);
  const rate = processedSoFar > 0 ? (elapsed / processedSoFar).toFixed(1) : '?';
  const remaining = processedSoFar > 0 ? Math.round((totalFiles - processedSoFar) * elapsed / processedSoFar / 60) : '?';
  const pct = totalFiles > 0 ? Math.round(processedSoFar / totalFiles * 100) : 0;
  const timestamp = new Date().toISOString();

  // Write to GITHUB_STEP_SUMMARY (visible in Actions web UI during run)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const summary = [
      `## Scoring Progress: ${processedSoFar}/${totalFiles} (${pct}%)`,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Processed | ${processedSoFar} |`,
      `| Skipped | ${skipped} |`,
      `| Errors | ${errors} |`,
      `| Elapsed | ${elapsedMin} min |`,
      `| Rate | ${rate}s per review |`,
      `| Est. remaining | ${remaining} min |`,
      `| Last updated | ${timestamp} |`,
      ``
    ].join('\n');
    try { fs.writeFileSync(summaryPath, summary); } catch {}
  }

  // Write progress JSON for monitoring
  const progressPath = SCORING_PROGRESS_PATH;
  // Surface in-flight batch status here (the authoritative copy lives in
  // scoring-batch-state.json) so a poll-only night is legible to monitors
  // instead of just reporting processed: 0 with no explanation.
  const batchStatus = readBatchState();
  const progress = {
    pipeline: 'llm-ensemble-scoring',
    processed: processedSoFar,
    total: totalFiles,
    pct,
    skipped,
    errors,
    filesModified: filesModifiedCount,
    elapsedSeconds: elapsed,
    rateSecondsPerReview: parseFloat(rate) || 0,
    estimatedRemainingMinutes: typeof remaining === 'number' ? remaining : null,
    lastUpdated: timestamp,
    runId: process.env.GITHUB_RUN_ID || null,
    // Global counts across ALL review files (not just this batch/shard)
    // These are the authoritative numbers — local data/review-texts/ is gitignored
    // from the public repo, so only these counts are reliable after git pull.
    ...(globalCounts ? {
      globalTotalFiles: globalCounts.totalReviewFiles,
      globalScored: globalCounts.totalScored,
      globalUnscored: globalCounts.totalUnscored,
      globalSkipped: globalCounts.totalSkipped,
    } : {}),
    ...(batchStatus ? {
      batchInFlight: true,
      batchSubmittedAt: batchStatus.submittedAt,
      batchItemCount: batchStatus.itemCount,
    } : {})
  };
  try { fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2) + '\n'); } catch {}
}

// ========================================
// BATCH STATE (--batch resume, task #516)
// ========================================

/**
 * In-flight batch state is committed by gitCheckpoint(), so a runner that is
 * cancelled or times out mid-poll leaves its vendor batch IDs + manifest on
 * origin for the next scheduled run to resume from instead of resubmitting.
 *
 * Vendors expire a batch 24h after submission. Anything older than the grace
 * window below can no longer be fetched, and merging it would write model
 * output derived from days-old review text over whatever has happened since —
 * including scores a synchronous run wrote in the meantime. Expired state is
 * discarded loudly rather than merged. (task #516 ship-check)
 */
const BATCH_STATE_MAX_AGE_HOURS = 48;

function readProgressFile(): any {
  try {
    return JSON.parse(fs.readFileSync(SCORING_PROGRESS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function readBatchState(): BatchState | null {
  try {
    const batch = JSON.parse(fs.readFileSync(SCORING_BATCH_STATE_PATH, 'utf-8'));
    return batch && batch.submittedAt && Array.isArray(batch.manifest) ? (batch as BatchState) : null;
  } catch {
    return null;
  }
}

function batchStateAgeHours(batch: BatchState): number {
  const ms = Date.parse(batch.submittedAt);
  return Number.isFinite(ms) ? (Date.now() - ms) / 3_600_000 : Infinity;
}

function writeBatchState(batch: BatchState | null): void {
  try {
    if (batch) {
      fs.writeFileSync(SCORING_BATCH_STATE_PATH, JSON.stringify(batch, null, 2) + '\n');
    } else if (fs.existsSync(SCORING_BATCH_STATE_PATH)) {
      fs.unlinkSync(SCORING_BATCH_STATE_PATH);
    }
  } catch (e: any) {
    console.log(`   ⚠️ Failed to persist batch state: ${e.message}`);
  }
}

// ========================================
// GIT CHECKPOINT
// ========================================

/**
 * Commit and push scored review files as a checkpoint.
 * Only runs in CI (detects GITHUB_ACTIONS env var).
 * Returns true if checkpoint succeeded.
 */
function gitCheckpoint(processedSoFar: number, totalFiles: number): boolean {
  if (!process.env.GITHUB_ACTIONS) {
    return false; // Skip checkpoints in local runs
  }

  try {
    console.log(`\n📌 Checkpoint: committing ${processedSoFar}/${totalFiles} scored reviews...`);

    // The batch-state file must ride along or a cancelled runner's vendor batch
    // IDs never reach origin and the next scheduled run resubmits (double spend).
    execSync('git add data/collection-state/scoring-progress.json', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    try {
      execSync('git add -A data/collection-state/scoring-batch-state.json', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    } catch { /* file may not exist outside batch mode */ }

    // Check if there are staged changes
    try {
      execSync('git diff --staged --quiet', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      console.log('   No changes to commit, skipping checkpoint.');
      return true;
    } catch {
      // Non-zero exit = there ARE staged changes, proceed
    }

    execSync(
      `git commit -m "checkpoint: scored ${processedSoFar}/${totalFiles} reviews"`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' }
    );

    // Push through the shared helper (task #420). This replaced a hand-rolled
    // fetch → rebase → merge-fallback → 3-attempt loop that duplicated
    // push-with-retry.sh without any of its fixes: the explicit-destination
    // fetch refspec (#394), the single-timeout fetch (#464), HEAD preservation
    // (#543), and — the one that actually bit — the shallow depth bound (#466).
    // Both `git fetch origin main` calls here were unbounded, and this file
    // runs under opening-night-express.yml, which checks out at the default
    // fetch-depth: 1; from a shallow clone an unbounded fetch makes upload-pack
    // send the whole ~2.1 GB / 165k-commit repo instead of the small delta
    // (measured on a real runner, run 30218025467).
    const { ok, stderr } = pushWithRetry({ cwd: PROJECT_ROOT, branch: 'HEAD:main', retries: 3 });
    if (ok) {
      console.log('   ✓ Checkpoint pushed');
      return true;
    }
    console.log(`   ⚠️ Checkpoint push failed (will retry at next checkpoint): ${stderr.split('\n').slice(-3).join(' ')}`);
    return false;
  } catch (e: any) {
    console.log(`   ⚠️ Checkpoint error: ${e.message}`);
    return false;
  }
}

// ========================================
// CONTENT QUALITY TYPES
// ========================================

interface ContentQualityResult {
  quality: 'valid' | 'garbage' | 'suspicious';
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
}

interface GarbageSkipEntry {
  showId: string;
  outletId: string;
  filePath: string;
  quality: string;
  confidence: string;
  issues: string[];
  skippedAt: string;
}

// ========================================
// CLI PARSING
// ========================================

function parseArgs(): ScoringPipelineOptions & {
  calibrateOnly: boolean;
  validateOnly: boolean;
  ensemble: boolean;
  groundTruth: boolean;
  needsRescore: boolean;
  staleScores: boolean;
  outdated: boolean;
  forceFullRun: boolean;
  ensembleSource?: string;
  ensembleCalibrateOnly: boolean;
  upgradeEnsemble: boolean;
  retryEmergency: boolean;
  openaiModel: 'gpt-4o-mini' | 'gpt-4o' | 'gpt-5.4-mini';
  checkpointInterval: number;
  shard?: number;
  totalShards?: number;
  scoreRange?: [number, number];
  maxPromptVersion?: string;
  skipAlreadyAnchored: boolean;
  batch: boolean;
  batchPollMinutes: number;
} {
  const args = process.argv.slice(2);

  const showArg = args.find(a => a.startsWith('--show='));
  const showId = showArg ? showArg.split('=')[1] : undefined;

  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined;

  const rateLimitArg = args.find(a => a.startsWith('--rate-limit='));
  const rateLimitMs = rateLimitArg ? parseInt(rateLimitArg.split('=')[1]) : 100;

  const checkpointArg = args.find(a => a.startsWith('--checkpoint='));
  const checkpointInterval = checkpointArg ? parseInt(checkpointArg.split('=')[1]) : (process.env.GITHUB_ACTIONS ? 50 : 0);

  const shardArg = args.find(a => a.startsWith('--shard='));
  const shard = shardArg ? parseInt(shardArg.split('=')[1]) : undefined;

  const totalShardsArg = args.find(a => a.startsWith('--total-shards='));
  const totalShards = totalShardsArg ? parseInt(totalShardsArg.split('=')[1]) : undefined;

  const modelArg = args.find(a => a.startsWith('--model='));
  const modelChoice = modelArg ? modelArg.split('=')[1] : 'sonnet';
  const model = modelChoice === 'haiku'
    ? 'claude-3-5-haiku-20241022' as const
    : 'claude-sonnet-4-6' as const;

  const outdated = args.includes('--outdated');

  // Task #504 (2026-07-26): ensemble OpenAI leg model, overridable for the
  // gpt-4o vs gpt-5.4-mini A/B comparison. Default STAYS gpt-4o — the A/B
  // (n=24 real reviews) failed the rule-13 gate: Mixed bucket collapsed
  // 29%->0%, max bucket shift 29.2pp (limit 5pp). Pass --openai-model=gpt-5.4-mini
  // to experiment further once the V5 prompt is recalibrated for it.
  const { GPT4O } = require('../lib/models');
  const openaiModelArg = args.find(a => a.startsWith('--openai-model='));
  const openaiModel = (openaiModelArg ? openaiModelArg.split('=')[1] : GPT4O) as 'gpt-4o-mini' | 'gpt-4o' | 'gpt-5.4-mini';

  const ensembleSourceArg = args.find(a => a.startsWith('--ensemble-source='));
  const ensembleSource = ensembleSourceArg ? ensembleSourceArg.split('=')[1] : undefined;

  const scoreRangeArg = args.find(a => a.startsWith('--score-range='));
  const scoreRange = scoreRangeArg ? scoreRangeArg.split('=')[1].split('-').map(Number) as [number, number] : undefined;

  const maxPromptVersionArg = args.find(a => a.startsWith('--max-prompt-version='));
  const maxPromptVersion = maxPromptVersionArg ? maxPromptVersionArg.split('=')[1] : undefined;

  const upgradeEnsemble = args.includes('--upgrade-ensemble');
  const retryEmergency = args.includes('--retry-emergency');

  const rescoreReasonArg = args.find(a => a.startsWith('--rescore-reason='));
  const rescoreReason = rescoreReasonArg ? rescoreReasonArg.split('=').slice(1).join('=') : undefined;

  // Phase B-WE W1-T5: --max-cost=N circuit breaker. Matches
  // classify-non-reviews.js:84 convention. Default 0 = no cap.
  const maxCostArg = args.find(a => a.startsWith('--max-cost='));
  const maxCost = maxCostArg ? parseFloat(maxCostArg.split('=')[1]) : 0;

  // Phase B-WE ship-check fix: --skip-already-anchored flag. When set,
  // skip files where scoreSource is already 'anchored-v6' or 'llm-v6'.
  // Required for safe re-runs of W3 after a partial completion (e.g.,
  // --max-cost hit, network failure). Otherwise --rescore re-processes
  // every file and doubles cost. Default false to preserve existing
  // --rescore semantics for other workflows.
  const skipAlreadyAnchored = args.includes('--skip-already-anchored');

  // Task #516: --batch routes every model call through the vendor Batch APIs
  // (Anthropic Message Batches / OpenAI Batches / Gemini batch mode) at a 50%
  // discount, at the cost of submit-now/poll-later latency. Scheduled nightly
  // runs use it; opening-night workflow_dispatch/chain runs stay synchronous
  // because latency is the whole point there.
  const batch = args.includes('--batch');
  const batchPollArg = args.find(a => a.startsWith('--batch-poll-minutes='));
  const batchPollMinutes = batchPollArg ? parseInt(batchPollArg.split('=')[1]) : 20;

  return {
    showId,
    unscoredOnly: !args.includes('--rescore') && !args.includes('--needs-rescore') && !outdated && !ensembleSource && !args.includes('--stale-scores') && !upgradeEnsemble && !retryEmergency,
    minTextLength: 50,
    model,
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    limit,
    rateLimitMs,
    runCalibration: args.includes('--calibrate'),
    runValidation: args.includes('--validate'),
    calibrateOnly: args.includes('--calibrate-only'),
    validateOnly: args.includes('--validate-only'),
    ensemble: args.includes('--ensemble'),
    groundTruth: args.includes('--ground-truth'),
    needsRescore: args.includes('--needs-rescore'),
    staleScores: args.includes('--stale-scores'),
    outdated,
    forceFullRun: args.includes('--force-full-run'),
    ensembleSource,
    ensembleCalibrateOnly: args.includes('--ensemble-calibrate'),
    upgradeEnsemble,
    retryEmergency,
    openaiModel,
    checkpointInterval,
    shard,
    totalShards,
    scoreRange,
    maxPromptVersion,
    rescoreReason,
    maxCost,
    skipAlreadyAnchored,
    batch,
    batchPollMinutes
  };
}

// ========================================
// FILE OPERATIONS
// ========================================

/**
 * Get all review text files
 */
function getAllReviewFiles(showId?: string, showIds?: string[]): Array<{ path: string; data: ReviewTextFile }> {
  const files: Array<{ path: string; data: ReviewTextFile }> = [];

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    return files;
  }

  const shows = showIds
    ? showIds
    : showId
    ? [showId]
    : fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
        const fullPath = path.join(REVIEW_TEXTS_DIR, f);
        // Skip symlinks to avoid processing the same directory twice
        if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
        return fs.statSync(fullPath).isDirectory();
      });

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    if (!fs.existsSync(showDir)) continue;

    const reviewFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

    for (const file of reviewFiles) {
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReviewTextFile;
        files.push({ path: filePath, data });
      } catch {
        // Skip malformed files
      }
    }
  }

  return files;
}

/**
 * Save scored review file — clears stale failure flags before writing (Pattern Card #1).
 */
function saveReviewFile(filePath: string, data: any): void {
  clearFailureFlags(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  filesModifiedCount++;
}

/**
 * Stamp a file for the head-of-line blocking fix (Notion 3ad637c5-416f-8169)
 * — shared by every failure path that can produce a deterministic text-gate
 * rejection: the live scoring loop, --batch submission prep, and --batch
 * resume prep.
 *
 * Deliberately gates on the error STRING PREFIX, not the inputValidationFailed
 * boolean. Both real gate sites (scorer.ts, ensemble-scorer.ts) stamp their
 * error as `input_validation_failed:${reason}` — a pure function of the text.
 * ensemble-scorer.ts also sets inputValidationFailed:true on its POST-LLM
 * hallucinated_score refusal (`error: 'hallucinated_score: ...'`), which is
 * NOT deterministic — it depends on stochastic model reasoning about text
 * that already passed the length/nav-chrome gates, so a retry can legitimately
 * succeed. Gating on the boolean would permanently exclude those files from
 * --needs-rescore (the text they'd be fingerprinted against never changes).
 * The prefix check catches only the two real gates.
 */
function maybeStampBlockedRescore(filePath: string, error: string | undefined, dryRun: boolean): void {
  if (dryRun) return;
  if (!isDeterministicTextGateFailure(error)) return;
  const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  stampTerminalScoringFailure(fileData, error as string);
  saveReviewFile(filePath, fileData);
}

/**
 * Persist a Haiku-fallback failure on a manually-cleared file. Without this,
 * a file whose fallback score fails leaves ZERO state on disk — the next run
 * (and every run after) re-attempts the full ensemble + fallback from
 * scratch on the same file forever, burning API credits with no progress
 * (P1 352637c5-416f-81ab). isInFallbackCooldown() reads these fields to skip
 * re-processing until the backoff window elapses.
 */
const MANUAL_CLEAR_FALLBACK_MAX_ATTEMPTS = 5;

function recordManualClearFallbackFailure(filePath: string, fileData: any, reason: string): void {
  fileData.manualClearFallbackFailedAt = new Date().toISOString();
  fileData.manualClearFallbackFailureReason = String(reason).substring(0, 300);
  fileData.manualClearFallbackAttempts = (fileData.manualClearFallbackAttempts || 0) + 1;
  // Codex adversarial review (P1 352637c5-416f-81ab ship-check): the linear
  // backoff never terminates — a permanently-failing file would retry every
  // 7 days forever. Cap at MAX_ATTEMPTS and mark abandoned so it stops
  // auto-retrying and surfaces for manual review instead, mirroring the
  // serpDiscoveryAbandoned terminal state in review-guards.js.
  if (fileData.manualClearFallbackAttempts >= MANUAL_CLEAR_FALLBACK_MAX_ATTEMPTS) {
    fileData.manualClearFallbackAbandoned = true;
  }
  saveReviewFile(filePath, fileData);
}

/**
 * Save run summary
 */
function saveRunSummary(summary: PipelineRunSummary): void {
  let runs: PipelineRunSummary[] = [];

  if (fs.existsSync(RUNS_LOG_PATH)) {
    try {
      runs = JSON.parse(fs.readFileSync(RUNS_LOG_PATH, 'utf-8'));
    } catch {
      runs = [];
    }
  }

  runs.push(summary);

  // Keep only last 100 runs
  if (runs.length > 100) {
    runs = runs.slice(-100);
  }

  fs.writeFileSync(RUNS_LOG_PATH, JSON.stringify(runs, null, 2) + '\n');
}

// ========================================
// MAIN PIPELINE
// ========================================

async function main(): Promise<void> {
  const options = parseArgs();

  // Handle calibrate-only and validate-only modes
  if (options.calibrateOnly) {
    runCalibration(true);
    return;
  }

  if (options.validateOnly) {
    runValidation(true);
    return;
  }

  // Handle ensemble-calibrate mode
  if (options.ensembleCalibrateOnly) {
    console.log('=== Ensemble Calibration Analysis ===\n');
    const result = runEnsembleCalibration(true);
    if (result) {
      // Save results
      const outputPath = path.join(__dirname, '../../data/ensemble-calibration.json');
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
      console.log(`\nResults saved to: ${outputPath}`);
    }
    return;
  }

  // Handle ground-truth calibration mode
  if (options.groundTruth) {
    const projectRoot = path.join(__dirname, '../..');
    const reviewsJsonPath = path.join(projectRoot, 'data/reviews.json');
    const reviewTextsDir = path.join(projectRoot, 'data/review-texts');

    console.log('Finding ground truth reviews (with numeric ratings)...');
    const groundTruth = findGroundTruthReviews(reviewsJsonPath, reviewTextsDir);
    console.log(`Found ${groundTruth.length} reviews with numeric ratings\n`);

    const result = calculateGroundTruthCalibration(groundTruth, options.ensemble);
    printGroundTruthReport(result);

    // Save results
    const outputPath = path.join(projectRoot, 'data/ground-truth-calibration.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\nResults saved to ${outputPath}`);
    return;
  }

  // Check for API keys
  const claudeApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;

  if (!claudeApiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts [options]');
    process.exit(1);
  }
  // Post-guard non-optional alias. The `process.exit` narrowing above does not
  // reach into the nested handleScoringResult() closure (task #516 moved the
  // Haiku-fallback ReviewScorer construction there), so strictNullChecks —
  // which scripts/llm-scoring/tsconfig.json turns ON for the CI gate, unlike
  // the parent scripts/tsconfig.json — sees `string | undefined` at that call.
  const claudeApiKeyChecked: string = claudeApiKey;

  if (options.ensemble && !openaiApiKey) {
    console.error('Error: OPENAI_API_KEY environment variable required for ensemble mode');
    console.error('Usage: ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npx ts-node scripts/llm-scoring/index.ts --ensemble');
    process.exit(1);
  }

  // Initialize scorer (single or ensemble)
  let scorer: ReviewScorer | EnsembleReviewScorer;

  if (options.ensemble) {
    scorer = new EnsembleReviewScorer(claudeApiKey, openaiApiKey!, geminiApiKey, openrouterApiKey, {
      claudeModel: options.model,
      openaiModel: options.openaiModel,
      geminiModel: 'gemini-2.5-flash',
      kimiModel: 'moonshotai/kimi-k2.5',
      verbose: options.verbose
    });
    const modelCount = (scorer as EnsembleReviewScorer).getModelCount();
    if (modelCount === 4) {
      console.log(`Using 4-MODEL ensemble mode (Claude Sonnet + ${options.openaiModel} + Gemini 2.5 Flash + Kimi K2.5)\n`);
    } else if (modelCount === 3) {
      console.log(`Using 3-MODEL ensemble mode (Claude Sonnet + ${options.openaiModel} + Gemini 2.5 Flash)\n`);
      if (!openrouterApiKey) {
        console.log('  (Set OPENROUTER_API_KEY to enable 4-model mode with Kimi K2.5)\n');
      }
    } else {
      console.log(`Using 2-MODEL ensemble mode (Claude Sonnet + ${options.openaiModel})\n`);
      if (!geminiApiKey) {
        console.log('  (Set GEMINI_API_KEY to enable 3-model mode)\n');
      }
    }
  } else {
    scorer = new ReviewScorer(claudeApiKey, {
      model: options.model,
      verbose: options.verbose
    });
  }

  // Sprint 3 (Phase B): announce anchored-bands mode if flag is set. Detection
  // happens per-review inside EnsembleReviewScorer.scoreReviewFile; this log
  // surfaces the mode at startup so CI logs / operators can confirm.
  if (process.env.ANCHORED_BANDS_PILOT === '1') {
    console.log('🎯 Anchored bands ENABLED (V6 prompt + band clamp; high-rel star/grade reviews score within [floor, ceiling]).\n');
  }

  // Get review files
  // Support comma-separated show IDs: --show=foo,bar,baz
  const showIds = options.showId?.includes(',') ? options.showId.split(',') : undefined;
  const allFiles = getAllReviewFiles(showIds ? undefined : options.showId, showIds);

  if (allFiles.length === 0) {
    console.log('No review files found.');
    if (options.showId) {
      console.log(`Check if show directory exists: ${path.join(REVIEW_TEXTS_DIR, options.showId)}`);
    }
    return;
  }

  // Pre-load show titles so isScoreable() can activate the wrongShow stale-flag
  // override (predicate needs show.title; falls back safely when undefined).
  // Reused later for assessTextQuality (line ~870). Notion 34e637c5-416f-8121.
  const showTitles = loadShowTitles();
  const showFor = (d: any): { title: string } | undefined => {
    const title = d.showId ? showTitles.get(d.showId) : undefined;
    return title ? { title } : undefined;
  };

  // Filter based on mode
  let filesToProcess: typeof allFiles;
  if (options.needsRescore) {
    // Filter to reviews flagged for rescoring (had excerpt-based score, now have fullText)
    let blockedSkipped = 0;
    filesToProcess = allFiles.filter(f => {
      if ((f.data as any).needsRescore !== true) return false;
      if (!isScoreable(f.data as any, showFor(f.data as any), f.path)) return false;
      // Head-of-line blocking fix (Notion 3ad637c5-416f-8169): a file that
      // already failed a deterministic text-gate check (body_too_short etc.)
      // with the SAME fullText will fail identically again. Skip it so the
      // capped drain reaches the scoreable tail instead of re-spending 3-model
      // API cost on the same unscoreable head every run. A later fullText
      // change (recovered/re-scraped text) clears this automatically — see
      // isBlockedFromRescore in scripts/lib/rescore-lifecycle.js.
      if (isBlockedFromRescore(f.data as any)) {
        blockedSkipped++;
        return false;
      }
      // Optional: filter by specific rescoreReason (enables parallel runs for different reasons)
      if (options.rescoreReason) {
        const reason = (f.data as any).rescoreReason || '';
        return reason.startsWith(options.rescoreReason);
      }
      return true;
    });
    if (blockedSkipped > 0) {
      console.log(`Skipping ${blockedSkipped} reviews blocked by a prior terminal text-gate failure (fullText unchanged since)\n`);
    }
    console.log(`Filtering to reviews flagged for rescoring${options.rescoreReason ? ` (reason: "${options.rescoreReason}")` : ''}: ${filesToProcess.length} reviews\n`);
  } else if (options.outdated) {
    // Filter to reviews scored with an older prompt version
    filesToProcess = allFiles.filter(f => {
      const meta = (f.data as any).llmMetadata;
      if (!meta || !meta.promptVersion) return false;
      return compareSemver(meta.promptVersion, PROMPT_VERSION) < 0;
    });
    console.log(`Filtering to outdated reviews (promptVersion < ${PROMPT_VERSION}): ${filesToProcess.length} reviews\n`);
  } else if (options.ensembleSource) {
    // Filter to reviews with a specific ensemble source (e.g. two-model-fallback)
    filesToProcess = allFiles.filter(f => {
      const source = (f.data as any).ensembleData?.ensembleSource;
      return source === options.ensembleSource;
    });
    console.log(`Filtering to reviews with ensembleSource="${options.ensembleSource}": ${filesToProcess.length} reviews\n`);
  } else if (options.staleScores) {
    // Filter to reviews with fullText + old score that was likely based on excerpt
    filesToProcess = allFiles.filter(f => {
      const d = f.data as any;
      if (!d.fullText || d.fullText.length < 1000) return false;
      if (!d.llmScore?.score) return false;
      if (d.needsRescore || d.ensembleData || d.rescoreCompletedAt) return false;
      // Modern scores with textSource provenance: only rescore if scored on excerpt
      if (d.llmMetadata?.textSource?.type === 'fullText') return false;
      // Old scores without provenance: require excerpt field as indicator
      return hasAnyExcerptField(d);
    });
    console.log(`Filtering to stale-scored reviews (fullText + old excerpt-based score): ${filesToProcess.length} reviews\n`);
  } else if (options.upgradeEnsemble) {
    // Filter to reviews with old single-model llmScore but no ensemble scoring
    // Exclude quality-flagged reviews (same pre-filter as scoring pipeline)
    filesToProcess = allFiles.filter(f => {
      const d = f.data as any;
      if (!d.llmScore || d.ensembleData) return false;
      if (!isScoreable(d, showFor(d), f.path)) return false;
      return true;
    });
    console.log(`Filtering to single-model reviews needing ensemble upgrade: ${filesToProcess.length} reviews\n`);
  } else if (options.retryEmergency) {
    // Filter to reviews stuck with singleModelEmergency that haven't been auto-retried yet.
    // One retry per stuck review; if Gemini was down at the original scoring time and is
    // back up now, the retry produces a 2-of-N+ ensemble and the flag clears naturally.
    // If still single-model after retry, retryCount=1 sticks and the predicate excludes it
    // from future auto-retries (human review takes over).
    filesToProcess = allFiles.filter(f => {
      const d = f.data as any;
      const ed = d.ensembleData;
      if (!ed || !ed.singleModelEmergency) return false;
      if ((ed.singleModelEmergencyRetryCount || 0) >= 1) return false;
      if (!isScoreable(d, showFor(d), f.path)) return false;
      return true;
    });
    console.log(`Filtering to stuck-emergency reviews for one-shot retry: ${filesToProcess.length} reviews\n`);
  } else if (options.unscoredOnly) {
    // Filter to unscored reviews
    filesToProcess = allFiles.filter(f => !(f.data as any).llmScore);
  } else {
    filesToProcess = allFiles;
  }

  // Additional filter: score range (can combine with --outdated or --rescore)
  if (options.scoreRange) {
    const [minScore, maxScore] = options.scoreRange;
    const before = filesToProcess.length;
    filesToProcess = filesToProcess.filter(f => {
      const score = (f.data as any).llmScore?.score;
      return score != null && score >= minScore && score <= maxScore;
    });
    console.log(`Filtering to score range ${minScore}-${maxScore}: ${filesToProcess.length} reviews (from ${before})\n`);
  }

  // Additional filter: max prompt version (only process reviews scored with version <= this)
  if (options.maxPromptVersion) {
    const before = filesToProcess.length;
    filesToProcess = filesToProcess.filter(f => {
      const meta = (f.data as any).llmMetadata;
      if (!meta || !meta.promptVersion) return false; // exclude unversioned
      return compareSemver(meta.promptVersion, options.maxPromptVersion!) <= 0;
    });
    console.log(`Filtering to promptVersion <= ${options.maxPromptVersion}: ${filesToProcess.length} reviews (from ${before})\n`);
  }

  // Track garbage skips for logging
  const garbageSkips: GarbageSkipEntry[] = [];

  // showTitles is loaded above (line ~776) for the isScoreable wrongShow gate;
  // assessTextQuality reuses it for show-mention validation.

  // Helper to get scorable text (fullText or excerpts)
  // Uses the full content-quality module for comprehensive garbage detection
  const getScorableText = (data: ReviewTextFile, filePath: string): string | null => {
    // Check fullText first (but not if it's garbage)
    if (data.fullText && data.fullText.length >= 100) {
      // Use the comprehensive content-quality module for garbage detection
      const showTitle = showTitles.get(data.showId) || undefined;
      const qualityCheck: ContentQualityResult = assessTextQuality(data.fullText, data.showId, showTitle);

      if (qualityCheck.quality === 'garbage') {
        // Log and track the skip
        if (options.verbose) {
          console.log(`  Skipping garbage fullText: ${qualityCheck.issues.join(', ')}`);
        }
        garbageSkips.push({
          showId: data.showId || 'unknown',
          outletId: data.outletId || 'unknown',
          filePath,
          quality: qualityCheck.quality,
          confidence: qualityCheck.confidence,
          issues: qualityCheck.issues,
          skippedAt: new Date().toISOString()
        });
        // Fall through to excerpts
      } else if (qualityCheck.quality === 'suspicious' && qualityCheck.confidence === 'high') {
        // Also skip high-confidence suspicious content
        if (options.verbose) {
          console.log(`  Skipping suspicious fullText: ${qualityCheck.issues.join(', ')}`);
        }
        garbageSkips.push({
          showId: data.showId || 'unknown',
          outletId: data.outletId || 'unknown',
          filePath,
          quality: qualityCheck.quality,
          confidence: qualityCheck.confidence,
          issues: qualityCheck.issues,
          skippedAt: new Date().toISOString()
        });
        // Fall through to excerpts
      } else {
        // Text is valid or low-suspicion - use it
        return data.fullText;
      }
    }

    // Fall back to excerpts (multi-show reviews with garbage fullText use excerpts directly — no trimming needed)
    if (data.isMultiShowReview && options.verbose) {
      console.log(`  Multi-show review falling back to excerpts (fullText was garbage/missing)`);
    }
    // Build deduped excerpt string from all sources (uses canonical EXCERPT_FIELDS)
    const excerpts: string[] = [];
    for (const field of EXCERPT_FIELDS) {
      const val = data[field];
      if (val && !excerpts.some(e => e === val)) {
        excerpts.push(val);
      }
    }

    if (excerpts.length > 0) {
      const combined = excerpts.join('\n\n');
      if (combined.length >= options.minTextLength) {
        return combined;
      }
    }

    return null;
  };

  // Pre-filter: skip reviews already flagged as unscorable
  // Pre-filter: skip reviews flagged as unscorable (uses shared isScoreable utility)
  // Per-file rejection logging added after Titanique postmortem ("0 valid files" with no explanation)
  let dataQualitySkipped = 0;
  let starRatingSkipped = 0;
  let fallbackCooldownSkipped = 0;
  let showNotMentionedWithExcerpts = 0;
  const scorableFiles = filesToProcess.filter(f => {
    const d = f.data as any;
    // Skip files whose manually-cleared Haiku fallback failed recently — without
    // this, the same file re-runs the full ensemble + fallback on every scoring
    // pass forever with no progress (P1 352637c5-416f-81ab).
    if (isInFallbackCooldown(d)) {
      fallbackCooldownSkipped++;
      return false;
    }
    // Skip reviews where the page itself published an explicit star rating that
    // a human extracted into assignedScore. The star rating is authoritative —
    // running an ensemble can only INTRODUCE singleModelEmergency by overriding
    // the score with an LLM read of partial/paywalled text. (Innocence 2026-04-27:
    // Bachtrack 4★ + NYSR 5★ silently excluded after ensemble override.)
    if (
      d.assignedScore != null &&
      d.scoreSource === 'manual_extracted_star_rating' &&
      !options.needsRescore &&
      !options.outdated
    ) {
      starRatingSkipped++;
      return false;
    }
    if (!isScoreable(d, showFor(d), f.path)) {
      dataQualitySkipped++;
      // Log the specific reason for rejection
      const reasons: string[] = [];
      if (d.duplicateOf) reasons.push(`duplicateOf=${d.duplicateOf}`);
      if (d.wrongShow) reasons.push('wrongShow');
      if (d.wrongProduction) reasons.push('wrongProduction');
      if (d.wrongAttribution) reasons.push('wrongAttribution');
      if (d.contentTier === 'invalid') reasons.push('contentTier=invalid');
      if (d.incompleteReason === 'scraper_garbage') reasons.push('scraper_garbage');
      // Mirror is-scoreable.ts: stale-flag exemption for individual-review URLs
      // means the file is scoreable even with isRoundupArticle=true on disk.
      if (d.isRoundupArticle && !require('../lib/review-guards').isLikelyStaleRoundupFlag(d)) reasons.push('isRoundupArticle');
      if (d.rejectionReason) reasons.push(`rejectionReason=${d.rejectionReason}`);
      if (d.showNotMentioned) reasons.push('showNotMentioned-no-excerpts');
      if (d.fullTextWrongAuthor) reasons.push('fullTextWrongAuthor-no-excerpts');
      console.log(`  [SKIP] ${f.path}: ${reasons.join(', ') || 'unknown'}`);
      return false;
    }
    // Count showNotMentioned reviews that passed (have valid excerpts)
    if (d.showNotMentioned) {
      showNotMentionedWithExcerpts++;
    }
    return true;
  });
  if (dataQualitySkipped > 0) {
    console.log(`Skipped ${dataQualitySkipped} reviews (duplicateOf/wrongShow/wrongProduction/wrongAttribution/multiShow/roundup/showNotMentioned-no-excerpts/invalid)\n`);
  }
  if (starRatingSkipped > 0) {
    console.log(`Skipped ${starRatingSkipped} reviews with manual_extracted_star_rating (page-published star rating is authoritative)\n`);
  }
  if (fallbackCooldownSkipped > 0) {
    console.log(`Skipped ${fallbackCooldownSkipped} reviews still in manual-clear-fallback cooldown (retry after backoff window)\n`);
  }
  if (showNotMentionedWithExcerpts > 0) {
    console.log(`Including ${showNotMentionedWithExcerpts} showNotMentioned reviews with valid aggregator excerpts\n`);
  }

  // Apply text length filter - now includes reviews with excerpts
  let textTooShortSkipped = 0;
  const validFilesUnsorted = scorableFiles.filter(f => {
    if (getScorableText(f.data, f.path) !== null) return true;
    textTooShortSkipped++;
    const textLen = ((f.data as any).fullText || '').length;
    console.log(`  [SKIP] ${f.path}: text too short (fullText=${textLen} chars, no valid excerpts)`);
    return false;
  });
  if (textTooShortSkipped > 0) {
    console.log(`Skipped ${textTooShortSkipped} reviews with insufficient text\n`);
  }

  // Prioritize: full-text first, open shows first, newer shows first
  const showPriority = loadShowPriority();
  const validFiles = prioritizeReviews(validFilesUnsorted, showPriority);
  const fullTextCount = validFiles.filter(f => !!(f.data as any).fullText && (f.data as any).fullText.length >= 200).length;
  console.log(`Priority sort: ${fullTextCount} full-text reviews first, then ${validFiles.length - fullTextCount} excerpt-only\n`);

  // Apply sharding (split work across parallel runs)
  let shardedFiles = validFiles;
  if (options.shard !== undefined && options.totalShards && options.totalShards > 1) {
    shardedFiles = validFiles.filter((_, i) => i % options.totalShards! === options.shard!);
    console.log(`Shard ${options.shard}/${options.totalShards}: ${shardedFiles.length} files (from ${validFiles.length} valid)\n`);
  }

  // Apply limit
  const finalFiles = options.limit
    ? shardedFiles.slice(0, options.limit)
    : shardedFiles;

  // Summary
  console.log('=== LLM Review Scoring Pipeline ===\n');
  console.log(`Model: ${options.model}`);
  console.log(`Total review files: ${allFiles.length}`);
  console.log(`Unscored files: ${filesToProcess.length}`);
  console.log(`Valid files (text >= ${options.minTextLength} chars): ${validFiles.length}`);
  if (options.shard !== undefined) console.log(`Shard: ${options.shard}/${options.totalShards}`);
  console.log(`Files to process: ${finalFiles.length}`);
  if (options.checkpointInterval && options.checkpointInterval > 0 && !options.dryRun) {
    console.log(`Checkpoint: every ${options.checkpointInterval} reviews (git commit+push)`);
  }
  if (options.dryRun) console.log('DRY RUN - no files will be modified\n');
  console.log('');

  // Process files
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let garbageSkipped = 0;
  let suspiciousWarnings = 0;
  // Lazy single-model Haiku scorer used when ensemble rejects a manually-cleared
  // file (otherwise the file lands in 'manually-cleared but unscored' limbo —
  // SKIP-REJECT correctly suppresses the rejection write but used to also skip
  // scoring entirely. Discovered 2026-05-01 with Operawire/Eugene-Onegin and
  // NYCR/La-Traviata, where the ensemble repeatedly rejected as wrong_show
  // despite human verification — files needed manual Haiku scoring to land.
  // Instantiated once per run only when first triggered, to avoid wasting a
  // client object on runs where the path is never hit.
  let manualClearFallbackScorer: ReviewScorer | null = null;

  // Write initial progress
  writeProgress(0, finalFiles.length, 0, 0, startTime);
  const errorDetails: Array<{ showId: string; outletId: string; error: string }> = [];
  // Note: garbageSkips is declared earlier and shared with getScorableText()

  // Phase B-WE W1-T5: --max-cost circuit breaker. Sample cumulative token
  // usage before/after each scoreReviewFile to compute per-call delta and
  // accumulate. When cumulative cost >= maxCost (CLI arg, 0 = unlimited),
  // abort cleanly. Matches stats.budgetUsed convention from
  // classify-non-reviews.js:84.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { estimateCost: __estimateCost } = require('./cost');
  const maxCost: number = (options as any).maxCost || 0;
  const skipAlreadyAnchored: boolean = (options as any).skipAlreadyAnchored === true;
  let budgetUsed = 0;
  let budgetAborted = false;

  // Phase B-WE ship-check fix P0-2: --max-cost requires --ensemble shape.
  // ReviewScorer (single) returns flat {input, output, total}; the delta
  // tracking below expects {claude, openai, gemini, kimi}. Mismatched shape
  // would silently yield $0 per call and the cap never fires.
  if (maxCost > 0 && !options.ensemble) {
    console.log(`\n⛔ --max-cost requires --ensemble (single-scorer mode lacks per-model token shape). Aborting.\n`);
    process.exit(2);
  }

  if (maxCost > 0) {
    console.log(`\n💰 Budget cap: $${maxCost.toFixed(2)} (--max-cost). Per-call cost tracked from token deltas.\n`);
  }
  if (skipAlreadyAnchored) {
    console.log(`\n🔁 --skip-already-anchored: files with scoreSource='anchored-v6' or 'llm-v6' will be skipped for safe re-run.\n`);
  }

  /**
   * Everything that happens to a scoring result AFTER the models have
   * spoken: scoreability-rejection routing (wrongShow / wrongProduction /
   * contentTier), the manually-cleared Haiku rescue, needsRescore clearing,
   * singleModelEmergency retry bookkeeping, post-scoring garbage-reasoning
   * detection, and the file write + stage-latency emit.
   *
   * Extracted verbatim from the per-file loop (task #516) so --batch feeds
   * its merged results through the IDENTICAL post-processing. This block has
   * accumulated a decade of incident-driven carve-outs; forking it for batch
   * mode would have been the single largest correctness risk in this change.
   *
   * Returns TRUE where the original inline block did `continue` — the caller
   * must then skip the rest of the loop iteration. That is not cosmetic: the
   * loop tail runs the --max-cost token accounting, the rate-limit sleep and
   * the `processed % checkpointInterval === 0` git checkpoint. Because a
   * rejected/skipped file does not increment `processed`, letting it fall
   * through would re-fire gitCheckpoint (commit + fetch + rebase + push to the
   * public repo) on EVERY subsequent rejection once `processed` sits on a
   * multiple of the interval, and would start charging rejection-path tokens
   * against the budget cap. Both are sync-path regressions, so the signal is
   * plumbed rather than dropped.
   */
  async function handleScoringResult(
    result: ScoreReviewFileResult,
    filePath: string,
    reviewFile: ReviewTextFile,
    priorEmergencyRetryCount: number
  ): Promise<boolean> {

    // Handle scoreability rejection (v5.2+)
    if (result.success && (result as any).rejected) {
      const rejection = (result as any).rejection as string;
      const rejectionReasoning = (result as any).rejectionReasoning as string;

      if (!options.dryRun) {
        const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        // Skip rejection write if a human has manually cleared wrongProduction.
        // Discovered 2026-04-22 (Notion 34b637c5-416f-81ff-a6d6-d453e7ed537c):
        // the ensemble rejected 4 audit B-class false-positive clears because the
        // scoreability-check prompt told the LLM the market was Broadway even for
        // WE shows. Without this carve-out, re-running llm-scoring after a manual
        // clear would re-set rejectedAt/rejectedBy and the downstream
        // isIncludableForRebuild rejectedAt guard would exclude them again.
        // The guard at scripts/lib/review-guards.js also respects these flags as
        // belt-and-suspenders, so dropping this write just avoids churn and
        // preserves the human verdict as the source of truth.
        // Also covers `wrong_show`: human-verified correct production implies correct
        // show — the 2026-04-22 Giant case surfaced a second round where the LLM
        // re-rejected with wrong_show ("Mark Rosenblatt play, not the musical I know")
        // despite wrong_production being manually cleared. Treating both rejection
        // types symmetrically matches the isIncludableForRebuild guard at
        // scripts/lib/review-guards.js.
        // Combined reviews (joint NYer/Variety pieces covering 2+ shows) are
        // expected to fail wrong_show on the half of the article about the
        // OTHER show. Treat them like manually-cleared so the Haiku fallback
        // scores the trimmed section instead of leaving the file in
        // "rejected but no score" limbo. Issue #316 ship-check (P0/B).
        const manuallyCleared =
          fileData.wrongProductionManualClear === true ||
          fileData.wrongProductionOverride === true ||
          fileData.wrongShowManualClear === true ||
          fileData.wrongShowOverride === true ||
          fileData.humanReviewedWrongProduction === false ||
          fileData.isCombinedReview === true ||
          // Aliases for sweep scripts that historically wrote the `Cleared`
          // suffix instead of `ManualClear` — discovered 2026-05-01 when 4
          // opera sweeps used the wrong field name and the gate silently
          // re-flagged every cycle. Treating both suffixes as equivalent
          // closes the gap without requiring every sweep to be migrated.
          // Notion 362637c5-416f-8142-a088-f44f0cdaa98b.
          fileData.wrongProductionCleared === true ||
          fileData.wrongShowCleared === true;
        if (manuallyCleared && (rejection === 'wrong_production' || rejection === 'wrong_show')) {
          console.log(`SKIP-REJECT (${rejection} on manually-cleared file): ${rejectionReasoning?.substring(0, 80) || ''}`);
          // Fallback: a human has verified this file matches the show, but the
          // ensemble still rejected it — score the text directly with a single
          // Haiku call so the file lands in reviews.json instead of staying in
          // 'manually-cleared but unscored' limbo. (2026-05-01 Eugene Onegin /
          // La Traviata opera incident — required manual rescue with Haiku.)
          if (!manualClearFallbackScorer) {
            manualClearFallbackScorer = new ReviewScorer(claudeApiKeyChecked, {
              // claude-3-5-haiku-20241022 deprecated 2026-02-19; bumped to
              // current Haiku 4.5 (2026-05-17 root fix per Notion
              // 363637c5-416f-81cc-8240-c48df8b4cfd2). With opera-aware
              // input-builder this fallback should rarely fire, but keep
              // it on a non-deprecated model so the rescue actually works.
              model: 'claude-haiku-4-5-20251001',
              verbose: false,
            });
          }
          try {
            const fbResult = await manualClearFallbackScorer.scoreReviewFile(reviewFile);
            if (fbResult.success && fbResult.scoredFile) {
              const scoredAny = fbResult.scoredFile as any;
              if (scoredAny.llmScore) {
                scoredAny.llmScore.reasoning =
                  '[manual-cleared Haiku fallback] ' + (scoredAny.llmScore.reasoning || '');
              }
              scoredAny.scoreSource = 'manual-cleared-haiku-fallback';
              scoredAny.scoreSourceReason =
                `ensemble rejected as ${rejection} but file is human-cleared via wrongProductionManualClear/wrongShowManualClear; Haiku single-model scored the text directly`;
              scoredAny.scoredAt = new Date().toISOString();
              // Retire the rescore queue entry here too. Without this the file
              // scores successfully but stays needsRescore:true and is re-scored
              // by EVERY subsequent drain (2026-07-26). See scripts/lib/rescore-lifecycle.js.
              markRescoreComplete(scoredAny);
              if (!options.dryRun) saveReviewFile(filePath, scoredAny);
              console.log(`  ✓ FALLBACK SCORED (Haiku): ${scoredAny.assignedScore} (${scoredAny.llmScore?.bucket})`);
              processed++;
              return true;
            }
            console.log(`  ⚠ Haiku fallback did not produce a score: ${fbResult.error || 'unknown'}`);
            recordManualClearFallbackFailure(filePath, fileData, fbResult.error || 'no_score_produced');
          } catch (e: any) {
            console.log(`  ⚠ Haiku fallback exception: ${e.message}`);
            recordManualClearFallbackFailure(filePath, fileData, e.message);
          }
          skipped++;
          return true;
        }

        // Route rejection to appropriate flags
        // Off-Broadway shows are exempt from wrongProduction flagging:
        // OB shows commonly transfer from regional/fringe theaters, so LLM often
        // misidentifies the production as "wrong" when it's actually correct.
        // WE shows now get market+venue context in the prompt (2026-04-13), so the
        // LLM can correctly distinguish Broadway vs West End productions.
        const showInfo = showPriority.get(reviewFile.showId || '');
        // Off-Broadway and regional productions both draw false wrong_production
        // verdicts for the same reason: reviews legitimately describe a non-Broadway
        // house the model does not expect. Regional joins the carve-out after the
        // Family Album rejection (2026-07-30) — the prompt fix upstream is the real
        // repair, this is the belt-and-suspenders layer if a prompt regresses.
        const isExemptFromWrongProduction =
          showInfo?.category === 'off-broadway' || showInfo?.category === 'regional';
        if (rejection === 'wrong_show') {
          // Combined reviews are excluded from manuallyCleared above and
          // would normally hit this branch — but a joint review should NOT
          // get wrongShow:true on the half about the other show. The
          // manuallyCleared carve-out routes them to the Haiku fallback.
          // This guard is belt-and-suspenders: if execution somehow lands
          // here for a combined review (e.g. config drift), don't churn
          // wrongShow:true on every poller pass. Issue #316 ship-check
          // (P0/A).
          if (fileData.isCombinedReview === true) {
            console.log(` (combined review — skipping wrongShow flag write)`);
          } else {
            fileData.wrongShow = true;
          }
        } else if (rejection === 'wrong_production' && !isExemptFromWrongProduction) {
          fileData.wrongProduction = true;
        } else if (rejection === 'wrong_production' && isExemptFromWrongProduction) {
          console.log(` (${showInfo?.category} exempt — skipping wrongProduction flag)`);
        } else if (rejection === 'not_a_review') {
          fileData.contentTier = 'invalid';
        } else if (rejection === 'garbage_text') {
          fileData.contentTier = 'needs-rescrape';
        }

        fileData.rejectedAt = new Date().toISOString();
        fileData.rejectedBy = 'ensemble-scoreability-check';
        fileData.rejectionReason = rejection;
        fileData.rejectionReasoning = rejectionReasoning;
        fileData.promptVersion = PROMPT_VERSION;
        saveReviewFile(filePath, fileData);
      }

      console.log(`REJECTED (${rejection}): ${(result as any).rejectionReasoning?.substring(0, 80) || ''}`);
      skipped++;
      return true;
    }

    if (result.success && result.scoredFile) {
      // Always clear needsRescore after successful scoring — shared with the
      // Haiku-fallback path via rescore-lifecycle.js so a third success path
      // can't silently skip it (2026-07-26 incident).
      const scoredAny = result.scoredFile as any;
      markRescoreComplete(scoredAny);

      // singleModelEmergency retry lifecycle: if scoring rebuilt ensembleData with the
      // emergency flag still set (Gemini/etc still down), record the retry attempt so
      // the daily auto-retry phase skips this file going forward. If the flag cleared,
      // ensembleData was rebuilt without it and the count is naturally absent.
      if (
        options.retryEmergency &&
        priorEmergencyRetryCount === 0 &&
        scoredAny.ensembleData?.singleModelEmergency === true
      ) {
        scoredAny.ensembleData.singleModelEmergencyRetryCount = priorEmergencyRetryCount + 1;
        scoredAny.ensembleData.singleModelEmergencyRetriedAt = new Date().toISOString();
      }

      // Post-scoring garbage detection: check if LLM reasoning indicates
      // the text was not an actual review (closes the feedback loop)
      const llmResult = result.scoredFile.llmScore;
      if (llmResult) {
        const garbageCheck = detectGarbageFromReasoning(
          llmResult.reasoning,
          llmResult.confidence
        );
        if (garbageCheck.isGarbage) {
          scoredAny.contentTier = 'needs-rescrape';
          scoredAny.garbageReasoningDetected = garbageCheck.matchedPattern;
          scoredAny.garbageReasoningFlaggedAt = new Date().toISOString();
        }
      }

      if (!options.dryRun) {
        saveReviewFile(filePath, result.scoredFile);
        try {
          const sd = result.scoredFile as any;
          emitStage({
            showId: sd.showId,
            reviewKey: `${sd.outletId}:${sd.criticName}:${sd.url || ''}`,
            stage: 'scored',
            metadata: { score: (result.scoredFile.llmScore as any).score, ensemble: !!(sd.ensembleData) },
          });
        } catch (e: any) { process.stderr.write(`[stage-latency] score emit failed: ${e.message}\n`); }
      }

      const score = result.scoredFile.llmScore.score;
      const bucket = result.scoredFile.llmScore.bucket;
      const confidence = result.scoredFile.llmScore.confidence;

      // Show ensemble details if available
      const ed = result.scoredFile.ensembleData;
      let ensembleInfo = '';
      if (ed) {
        const geminiPart = ed.geminiScore !== null && ed.geminiScore !== undefined ? ` G:${ed.geminiScore}` : '';
        const kimiPart = ed.kimiScore !== null && ed.kimiScore !== undefined ? ` K:${ed.kimiScore}` : '';
        ensembleInfo = ` [C:${ed.claudeScore} O:${ed.openaiScore}${geminiPart}${kimiPart}${ed.needsReview ? ' ⚠️' : ''}]`;
      }

      console.log(`${score} (${bucket}, ${confidence})${ensembleInfo}`);
      processed++;
    } else {
      console.log(`FAILED: ${result.error}`);
      errors++;
      errorDetails.push({
        showId: reviewFile.showId,
        outletId: reviewFile.outletId || '',
        error: result.error || 'Unknown error'
      });
      // Head-of-line blocking fix (Notion 3ad637c5-416f-8169) — see
      // maybeStampBlockedRescore() for why this checks the error prefix and
      // not the inputValidationFailed boolean (the boolean also covers the
      // non-deterministic hallucinated_score refusal).
      maybeStampBlockedRescore(filePath, result.error, options.dryRun === true);
    }
    // Success and hard-failure both fell THROUGH in the original loop.
    return false;
  }

  /**
   * Rebuild the prepared items for a batch that was submitted by an EARLIER
   * run (resume path). The prep is deliberately not persisted — it embeds the
   * full review text — so it is recomputed from the same review file on disk.
   *
   * That recomputation is deterministic as long as the file hasn't changed:
   * prepareScoringInput() is pure, and the pre-flagged multi-show trim is
   * re-applied here because the submitting run had already written
   * isMultiShowReview:true to disk before trimming. An entry whose file has
   * since gone missing or become unscorable yields null and is reported, not
   * silently dropped.
   */
  function reconstructBatchItems(state: BatchState): Array<PendingBatchItem | null> {
    const items: Array<PendingBatchItem | null> = new Array(state.itemCount).fill(null);
    const submittedMs = Date.parse(state.submittedAt);
    for (const entry of state.manifest) {
      // Manifest paths are stored repo-relative (they get committed to the
      // public repo and must resolve on a different checkout).
      const absPath = path.isAbsolute(entry.filePath)
        ? entry.filePath
        : path.join(PROJECT_ROOT, entry.filePath);
      try {
        const reviewFile = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as ReviewTextFile;
        // Someone (a sync run, a manual ingest) scored this file AFTER the
        // batch was submitted. Merging now would overwrite a newer score with
        // older model output. Leave it alone.
        const scoredAt = Date.parse((reviewFile as any).llmMetadata?.scoredAt || '');
        if (Number.isFinite(scoredAt) && Number.isFinite(submittedMs) && scoredAt > submittedMs) {
          console.log(`   ⚠️ Resume skip ${entry.showId}/${entry.outletId}: scored after submission (${(reviewFile as any).llmMetadata.scoredAt})`);
          continue;
        }
        reviewFile.showTitle = showTitles.get(reviewFile.showId) || undefined;
        const showMeta = showPriority.get(reviewFile.showId);
        if (showMeta) {
          reviewFile.category = showMeta.category ?? undefined;
          reviewFile.venue = showMeta.venue ?? undefined;
          reviewFile.type = showMeta.type ?? undefined;
        }
        if (reviewFile.isMultiShowReview && reviewFile.fullText) {
          const showTitle = showTitles.get(reviewFile.showId);
          if (showTitle) {
            const trimResult = trimMultiShowText(reviewFile.fullText, showTitle, reviewFile.showId);
            if (trimResult.trimmed && !trimResult.trimFailed) reviewFile.fullText = trimResult.text;
          }
        }
        const prepared = (scorer as EnsembleReviewScorer).prepareScoringInput(reviewFile);
        if (!prepared.ok || !prepared.prep) {
          console.log(`   ⚠️ Resume prep failed for ${entry.showId}/${entry.outletId}: ${prepared.failure?.error}`);
          errorDetails.push({ showId: entry.showId, outletId: entry.outletId, error: `resume_prep_failed:${prepared.failure?.error || 'unknown'}` });
          // Head-of-line blocking fix (Notion 3ad637c5-416f-8169): same class
          // as the batch submission path — stamp deterministic text-gate
          // failures here too so a resumed batch doesn't re-fail forever.
          maybeStampBlockedRescore(absPath, prepared.failure?.error, options.dryRun === true);
          continue;
        }
        // The models scored the text as it was at SUBMIT time. If it changed
        // since (re-scrape, fullText upgrade, a star rating added that flips
        // the file into anchored-v6 mode), the stored output no longer
        // corresponds to this input — merging it would stamp current
        // provenance onto a stale score. Skip; the next run rescores it fresh.
        const currentHash = computeInputHash(prepared.prep);
        if (entry.inputHash && entry.inputHash !== currentHash) {
          console.log(`   ⚠️ Resume skip ${entry.showId}/${entry.outletId}: review input changed since submission`);
          errorDetails.push({ showId: entry.showId, outletId: entry.outletId, error: 'resume_input_hash_mismatch' });
          continue;
        }
        items[entry.index] = {
          filePath: absPath,
          showId: entry.showId,
          outletId: entry.outletId,
          reviewFile,
          prep: prepared.prep,
          priorEmergencyRetryCount: ((reviewFile as any).ensembleData?.singleModelEmergencyRetryCount) || 0,
        };
      } catch (e: any) {
        console.log(`   ⚠️ Resume reload failed for ${entry.filePath}: ${e.message}`);
        errorDetails.push({ showId: entry.showId, outletId: entry.outletId, error: `resume_reload_failed:${e.message}` });
      }
    }
    return items;
  }

  /**
   * Fetch a terminal batch's results and drive each item through the same
   * three stages the synchronous path uses: combineOutcomes →
   * finalizeScoredFile → handleScoringResult. Returns the set of filePaths
   * that were actually processed, so the caller can skip re-queueing them.
   */
  async function processBatchResults(
    state: BatchState,
    items: Array<PendingBatchItem | null>
  ): Promise<{ written: Set<string>; merged: boolean }> {
    const { rows, unretrievableVendors } = await fetchAndMerge(state, batchKeys);
    const cfg = (scorer as EnsembleReviewScorer).getBatchConfig();
    const done = new Set<string>();

    // A vendor leg we PAID for whose results could not be retrieved is not the
    // same as a vendor returning per-item errors. Merging anyway would publish
    // a 2-model (or 1-model) consensus across the whole corpus off a transient
    // 429 on a results download — and then clear the state so the paid results
    // could never be retried. Keep the state; the next run re-fetches.
    if (unretrievableVendors.length > 0) {
      console.log(`\n   ⛔ REFUSING TO MERGE — could not retrieve results for: ${unretrievableVendors.join('; ')}`);
      console.log(`      Merging would write a degraded ensemble corpus-wide. Batch state kept; the next run retries the fetch.`);
      process.exitCode = 2;
      return { written: done, merged: false };
    }

    for (const row of rows) {
      const item = items[row.index];
      if (!item) {
        console.log(`[batch ${row.index + 1}/${rows.length}] SKIPPED (no reconstructable item for this request)`);
        errors++;
        continue;
      }
      process.stdout.write(`[batch ${row.index + 1}/${rows.length}] ${item.showId} / ${item.outletId}... `);
      try {
        const { outcomes, usage } = outcomesForItem(row, scorer as EnsembleReviewScorer, cfg.geminiEnabled);
        (scorer as EnsembleReviewScorer).recordBatchUsage(usage);
        const ensembleResult = (scorer as EnsembleReviewScorer).combineOutcomes(outcomes, item.prep.band);
        const result = (scorer as EnsembleReviewScorer).finalizeScoredFile(
          item.reviewFile,
          ensembleResult,
          item.prep
        );
        await handleScoringResult(result, item.filePath, item.reviewFile, item.priorEmergencyRetryCount);
        done.add(item.filePath);
      } catch (e: any) {
        console.log(`ERROR: ${e.message}`);
        errors++;
        errorDetails.push({ showId: item.showId, outletId: item.outletId, error: e.message });
      }
    }
    return { written: done, merged: true };
  }

  // ========================================
  // --batch MODE SETUP (task #516)
  // ========================================
  // In batch mode the per-file loop stops calling scoreReviewFile() and
  // instead runs stage 1 (prepareScoringInput) and queues the item. Every
  // pre-filter above it — garbage detection, multi-show trim, the
  // already-anchored skip — runs completely unchanged, so batch and sync
  // score exactly the same set of files with exactly the same input text.
  const batchMode: boolean = options.batch === true;
  const batchPollMinutes: number = options.batchPollMinutes || 20;
  const pendingBatchItems: PendingBatchItem[] = [];
  const batchKeys = { anthropic: claudeApiKey!, openai: openaiApiKey!, gemini: geminiApiKey };
  let skipNewWork = false;
  let resumedFilePaths: Set<string> = new Set();

  if (batchMode) {
    if (!options.ensemble) {
      console.log(`\n⛔ --batch requires --ensemble (batch mode is defined per ensemble leg). Aborting.\n`);
      process.exit(2);
    }
    const cfg = (scorer as EnsembleReviewScorer).getBatchConfig();
    if (cfg.kimiEnabled) {
      // OpenRouter has no batch tier. Silently dropping Kimi would mean batch
      // runs score a 3-model ensemble where sync scored 4 — a scoring-logic
      // change disguised as a cost optimisation. Refuse instead.
      console.log(`\n⛔ --batch cannot run with Kimi enabled (OpenRouter has no batch tier; dropping it would change the ensemble). Unset OPENROUTER_API_KEY. Aborting.\n`);
      process.exit(2);
    }
    if (maxCost > 0) {
      console.log(`\n⚠️  --max-cost is inert in --batch mode: batch cost is committed at submission, not per call. A pre-submit estimate is printed instead.\n`);
    }
    console.log(`\n📦 BATCH MODE — vendor Batch APIs (50% discount), submit → poll (≤${batchPollMinutes} min this run) → merge.\n`);
  }

  // Drain an in-flight batch from a previous run BEFORE queueing new work, so
  // a cancelled/timed-out runner collects what it already paid for instead of
  // resubmitting (decideNextAction from llm-batch.js).
  //
  // Deliberately NOT gated on batchMode. DISABLE_BATCH_SCORING=1 must stop new
  // batch SUBMISSIONS without stranding a paid batch: if the drain only ran in
  // batch mode, flipping the kill switch would leave the state on disk while
  // the sync path rescored the very same files, and re-enabling weeks later
  // would merge long-stale output over those newer scores.
  if (options.ensemble && !options.dryRun) {
    const existing = readBatchState();
    if (existing) {
      const ageHours = batchStateAgeHours(existing);
      if (ageHours > BATCH_STATE_MAX_AGE_HOURS) {
        console.log(`🗑️  Discarding batch state submitted ${existing.submittedAt} — ${ageHours.toFixed(1)}h old, past the ${BATCH_STATE_MAX_AGE_HOURS}h window (vendors expire batches at 24h). Those reviews will be scored fresh.\n`);
        writeBatchState(null);
      } else if (existing.promptVersion && existing.promptVersion !== PROMPT_VERSION) {
        // The prompt shipped a new version while this batch was in flight. Its
        // model output came from the OLD prompt; finalizeScoredFile would stamp
        // the CURRENT promptVersion on it, hiding it from --outdated forever.
        console.log(`🗑️  Discarding batch state: submitted under prompt v${existing.promptVersion}, current is v${PROMPT_VERSION}. Those reviews will be scored fresh.\n`);
        writeBatchState(null);
      } else {
        if (!batchMode) {
          console.log(`🔁 --batch is off, but a paid batch is in flight — draining it before anything else (no new batch will be submitted).`);
        }
        console.log(`🔁 Resuming in-flight batch submitted ${existing.submittedAt} (${existing.itemCount} items)`);
        const poll = await pollUntilTerminal(existing, batchKeys, { budgetMinutes: batchPollMinutes });
        if (poll.ready) {
          if (poll.forced) console.log(`   ⚠️ Forced merge: ${poll.reason}`);
          const items = reconstructBatchItems(existing);
          const outcome = await processBatchResults(existing, items);
          resumedFilePaths = outcome.written;
          if (outcome.merged) {
            writeBatchState(null);
            console.log(`   ✓ Resumed batch merged — ${resumedFilePaths.size} file(s) written\n`);
          } else {
            console.log(`   ⏸️  Merge refused — state kept for the next run.\n`);
            skipNewWork = true;
          }
        } else {
          console.log(`   ⏳ Still in flight (${poll.reason}). Keeping state; NOT submitting new work this run.\n`);
          skipNewWork = true;
        }
      }
    }
  }

  if (finalFiles.length === 0) {
    console.log('No reviews to process.');

    // A drained batch above may still have written files — record it so the
    // CI scoring-progress gate sees the real review-text writes instead of
    // concluding "nothing happened" (P1 352637c5-416f-81ab).
    if (resumedFilePaths.size > 0 && !options.dryRun) {
      writeProgress(processed, resumedFilePaths.size, errors, skipped, startTime);
      gitCheckpoint(processed, resumedFilePaths.size);
    }

    // Still run calibration/validation if requested
    if (options.runCalibration) {
      runCalibration(true);
    }
    if (options.runValidation) {
      runValidation(true);
    }
    return;
  }

  // ========================================
  // A/B DISTRIBUTION CHECK (rescore guardrail)
  // ========================================
  // When rescoring >100 reviews (--outdated or --rescore), run a sample comparison
  // to catch unintended distribution shifts BEFORE spending hundreds of dollars.
  // upgradeEnsemble = first-time ensemble scores (not a rescore), skip A/B check
  const isRescore = options.outdated || (!options.unscoredOnly && !options.needsRescore && !options.ensembleSource && !options.upgradeEnsemble && !options.retryEmergency);
  if (isRescore && finalFiles.length > 100 && !options.forceFullRun && !options.dryRun && options.ensemble) {
    const abResult = await runABDistributionCheck(
      finalFiles,
      getScorableText,
      scorer as EnsembleReviewScorer,
      options.verbose
    );

    if (!abResult.passed) {
      console.log(`\n⛔ ABORTING: Distribution check failed.`);
      console.log(`   ${abResult.details}`);
      console.log(`\n   To override, re-run with --force-full-run`);
      console.log(`   To investigate, re-run with --limit=20 --verbose\n`);
      process.exit(1);
    }
  }

  // `!skipNewWork` short-circuits the whole loop when a resumed batch is
  // still in flight — submitting a second batch on top of it would double
  // the spend and race two manifests through one state slot.
  for (let i = 0; !skipNewWork && i < finalFiles.length; i++) {
    const { path: filePath, data: reviewFile } = finalFiles[i];

    // Already written by this run's resume drain — don't re-queue it.
    if (resumedFilePaths.has(filePath)) continue;

    // Capture prior retry count BEFORE scoring rebuilds ensembleData (ensemble-scorer.ts:464).
    // If retry succeeds (2+ models), the new ensembleData has no singleModelEmergency and
    // the count naturally clears. If retry still single-model, we increment in the success
    // path below so the next cron skips this file (one-shot retry).
    const priorEmergencyRetryCount = ((reviewFile as any).ensembleData?.singleModelEmergencyRetryCount) || 0;

    // Attach show metadata for LLM context (input-builder uses these)
    reviewFile.showTitle = showTitles.get(reviewFile.showId) || undefined;
    const showMeta = showPriority.get(reviewFile.showId);
    if (showMeta) {
      reviewFile.category = showMeta.category ?? undefined;
      reviewFile.venue = showMeta.venue ?? undefined;
      reviewFile.type = showMeta.type ?? undefined;
    }

    // Progress
    const showName = reviewFile.showId;
    const outletName = reviewFile.outlet || reviewFile.outletId;
    process.stdout.write(`[${i + 1}/${finalFiles.length}] ${showName} / ${outletName}... `);

    // Pre-scoring content quality check
    const scorableText = getScorableText(reviewFile, filePath);
    if (scorableText && reviewFile.fullText && reviewFile.fullText.length >= 100) {
      // Use the REAL show title from shows.json (not a hyphens-to-spaces synthesis
      // of the showId). This mirrors the call in getScorableText() a few lines up.
      //
      // Pre-2026-04-11 bug: this block used to synthesize a fake title from
      // showId (e.g. "caroline-or-change-2004" → "caroline or change") and pass
      // it as the SECOND argument (where the function expects showId, not
      // showTitle). Inside assessTextQuality → validateShowMentioned, the
      // synthesized string "caroline or change" wouldn't match the text's
      // actual "caroline, or change" (with the comma), so the show appeared
      // to not be mentioned, which triggered the multi-show garbage branch
      // and rejected the review. Every review whose real title contained
      // punctuation the showId didn't carry (commas, apostrophes, "&", etc.)
      // got silently dropped. Measured impact: 13 of 68 orphans unblocked by
      // this one-line fix.
      const realShowTitle = showTitles.get(reviewFile.showId) || undefined;
      const qualityResult: ContentQualityResult = assessTextQuality(reviewFile.fullText, reviewFile.showId, realShowTitle);

      if (qualityResult.quality === 'garbage' && qualityResult.confidence === 'high') {
        // Check if we have good excerpts to fall back to
        const hasGoodExcerpts = EXCERPT_FIELDS.some((field: string) => {
          const val = (reviewFile as any)[field];
          return val && val.length >= 50;
        });

        if (!hasGoodExcerpts) {
          // Skip scoring - content is garbage AND no excerpts to fall back to
          console.log(`SKIPPED (garbage: ${qualityResult.issues[0] || 'invalid content'})`);
          garbageSkipped++;
          garbageSkips.push({
            showId: reviewFile.showId,
            outletId: reviewFile.outletId || '',
            filePath,
            quality: qualityResult.quality,
            confidence: qualityResult.confidence,
            issues: qualityResult.issues,
            skippedAt: new Date().toISOString()
          });
          continue;
        } else {
          // fullText is garbage but we have excerpts - use excerpts for scoring
          console.log(`(using excerpts, fullText garbage) `);
          suspiciousWarnings++;
          // The getScorableText() will return excerpts since fullText will fail quality check
        }
      }

      if (qualityResult.quality === 'suspicious' || qualityResult.quality === 'garbage') {
        // Still score but add warning
        suspiciousWarnings++;
        if (options.verbose) {
          console.log(`(WARNING: ${qualityResult.issues.join(', ')}) `);
        }
      }
    }

    // Multi-show detection: flag multi-show reviews for trimming, skip only roundup articles
    if (scorableText && reviewFile.showId && !reviewFile.isCombinedReview) {
      const multiShowResult = detectMultiShow(scorableText, reviewFile.showId);

      if (multiShowResult.isMultiShowReview) {
        // Flag the file for future runs
        if (!options.dryRun) {
          const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fileData.isMultiShowReview = true;
          fileData.multiShowReason = multiShowResult.reason;
          saveReviewFile(filePath, fileData);
        }
        // Trim reviewFile.fullText so the scorer receives only the relevant section
        const showTitle = showTitles.get(reviewFile.showId);
        if (showTitle && reviewFile.fullText) {
          const trimResult = trimMultiShowText(reviewFile.fullText, showTitle, reviewFile.showId);
          if (trimResult.trimmed && !trimResult.trimFailed) {
            reviewFile.fullText = trimResult.text;
            console.log(`(multi-show: trimmed ${trimResult.originalLength}→${trimResult.trimmedLength} chars) `);
          } else {
            console.log(`(multi-show: ${multiShowResult.reason}, trim failed — scoring full text) `);
          }
        }
      }
    }

    // For pre-flagged multi-show reviews (from previous runs), trim fullText before scoring
    if (reviewFile.isMultiShowReview && reviewFile.fullText) {
      const showTitle = showTitles.get(reviewFile.showId);
      if (showTitle) {
        const trimResult = trimMultiShowText(reviewFile.fullText, showTitle, reviewFile.showId);
        if (trimResult.trimmed && !trimResult.trimFailed) {
          reviewFile.fullText = trimResult.text;
          if (options.verbose) {
            console.log(`  Pre-flagged multi-show: trimmed ${trimResult.originalLength}→${trimResult.trimmedLength} chars`);
          }
        }
      }
    }

    // Phase B-WE ship-check fix P0-1: idempotence guard. When
    // --skip-already-anchored is set, skip any file whose scoreSource is
    // already 'anchored-v6' or 'llm-v6'. Safe re-runs after partial
    // completion (e.g., --max-cost hit) won't double-charge.
    if (skipAlreadyAnchored) {
      const existingSource = (reviewFile as any).scoreSource;
      if (existingSource === 'anchored-v6' || existingSource === 'llm-v6') {
        console.log(`SKIPPED (already ${existingSource})`);
        skipped++;
        continue;
      }
    }

    // Sample token usage BEFORE the call so we can compute the per-call delta.
    const tokensBefore = (scorer as any).getTokenUsage
      ? JSON.parse(JSON.stringify((scorer as any).getTokenUsage()))
      : null;

    // BATCH: run stage 1 only, queue the item, and move on. The models are
    // called once for the whole run after this loop finishes.
    if (batchMode) {
      const prepared = (scorer as EnsembleReviewScorer).prepareScoringInput(reviewFile);
      if (!prepared.ok || !prepared.prep) {
        const failure = prepared.failure || { success: false, error: 'prepare_scoring_input_failed' };
        console.log(`FAILED: ${failure.error}`);
        errors++;
        errorDetails.push({
          showId: reviewFile.showId,
          outletId: reviewFile.outletId || '',
          error: failure.error || 'Unknown error'
        });
        // Head-of-line blocking fix (Notion 3ad637c5-416f-8169): --batch mode
        // (the default for scheduled runs) rejects at this pre-submission
        // prepare step and never reaches handleScoringResult, so it needs the
        // same stamp the live-scoring FAILED branch gets.
        maybeStampBlockedRescore(filePath, failure.error, options.dryRun === true);
        continue;
      }
      pendingBatchItems.push({
        filePath,
        showId: reviewFile.showId,
        outletId: reviewFile.outletId || '',
        reviewFile,
        prep: prepared.prep,
        priorEmergencyRetryCount,
      });
      console.log(`QUEUED (batch #${pendingBatchItems.length})`);
      continue;
    }

    // `skipLoopTail` reproduces the `continue` the inline block used to do:
    // rejected / skipped / Haiku-fallback files must NOT reach the budget
    // accounting, the rate-limit sleep, or the checkpoint gate below.
    let skipLoopTail = false;
    try {
      const result = await scorer.scoreReviewFile(reviewFile);
      skipLoopTail = await handleScoringResult(result, filePath, reviewFile, priorEmergencyRetryCount);
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
      errors++;
      errorDetails.push({
        showId: reviewFile.showId,
        outletId: reviewFile.outletId || '',
        error: e.message
      });
    }
    if (skipLoopTail) continue;

    // Phase B-WE W1-T5: per-call cost delta + budget cap check.
    if (maxCost > 0 && tokensBefore && (scorer as any).getTokenUsage) {
      const tokensAfter = (scorer as any).getTokenUsage();
      // Compute delta per model. Shapes are { input, output } per model (or
      // null); the claude leg additionally carries prompt-cache counters
      // (cacheWrite/cacheRead) which must ride along or the budget circuit
      // undercounts — input_tokens excludes cached tokens.
      const usageDelta: { claude?: { input: number; output: number; cacheWrite?: number; cacheRead?: number }; openai?: { input: number; output: number }; gemini?: { input: number; output: number }; kimi?: { input: number; output: number } } = {};
      for (const m of ['claude', 'openai', 'gemini', 'kimi'] as const) {
        const after = tokensAfter[m];
        const before = tokensBefore[m];
        if (after && before) {
          usageDelta[m] = {
            input: Math.max(0, after.input - before.input),
            output: Math.max(0, after.output - before.output),
            cacheWrite: Math.max(0, (after.cacheWrite || 0) - (before.cacheWrite || 0)),
            cacheRead: Math.max(0, (after.cacheRead || 0) - (before.cacheRead || 0)),
          };
        } else if (after && !before) {
          usageDelta[m] = { input: after.input, output: after.output, cacheWrite: after.cacheWrite || 0, cacheRead: after.cacheRead || 0 };
        }
      }
      const callCost = __estimateCost(usageDelta, { claudeModelName: options.model, openaiModelName: options.openaiModel });
      budgetUsed += callCost;
      if (budgetUsed >= maxCost) {
        console.log(`\n⛔ Budget cap reached ($${budgetUsed.toFixed(4)} >= $${maxCost.toFixed(2)}). Aborting cleanly after this review.`);
        budgetAborted = true;
        // Force a final checkpoint so we don't lose the just-completed work.
        if (options.checkpointInterval && options.checkpointInterval > 0 && !options.dryRun) {
          writeProgress(processed, finalFiles.length, errors, skipped, startTime);
          gitCheckpoint(processed, finalFiles.length);
        }
        break;
      }
    }

    // Rate limiting
    if (i < finalFiles.length - 1) {
      await new Promise(r => setTimeout(r, options.rateLimitMs));
    }

    // Checkpoint: commit and push progress every N processed reviews
    if (options.checkpointInterval && options.checkpointInterval > 0 && !options.dryRun) {
      if (processed > 0 && processed % options.checkpointInterval === 0) {
        writeProgress(processed, finalFiles.length, errors, skipped, startTime);
        gitCheckpoint(processed, finalFiles.length);
      }
    }
  }

  // ========================================
  // --batch SUBMIT → POLL → MERGE (task #516)
  // ========================================
  if (batchMode && !skipNewWork) {
    if (pendingBatchItems.length === 0) {
      console.log(`\n📦 Batch mode: nothing queued — no batch submitted.`);
    } else {
      const cfg = (scorer as EnsembleReviewScorer).getBatchConfig();
      const requests = assembleRequests(pendingBatchItems, {
        geminiEnabled: cfg.geminiEnabled,
        claudeModel: cfg.claudeModel,
        openaiModel: cfg.openaiModel,
        geminiTemperature: cfg.geminiTemperature,
      });

      // Cost is committed at submission, so print the (batch-discounted)
      // estimate BEFORE spending it — the batch-mode analogue of --max-cost's
      // per-call circuit breaker, which cannot apply here.
      const estUsage = estimateBatchUsage(requests);
      const estCost = __estimateCost(estUsage as any, { claudeModelName: options.model, batch: true });
      const syncCost = __estimateCost(estUsage as any, { claudeModelName: options.model });
      console.log(`\n📦 Submitting batch: ${pendingBatchItems.length} reviews × ${cfg.geminiEnabled ? 3 : 2} vendors`);
      console.log(
        `   Estimated cost (batch-discounted, upper bound): $${estCost.toFixed(4)} — vs $${syncCost.toFixed(4)} synchronous`
      );

      if (options.dryRun) {
        console.log(`   --dry-run: not submitting.\n`);
      } else {
        const ids = await submitBatches(requests, batchKeys, { geminiModel: cfg.geminiModel });
        // All-or-nothing across the ENABLED legs. A partial submit would run
        // the entire night's corpus through a 2-model ensemble off one vendor's
        // transient 429 — a corpus-wide quality change that looks identical to
        // a normal run downstream. In sync mode the same outage degrades a
        // handful of individual reviews; here it degrades everything, so batch
        // holds itself to a stricter bar and lets the next run retry.
        const expectedVendors = ['claude', 'openai', ...(cfg.geminiEnabled ? ['gemini'] : [])];
        const acceptedVendors = [
          ids.claudeBatchId ? 'claude' : null,
          ids.openaiBatchId ? 'openai' : null,
          ids.geminiBatchId ? 'gemini' : null,
        ].filter(Boolean) as string[];
        const missing = expectedVendors.filter(v => !acceptedVendors.includes(v));
        if (missing.length > 0) {
          console.log(`   ⛔ Only ${acceptedVendors.length}/${expectedVendors.length} vendors accepted (missing: ${missing.join(', ')}).`);
          console.log(`      Abandoning this batch rather than scoring the whole corpus on a degraded ensemble.`);
          console.log(`      The ${acceptedVendors.length} accepted batch(es) will expire unused; these reviews stay unscored for the next run.`);
          process.exitCode = 2;
        } else {
          const state = buildBatchState(
            pendingBatchItems,
            ids,
            { claudeModel: cfg.claudeModel, openaiModel: cfg.openaiModel, geminiModel: cfg.geminiEnabled ? cfg.geminiModel : undefined },
            new Date().toISOString(),
            PROJECT_ROOT
          );
          // Persist + push the IDs BEFORE polling: if the runner is cancelled
          // mid-poll (GitHub job timeout, cascade cancel), the next scheduled
          // run resumes this batch instead of paying for it a second time.
          writeBatchState(state);
          gitCheckpoint(processed, finalFiles.length);

          const poll = await pollUntilTerminal(state, batchKeys, { budgetMinutes: batchPollMinutes });
          if (poll.ready) {
            if (poll.forced) console.log(`   ⚠️ Forced merge: ${poll.reason}`);
            const outcome = await processBatchResults(state, pendingBatchItems);
            if (outcome.merged) {
              writeBatchState(null);
              console.log(`\n   ✓ Batch merged — ${outcome.written.size} file(s) written`);
            } else {
              console.log(`\n   ⏸️  Merge refused — state kept; the next scheduled run retries the fetch.`);
            }
          } else {
            console.log(`\n   ⏳ Batch still in flight (${poll.reason}).`);
            console.log(`      State persisted to scoring-progress.json — the next scheduled run resumes polling.`);
          }
        }
      }
    }
  }

  // Compute global counts across ALL review files (not just this batch)
  // This is the authoritative count that gets committed to the public repo.
  const globalCounts = { totalReviewFiles: 0, totalScored: 0, totalUnscored: 0, totalSkipped: 0 };
  for (const f of allFiles) {
    globalCounts.totalReviewFiles++;
    const d = f.data as any;
    if (d.wrongShow || d.wrongProduction || d.contentTier === 'invalid') {
      globalCounts.totalSkipped++;
    } else if (d.llmScore) {
      globalCounts.totalScored++;
    } else {
      globalCounts.totalUnscored++;
    }
  }

  // Write final progress with global counts
  writeProgress(processed, finalFiles.length, errors, skipped, startTime, globalCounts);

  // Summary
  const completedAt = new Date().toISOString();
  const tokenUsage = scorer.getTokenUsage();

  console.log('\n========================================');
  console.log(`Processed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Garbage skipped: ${garbageSkipped}`);
  console.log(`Suspicious warnings: ${suspiciousWarnings}`);
  console.log(`Errors: ${errors}`);

  // Handle both single and ensemble scorer token usage
  if ('claude' in tokenUsage) {
    // Ensemble scorer
    const ensembleUsage = tokenUsage as { claude: { input: number; output: number; cacheWrite: number; cacheRead: number }; openai: { input: number; output: number }; gemini: { input: number; output: number } | null; kimi: { input: number; output: number } | null; total: number };
    const cw = ensembleUsage.claude.cacheWrite || 0;
    const cr = ensembleUsage.claude.cacheRead || 0;
    console.log(`Claude tokens: ${(ensembleUsage.claude.input + ensembleUsage.claude.output + cw + cr).toLocaleString()} (in: ${ensembleUsage.claude.input.toLocaleString()}, out: ${ensembleUsage.claude.output.toLocaleString()}, cache-write: ${cw.toLocaleString()}, cache-read: ${cr.toLocaleString()})`);
    if (cw + cr + ensembleUsage.claude.input > 0) {
      // Hit rate over prompt tokens — the metric Anthropic's billing email measures.
      const hitRate = (cr / (cr + cw + ensembleUsage.claude.input)) * 100;
      console.log(`Claude cache hit rate: ${hitRate.toFixed(1)}%`);
    }
    console.log(`OpenAI tokens: ${(ensembleUsage.openai.input + ensembleUsage.openai.output).toLocaleString()} (in: ${ensembleUsage.openai.input.toLocaleString()}, out: ${ensembleUsage.openai.output.toLocaleString()})`);
    if (ensembleUsage.gemini) {
      console.log(`Gemini tokens: ${(ensembleUsage.gemini.input + ensembleUsage.gemini.output).toLocaleString()} (in: ${ensembleUsage.gemini.input.toLocaleString()}, out: ${ensembleUsage.gemini.output.toLocaleString()})`);
    }
    if (ensembleUsage.kimi) {
      console.log(`Kimi tokens: ${(ensembleUsage.kimi.input + ensembleUsage.kimi.output).toLocaleString()} (in: ${ensembleUsage.kimi.input.toLocaleString()}, out: ${ensembleUsage.kimi.output.toLocaleString()})`);
    }

    // Estimate cost via cost.ts (single source of pricing coefficients —
    // includes prompt-cache write/read pricing on the claude leg).
    const { costBreakdown: __costBreakdown } = require('./cost');
    const breakdown = __costBreakdown({
      claude: ensembleUsage.claude,
      openai: ensembleUsage.openai,
      gemini: ensembleUsage.gemini || undefined,
      kimi: ensembleUsage.kimi || undefined,
    }, { claudeModelName: options.model, batch: batchMode });
    const costParts = [`Claude: $${breakdown.claude.toFixed(4)}`, `OpenAI: $${breakdown.openai.toFixed(4)}`];
    if (ensembleUsage.gemini) costParts.push(`Gemini: $${breakdown.gemini.toFixed(4)}`);
    if (ensembleUsage.kimi) costParts.push(`Kimi: $${breakdown.kimi.toFixed(4)}`);
    // batch:true applies BATCH_DISCOUNT_MULTIPLIER to the claude/openai/gemini
    // legs, so the printed figure is what the vendors actually bill for a
    // --batch run rather than the sync-rate equivalent.
    console.log(`Estimated cost${batchMode ? ' (batch-discounted)' : ''}: $${breakdown.total.toFixed(4)} (${costParts.join(', ')})`);
  } else {
    // Single scorer
    const singleUsage = tokenUsage as { input: number; output: number; total: number };
    console.log(`Tokens used: ${singleUsage.total.toLocaleString()} (input: ${singleUsage.input.toLocaleString()}, output: ${singleUsage.output.toLocaleString()})`);

    // Estimate cost
    const inputCostPer1M = options.model.includes('haiku') ? 0.80 : 3.00;
    const outputCostPer1M = options.model.includes('haiku') ? 4.00 : 15.00;
    const estimatedCost = (singleUsage.input / 1_000_000) * inputCostPer1M +
                          (singleUsage.output / 1_000_000) * outputCostPer1M;
    console.log(`Estimated cost: $${estimatedCost.toFixed(4)}`);
  }

  // Save run summary
  if (!options.dryRun) {
    // Normalize token usage for summary
    const normalizedTokenUsage = 'claude' in tokenUsage
      ? {
          input: (tokenUsage as any).claude.input + (tokenUsage as any).openai.input,
          output: (tokenUsage as any).claude.output + (tokenUsage as any).openai.output,
          total: (tokenUsage as any).total
        }
      : tokenUsage as { input: number; output: number; total: number };

    const summary: PipelineRunSummary = {
      startedAt,
      completedAt,
      totalReviews: allFiles.length,
      processed,
      skipped: allFiles.length - validFiles.length,
      errors,
      tokensUsed: normalizedTokenUsage,
      errorDetails
    };

    // Run calibration if requested
    if (options.runCalibration) {
      summary.calibration = runCalibration(options.verbose);
    }

    // Run validation if requested
    if (options.runValidation) {
      summary.validation = runValidation(options.verbose);
    }

    saveRunSummary(summary);
    console.log(`\nRun summary saved to: ${RUNS_LOG_PATH}`);

    // Save garbage skips if any
    if (garbageSkips.length > 0) {
      let existingSkips: GarbageSkipEntry[] = [];
      if (fs.existsSync(GARBAGE_SKIPS_PATH)) {
        try {
          existingSkips = JSON.parse(fs.readFileSync(GARBAGE_SKIPS_PATH, 'utf-8'));
        } catch {
          existingSkips = [];
        }
      }
      // Append new skips, keeping last 500
      const allSkips = [...existingSkips, ...garbageSkips].slice(-500);
      fs.writeFileSync(GARBAGE_SKIPS_PATH, JSON.stringify(allSkips, null, 2) + '\n');
      console.log(`Garbage skips saved to: ${GARBAGE_SKIPS_PATH} (${garbageSkips.length} new, ${allSkips.length} total)`);
    }
  } else {
    // Still run calibration/validation if requested
    if (options.runCalibration) {
      runCalibration(true);
    }
    if (options.runValidation) {
      runValidation(true);
    }
  }

  // Phase B-WE ship-check fix P1-4: surface budget-abort via exit code so
  // CI / parent scripts can detect a cap-hit without parsing logs.
  if (budgetAborted) {
    console.log(`\n⚠️  Budget cap was reached during this run. Exit code 2.`);
    process.exitCode = 2;
  }
}

// ========================================
// HELP
// ========================================

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
LLM Review Scoring Pipeline

Usage:
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts [options]

Options:
  --show=<slug>         Process only one show
  --all                 Process all shows (default if no --show)
  --unscored-only       Only score reviews without existing LLM scores (default)
  --rescore             Re-score even if already scored
  --needs-rescore       Only score reviews flagged with needsRescore=true
  --retry-emergency     Retry stuck singleModelEmergency reviews once (one-shot per file)
  --outdated            Re-score reviews with promptVersion older than current
  --force-full-run      Skip A/B distribution check (required for rescore >100 reviews)
  --ensemble-source=X   Only rescore reviews with this ensembleSource (e.g. two-model-fallback)
  --shard=N             Shard index (0-based) for parallel runs
  --total-shards=N      Total number of parallel shards
  --dry-run             Don't save results, just print what would happen
  --verbose             Detailed logging
  --limit=N             Only process N reviews
  --calibrate           Run calibration analysis after scoring
  --validate            Run aggregator validation after scoring
  --calibrate-only      Only run calibration (no scoring)
  --validate-only       Only run validation (no scoring)
  --ensemble-calibrate  Only run ensemble calibration (analyzes per-model performance)
  --model=<model>       Claude model: sonnet (default) or haiku
  --ensemble            Use ensemble mode (Claude + GPT-4o-mini for triangulation)
  --batch               Score via the vendor Batch APIs (50% cheaper, submit→poll→merge).
                        Requires --ensemble; refuses to run with Kimi enabled.
                        In-flight batches resume from scoring-progress.json.
  --batch-poll-minutes=N  Wall-clock budget for polling a batch this run (default: 20)
  --ground-truth        Run ground truth calibration against numeric ratings
  --rate-limit=N        Delay between API calls in ms (default: 100)

Examples:
  # Score all unscored reviews for one show
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --show=cabaret-2024

  # Score with ensemble mode (Claude + OpenAI)
  ANTHROPIC_API_KEY=sk-... OPENAI_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --ensemble --limit=10

  # Score all shows with calibration and validation
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --all --calibrate --validate

  # Dry run with verbose output
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --dry-run --verbose --limit=5

  # Run ground truth calibration
  npx ts-node scripts/llm-scoring/index.ts --ground-truth

  # Just run calibration analysis
  npx ts-node scripts/llm-scoring/index.ts --calibrate-only

  # Just run aggregator validation
  npx ts-node scripts/llm-scoring/index.ts --validate-only
`);
  process.exit(0);
}

// Run
main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
