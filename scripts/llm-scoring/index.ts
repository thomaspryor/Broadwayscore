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
 *   --dry-run             Don't save results, just print what would happen
 *   --verbose             Detailed logging
 *   --limit=N             Only process N reviews
 *   --calibrate           Run calibration analysis after scoring
 *   --validate            Run aggregator validation after scoring
 *   --model=<model>       Claude model to use (sonnet or haiku)
 *   --rate-limit=N        Delay between API calls in ms (default: 100)
 *
 * Examples:
 *   # Score all unscored reviews for one show
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --show=cabaret-2024
 *
 *   # Score all shows, run calibration and validation
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --all --calibrate --validate
 *
 *   # Dry run with verbose output
 *   ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --dry-run --verbose --limit=5
 *
 *   # Just run calibration (no scoring)
 *   npx ts-node scripts/llm-scoring/index.ts --calibrate-only
 *
 *   # Just run validation (no scoring)
 *   npx ts-node scripts/llm-scoring/index.ts --validate-only
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReviewScorer } from './scorer';
import { runCalibration } from './calibration';
import { runValidation } from './validation';
import { ReviewTextFile, ScoringPipelineOptions, PipelineRunSummary } from './types';

// ========================================
// CONSTANTS
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '../../data/review-texts');
const RUNS_LOG_PATH = path.join(__dirname, '../../data/llm-scoring-runs.json');

// ========================================
// CLI PARSING
// ========================================

function parseArgs(): ScoringPipelineOptions & {
  calibrateOnly: boolean;
  validateOnly: boolean;
} {
  const args = process.argv.slice(2);

  const showArg = args.find(a => a.startsWith('--show='));
  const showId = showArg ? showArg.split('=')[1] : undefined;

  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined;

  const rateLimitArg = args.find(a => a.startsWith('--rate-limit='));
  const rateLimitMs = rateLimitArg ? parseInt(rateLimitArg.split('=')[1]) : 100;

  const modelArg = args.find(a => a.startsWith('--model='));
  const modelChoice = modelArg ? modelArg.split('=')[1] : 'sonnet';
  const model = modelChoice === 'haiku'
    ? 'claude-3-5-haiku-20241022' as const
    : 'claude-sonnet-4-20250514' as const;

  return {
    showId,
    unscoredOnly: !args.includes('--rescore'),
    minTextLength: 50,
    model,
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    limit,
    rateLimitMs,
    runCalibration: args.includes('--calibrate'),
    runValidation: args.includes('--validate'),
    calibrateOnly: args.includes('--calibrate-only'),
    validateOnly: args.includes('--validate-only')
  };
}

// ========================================
// FILE OPERATIONS
// ========================================

/**
 * Get all review text files
 */
function getAllReviewFiles(showId?: string): Array<{ path: string; data: ReviewTextFile }> {
  const files: Array<{ path: string; data: ReviewTextFile }> = [];

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    return files;
  }

  const shows = showId
    ? [showId]
    : fs.readdirSync(REVIEW_TEXTS_DIR).filter(f =>
        fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory()
      );

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
 * Save scored review file
 */
