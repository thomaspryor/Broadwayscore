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
 */

import * as fs from 'fs';
import * as path from 'path';
import { ensembleScoreFromArray, scoreToBucket } from './llm-scoring/ensemble';
import type { ModelScore, Bucket } from './llm-scoring/types';

// ========================================
// CONFIG
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const PROGRESS_FILE = path.join(__dirname, '..', 'data', 're-ensemble-progress.json');
const CHECKPOINT_INTERVAL = 500;

// ========================================
// HELPERS
// ========================================

function scoreToThumb(score: number): 'Up' | 'Flat' | 'Down' {
  if (score >= 70) return 'Up';
  if (score >= 55) return 'Flat';
  return 'Down';
}

function extractModelScores(ensembleData: any): ModelScore[] {
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

function shouldSkip(data: any): string | null {
  if (!data.ensembleData) return 'no ensembleData';

  // Skip rejected reviews
  if (data.rejectedAt || data.rejectionReason) return 'rejected';

  // Skip if no llmScore (means scoring never completed)
  if (!data.llmScore || data.llmScore.score == null) return 'no llmScore';

  const modelScores = extractModelScores(data.ensembleData);
  if (modelScores.length < 2) return `only ${modelScores.length} model scores`;

  return null;
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

  console.log(`Re-ensemble scores${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Max delta: ${maxDelta} (changes beyond this are skipped)`);
  if (showFilter) console.log(`Filtering to show: ${showFilter}`);

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

  // Walk show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    const full = path.join(REVIEW_TEXTS_DIR, d);
    if (!fs.statSync(full).isDirectory()) return false;
    if (showFilter && d !== showFilter) return false;
    return true;
  });

  let totalFiles = 0;
  let skipped = 0;
  let unchanged = 0;
  let changed = 0;
  let errors = 0;
  let capped = 0;
  const changeDetails: Array<{ file: string; oldScore: number; newScore: number; oldBucket: string; newBucket: string }> = [];
  const cappedDetails: Array<{ file: string; oldScore: number; newScore: number; delta: number }> = [];
  const newProcessedFiles: string[] = [];

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
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

        const skipReason = shouldSkip(data);
        if (skipReason) {
          skipped++;
          continue;
        }

        // Reconstruct ModelScore[] from stored data
        const modelScores = extractModelScores(data.ensembleData);

        // Run updated ensemble logic
        const result = ensembleScoreFromArray(modelScores);

        const oldLlmScore = data.llmScore.score;
        const newScore = result.score;

        if (oldLlmScore === newScore) {
          unchanged++;
        } else if (Math.abs(newScore - oldLlmScore) > maxDelta) {
          // Safety cap: skip extreme changes (likely broken old defaults)
          capped++;
          cappedDetails.push({ file: relPath, oldScore: oldLlmScore, newScore, delta: newScore - oldLlmScore });
        } else {
          changed++;
          const oldBucket = data.llmScore.bucket || 'unknown';
          changeDetails.push({ file: relPath, oldScore: oldLlmScore, newScore, oldBucket, newBucket: result.bucket });

          if (!dryRun) {
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

            data.rescoreReason = 're-ensemble-v2-decluster';

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

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
