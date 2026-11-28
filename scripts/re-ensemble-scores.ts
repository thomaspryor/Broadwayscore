#!/usr/bin/env npx tsx
/**
 * Re-ensemble scores using stored per-model data (no LLM calls needed)
 *
 * Applies Options A+B: no bucket clamping, weighted outlier inclusion.
 * Imports the real ensemble.ts logic — single source of truth.
 *
 * Usage:
 *   npx tsx scripts/re-ensemble-scores.ts                        # full run
 *   npx tsx scripts/re-ensemble-scores.ts --dry-run               # preview only
 *   npx tsx scripts/re-ensemble-scores.ts --show=two-strangers-bway-2025  # single show
 *   npx tsx scripts/re-ensemble-scores.ts --max-delta=20                 # cap max score change
 *
 * BRO-4335 tail stretch: with ENSEMBLE_TAIL_STRETCH=1 the run is scoped to
 * unanchored V6 reviews (scoreSource 'llm-v6') and applies applyTailStretch()
 * after the combine, from the stored (always pre-stretch) per-model scores, so
 * reruns are idempotent. A flag-off rerun recomputes the plain combine, which
 * rolls a stretched score back and drops ensembleData.tailStretch.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ensembleScoreFromArray, applyTailStretch } from './llm-scoring/ensemble';
import type { ModelScore, Bucket, EnsembleResult } from './llm-scoring/types';
const { listShowDirs } = require('./lib/list-show-dirs');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { isBandAnchored } = require('./lib/band-anchored');
const { isEnabled: isTailStretchEnabled } = require('./lib/monotone-stretch');

// ========================================
// CONFIG
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
/**
 * Review files to re-ensemble, as [showDir, file] pairs. Skips `_` holding
 * folders (_superseded-misattributed, _pending: moved-aside records that must
 * not get fresh scores, BRO-5652) and `_` sidecar files (_blocklist.json).
 */
export function listReensembleFiles(reviewTextsDir: string, showFilter?: string | null): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const showDir of listShowDirs(reviewTextsDir, { skipHolding: true })) {
    if (showFilter && showDir !== showFilter) continue;
    for (const file of fs.readdirSync(path.join(reviewTextsDir, showDir)).filter(isReviewTextFile)) out.push([showDir, file]);
  }
  return out;
}

/**
 * Resume checkpoint, one per mode: a tail-stretch run's processed list must never
 * make a later flag-off (rollback) run skip those same files, or vice versa.
 */
export function progressFileFor(tailStretch: boolean): string {
  return path.join(__dirname, '..', 'data', tailStretch ? 're-ensemble-progress-tail-stretch.json' : 're-ensemble-progress.json');
}
const CHECKPOINT_INTERVAL = 500;

// ========================================
// HELPERS
// ========================================

function scoreToThumb(score: number): 'Up' | 'Flat' | 'Down' {
  if (score >= 70) return 'Up';
  if (score >= 55) return 'Flat';
  return 'Down';
}

export function extractModelScores(ensembleData: any): ModelScore[] {
  const models: Array<{ key: string; model: 'claude' | 'openai' | 'gemini' | 'kimi' }> = [
    { key: 'claude', model: 'claude' },
    { key: 'openai', model: 'openai' },
    { key: 'gemini', model: 'gemini' },
    { key: 'kimi', model: 'kimi' },
  ];

  const results: ModelScore[] = [];

  for (const { key, model } of models) {
    const score = ensembleData[`${key}Score`];
    const bucket = ensembleData[`${key}Bucket`];

    if (score != null && bucket) {
      results.push({
        model,
        score,
        bucket: bucket as Bucket,
        confidence: 'high', // Not used in voting logic
      });
    }
  }

  return results;
}