function saveReviewFile(filePath: string, data: any): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
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

  // Check for API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts [options]');
    process.exit(1);
  }

  // Initialize scorer
  const scorer = new ReviewScorer(apiKey, {
    model: options.model,
    verbose: options.verbose
  });

  // Get review files
  const allFiles = getAllReviewFiles(options.showId);

  if (allFiles.length === 0) {
    console.log('No review files found.');
    if (options.showId) {
      console.log(`Check if show directory exists: ${path.join(REVIEW_TEXTS_DIR, options.showId)}`);
    }
    return;
  }

  // Filter to unscored if requested
  const filesToProcess = options.unscoredOnly
    ? allFiles.filter(f => !(f.data as any).llmScore)
    : allFiles;

  // Apply text length filter
  const validFiles = filesToProcess.filter(f =>
    f.data.fullText && f.data.fullText.length >= options.minTextLength
  );

  // Apply limit
  const finalFiles = options.limit
    ? validFiles.slice(0, options.limit)
    : validFiles;

  // Summary
  console.log('=== LLM Review Scoring Pipeline ===\n');
  console.log(`Model: ${options.model}`);
  console.log(`Total review files: ${allFiles.length}`);
  console.log(`Unscored files: ${filesToProcess.length}`);
  console.log(`Valid files (text >= ${options.minTextLength} chars): ${validFiles.length}`);
  console.log(`Files to process: ${finalFiles.length}`);
  if (options.dryRun) console.log('DRY RUN - no files will be modified\n');
  console.log('');

  if (finalFiles.length === 0) {
    console.log('No reviews to process.');

    // Still run calibration/validation if requested
    if (options.runCalibration) {
      runCalibration(true);
    }
    if (options.runValidation) {
      runValidation(true);
    }
    return;
  }

  // Process files
  const startedAt = new Date().toISOString();
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails: Array<{ showId: string; outletId: string; error: string }> = [];

  for (let i = 0; i < finalFiles.length; i++) {
    const { path: filePath, data: reviewFile } = finalFiles[i];

    // Progress
    const showName = reviewFile.showId;
    const outletName = reviewFile.outlet || reviewFile.outletId;
    process.stdout.write(`[${i + 1}/${finalFiles.length}] ${showName} / ${outletName}... `);

    try {
      const result = await scorer.scoreReviewFile(reviewFile);

      if (result.success && result.scoredFile) {
        if (!options.dryRun) {
          saveReviewFile(filePath, result.scoredFile);
        }

        const score = result.scoredFile.llmScore.score;
        const bucket = result.scoredFile.llmScore.bucket;
        const confidence = result.scoredFile.llmScore.confidence;

        console.log(`${score} (${bucket}, ${confidence})`);
        processed++;
      } else {
        console.log(`FAILED: ${result.error}`);
        errors++;
        errorDetails.push({
          showId: reviewFile.showId,
          outletId: reviewFile.outletId || '',
          error: result.error || 'Unknown error'
        });
      }
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
      errors++;
      errorDetails.push({
        showId: reviewFile.showId,
        outletId: reviewFile.outletId || '',
        error: e.message
      });
    }

    // Rate limiting
    if (i < finalFiles.length - 1) {
      await new Promise(r => setTimeout(r, options.rateLimitMs));
    }
  }

  // Summary
  const completedAt = new Date().toISOString();
  const tokenUsage = scorer.getTokenUsage();

  console.log('\n========================================');
  console.log(`Processed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Tokens used: ${tokenUsage.total.toLocaleString()} (input: ${tokenUsage.input.toLocaleString()}, output: ${tokenUsage.output.toLocaleString()})`);

  // Estimate cost (rough, based on public pricing)
  const inputCostPer1M = options.model.includes('haiku') ? 0.80 : 3.00;
  const outputCostPer1M = options.model.includes('haiku') ? 4.00 : 15.00;
  const estimatedCost = (tokenUsage.input / 1_000_000) * inputCostPer1M +
                        (tokenUsage.output / 1_000_000) * outputCostPer1M;
  console.log(`Estimated cost: $${estimatedCost.toFixed(4)}`);

  // Save run summary
  if (!options.dryRun) {
    const summary: PipelineRunSummary = {
      startedAt,
      completedAt,
      totalReviews: allFiles.length,
      processed,
      skipped: allFiles.length - validFiles.length,
      errors,
      tokensUsed: tokenUsage,
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
  } else {
    // Still run calibration/validation if requested
    if (options.runCalibration) {
      runCalibration(true);
    }
    if (options.runValidation) {
      runValidation(true);
    }
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
  --dry-run             Don't save results, just print what would happen
  --verbose             Detailed logging
  --limit=N             Only process N reviews
  --calibrate           Run calibration analysis after scoring
  --validate            Run aggregator validation after scoring
  --calibrate-only      Only run calibration (no scoring)
  --validate-only       Only run validation (no scoring)
  --model=<model>       Claude model: sonnet (default) or haiku
  --rate-limit=N        Delay between API calls in ms (default: 100)

Examples:
  # Score all unscored reviews for one show
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --show=cabaret-2024

  # Score all shows with calibration and validation
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --all --calibrate --validate

  # Dry run with verbose output
  ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts --dry-run --verbose --limit=5

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