export function shouldSkip(data: any, opts?: { tailStretch?: boolean }): string | null {
  if (!data.ensembleData) return 'no ensembleData';

  // Skip rejected reviews
  if (data.rejectedAt || data.rejectionReason) return 'rejected';

  // Skip if no llmScore (means scoring never completed)
  if (!data.llmScore || data.llmScore.score == null) return 'no llmScore';

  // Stored model scores are pre-clamp: re-ensembling a band-anchored review
  // would drop its critic's star/grade band (BRO-4335).
  if (isBandAnchored(data)) return 'band-anchored';

  // BRO-5254: the pre-strip score was kept over a noisy rescore; re-ensembling the
  // rescore's model votes would undo that.
  if (data.varietyPromoStrip && data.varietyPromoStrip.restored) return 'variety-strip score kept';

  // BRO-4335: a tail-stretch run touches only unanchored V6 reviews; anything
  // else would just be re-declustered under a flag that does not apply to it.
  if (opts && opts.tailStretch && data.scoreSource !== 'llm-v6') return 'not llm-v6 (tail-stretch run)';

  const modelScores = extractModelScores(data.ensembleData);
  if (modelScores.length < 2) return `only ${modelScores.length} model scores`;

  return null;
}

/**
 * Recompute a review's ensemble result from its stored per-model scores (no API
 * calls): the live combine, then the BRO-4335 tail stretch (a no-op unless
 * tailStretch is on and the review is llm-v6).
 */
export function recomputeEnsemble(data: any, opts?: { tailStretch?: boolean }): EnsembleResult {
  const result = ensembleScoreFromArray(extractModelScores(data.ensembleData));
  return applyTailStretch(result, data.scoreSource, { enabled: !!(opts && opts.tailStretch) });
}

export type ReensemblePlan =
  | { action: 'skip'; reason: string }
  | { action: 'unchanged'; result: EnsembleResult }
  | { action: 'capped'; result: EnsembleResult }
  | { action: 'changed'; result: EnsembleResult }
  | { action: 'restamp'; result: EnsembleResult };

const stampKey = (stamp: unknown) => JSON.stringify(stamp ?? null);

/**
 * Decide what a re-ensemble run does with one review file (pure, no I/O).
 *
 * Tail-stretch run (BRO-4335): only stretch a score that is still the plain
 * combine of its stored per-model scores (or, if already stamped, whose stamped
 * pre-stretch score still equals that combine). Anything else is 'combine drift'
 * (the stored score moved for some other reason) and is left alone, so a flag-on
 * run can only ever apply the stretch, never re-decluster unrelated scores.
 *
 * 'restamp' = score already right but the tailStretch stamp is wrong (e.g. a stale
 * stamp left on a flag-off rollback where the stretch had been a no-op).
 */
export function planReensemble(data: any, opts?: { tailStretch?: boolean; maxDelta?: number }): ReensemblePlan {
  const tailStretch = !!(opts && opts.tailStretch);
  const maxDelta = opts && opts.maxDelta != null ? opts.maxDelta : 20;
  const skipReason = shouldSkip(data, { tailStretch });
  if (skipReason) return { action: 'skip', reason: skipReason };

  const result = recomputeEnsemble(data, { tailStretch });
  const stored = data.llmScore.score;
  const existingStamp = data.ensembleData.tailStretch;

  if (tailStretch) {
    const pre = result.tailStretch ? result.tailStretch.preStretchScore : result.score;
    const expectedPre = existingStamp ? existingStamp.preStretchScore : stored;
    if (pre !== expectedPre) return { action: 'skip', reason: 'combine drift' };
  }

  if (result.score === stored) {
    return stampKey(existingStamp) === stampKey(result.tailStretch)
      ? { action: 'unchanged', result }
      : { action: 'restamp', result };
  }
  if (Math.abs(result.score - stored) > maxDelta) return { action: 'capped', result };
  return { action: 'changed', result };
}

/** Write the tailStretch stamp to match the result: set it, or drop a stale one. */
export function applyStamp(data: any, result: EnsembleResult): void {
  if (result.tailStretch) {
    data.ensembleData.tailStretch = result.tailStretch;
  } else if (data.ensembleData.tailStretch) {
    delete data.ensembleData.tailStretch;
  }
}

/** Apply a 'changed' plan's result to the review record in place. */
export function applyReensemble(data: any, result: EnsembleResult): void {
  const oldLlmScore = data.llmScore.score;
  const newScore = result.score;

  // Preserve old score
  if (!data.llmMetadata) data.llmMetadata = {};
  data.llmMetadata.previousScore = oldLlmScore;

  // Update LLM score fields
  data.llmScore.score = newScore;
  data.llmScore.bucket = result.bucket;
  data.llmScore.thumb = scoreToThumb(newScore);

  // Update assignedScore only if it matched the old LLM score
  // (otherwise a higher-priority source like originalScore was used)
  if (data.assignedScore === oldLlmScore) {
    data.assignedScore = newScore;
  }

  // Update ensemble metadata
  data.ensembleData.ensembleSource = result.source;
  data.ensembleData.modelAgreement = result.agreement;
  data.ensembleData.needsReview = result.needsReview || false;
  data.ensembleData.needsReviewReasons = result.reviewReason ? [result.reviewReason] : [];
  // Which majority/outlier weight set produced this score (task #384 Phase B) —
  // written so mixed v1/v2 batches are distinguishable once ENSEMBLE_V2 ships.
  if (result.ensembleVersion) {
    data.ensembleData.ensembleVersion = result.ensembleVersion;
  }
  // Propagate emergency flag (task #1122, same gap class as #384's ensembleVersion fix) —
  // score excluded from compositeScore until human review clears it.
  if (result.singleModelEmergency) {
    data.ensembleData.singleModelEmergency = true;
  }
  // BRO-4335: record the pre-stretch score; drop a stale stamp on a flag-off rollback.
  applyStamp(data, result);

  data.rescoreReason = result.tailStretch ? 're-ensemble-tail-stretch' : 're-ensemble-v2-decluster';
}

// ========================================
// MAIN
// ========================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
  const maxDeltaArg = args.find(a => a.startsWith('--max-delta='))?.split('=')[1];
  const maxDelta = maxDeltaArg ? parseInt(maxDeltaArg) : 20; // Default: cap at 20-point change
  const tailStretch = isTailStretchEnabled();
  const PROGRESS_FILE = progressFileFor(tailStretch);

  console.log(`Re-ensemble scores${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Max delta: ${maxDelta} (changes beyond this are skipped)`);
  if (showFilter) console.log(`Filtering to show: ${showFilter}`);
  if (tailStretch) console.log('ENSEMBLE_TAIL_STRETCH=1: llm-v6 reviews only, tail stretch applied (BRO-4335)');

  // Load progress for resume
  let processedFiles = new Set<string>();
  if (!dryRun && fs.existsSync(PROGRESS_FILE)) {
    try {
      const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      processedFiles = new Set(progress.processedFiles || []);
      console.log(`Resuming: ${processedFiles.size} files already processed`);
    } catch {
      // Ignore corrupt progress file
    }
  }

  // Walk show directories (holding folders and sidecars excluded)
  const reviewFiles = listReensembleFiles(REVIEW_TEXTS_DIR, showFilter);

  let totalFiles = 0;
  let skipped = 0;
  let unchanged = 0;
  let changed = 0;
  let errors = 0;
  let capped = 0;
  let restamped = 0;
  let drift = 0;
  const changeDetails: Array<{ file: string; oldScore: number; newScore: number; oldBucket: string; newBucket: string }> = [];
  const cappedDetails: Array<{ file: string; oldScore: number; newScore: number; delta: number }> = [];
  const newProcessedFiles: string[] = [];

  for (const [showDir, file] of reviewFiles) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const filePath = path.join(showPath, file);
    const relPath = path.join(showDir, file);
    totalFiles++;

    // Skip if already processed (resume mode)
    if (processedFiles.has(relPath)) {
      skipped++;
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const plan = planReensemble(data, { tailStretch, maxDelta });
      if (plan.action === 'skip') {
        skipped++;
        if (plan.reason === 'combine drift') drift++;
        continue;
      }

      const oldLlmScore = data.llmScore.score;
      const result = plan.result;
      const newScore = result.score;

      if (plan.action === 'unchanged') {
        unchanged++;
      } else if (plan.action === 'restamp') {
        // Score already right; only the tailStretch stamp is stale/missing.
        restamped++;
        if (!dryRun) {
          applyStamp(data, result);
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
      } else if (plan.action === 'capped') {
        // Safety cap: skip extreme changes (likely broken old defaults)
        capped++;
        cappedDetails.push({ file: relPath, oldScore: oldLlmScore, newScore, delta: newScore - oldLlmScore });
      } else {
        changed++;
        const oldBucket = data.llmScore.bucket || 'unknown';
        changeDetails.push({ file: relPath, oldScore: oldLlmScore, newScore, oldBucket, newBucket: result.bucket });

        if (!dryRun) {
          applyReensemble(data, result);
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        }
      }

      newProcessedFiles.push(relPath);

      // Checkpoint
      if (!dryRun && newProcessedFiles.length % CHECKPOINT_INTERVAL === 0) {
        const allProcessed = Array.from(processedFiles).concat(newProcessedFiles);
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processedFiles: allProcessed, timestamp: new Date().toISOString() }));
        console.log(`  Checkpoint: ${allProcessed.length} files processed, ${changed} changed`);
      }
    } catch (err: any) {
      errors++;
      if (errors <= 5) console.error(`Error processing ${relPath}: ${err.message}`);
    }
  }

  // Final checkpoint
  if (!dryRun && newProcessedFiles.length > 0) {
    const allProcessed = Array.from(processedFiles).concat(newProcessedFiles);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processedFiles: allProcessed, timestamp: new Date().toISOString() }));
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Total files:  ${totalFiles}`);
  console.log(`Skipped:      ${skipped}`);
  console.log(`Unchanged:    ${unchanged}`);
  console.log(`Changed:      ${changed}`);
  console.log(`Capped (>${maxDelta}pt): ${capped}`);
  console.log(`Errors:       ${errors}`);
  // Printed only when non-zero so a flag-off run with no stamps on disk prints exactly what it always did.
  if (restamped > 0) console.log(`Restamped (tailStretch stamp only): ${restamped}`);
  if (drift > 0) console.log(`Skipped, combine drift (tail-stretch run): ${drift}`);

  if (changeDetails.length > 0) {
    console.log(`\n=== CHANGED SCORES (${dryRun ? 'PREVIEW' : 'APPLIED'}) ===`);

    // Show distribution of changes
    const deltaDistrib: Record<number, number> = {};
    for (const c of changeDetails) {
      const delta = c.newScore - c.oldScore;
      deltaDistrib[delta] = (deltaDistrib[delta] || 0) + 1;
    }
    console.log('\nScore deltas:');
    for (const [delta, count] of Object.entries(deltaDistrib).sort((a, b) => +a[0] - +b[0])) {
      console.log(`  ${+delta > 0 ? '+' : ''}${delta}: ${count} reviews`);
    }

    // Show bucket boundary crossings
    const crossings = changeDetails.filter(c => c.oldBucket !== c.newBucket);
    if (crossings.length > 0) {
      console.log(`\nBucket crossings: ${crossings.length}`);
      const bucketChanges: Record<string, number> = {};
      for (const c of crossings) {
        const key = `${c.oldBucket} → ${c.newBucket}`;
        bucketChanges[key] = (bucketChanges[key] || 0) + 1;
      }
      for (const [change, count] of Object.entries(bucketChanges).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${change}: ${count}`);
      }
    }

    // Show capped reviews
    if (cappedDetails.length > 0) {
      console.log(`\nCapped reviews (delta > ${maxDelta}, NOT changed):`);
      for (const c of cappedDetails.slice(0, 20)) {
        console.log(`  ${c.delta > 0 ? '+' : ''}${c.delta} | ${c.file}: ${c.oldScore} → ${c.newScore}`);
      }
      if (cappedDetails.length > 20) {
        console.log(`  ... and ${cappedDetails.length - 20} more`);
      }
    }

    // Show first 20 changes for inspection
    if (showFilter || changeDetails.length <= 30) {
      console.log('\nAll changes:');
      for (const c of changeDetails) {
        console.log(`  ${c.file}: ${c.oldScore} → ${c.newScore} (${c.oldBucket} → ${c.newBucket})`);
      }
    } else {
      console.log('\nSample changes (first 20):');
      for (const c of changeDetails.slice(0, 20)) {
        console.log(`  ${c.file}: ${c.oldScore} → ${c.newScore} (${c.oldBucket} → ${c.newBucket})`);
      }
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
