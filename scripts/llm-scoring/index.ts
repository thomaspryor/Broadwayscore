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
import { ReviewScorer } from './scorer';
import { EnsembleReviewScorer } from './ensemble-scorer';
import { runCalibration } from './calibration';
import { runValidation } from './validation';
import { findGroundTruthReviews, calculateGroundTruthCalibration, printGroundTruthReport } from './ground-truth';
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
  ensemble: boolean;
  groundTruth: boolean;
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
    validateOnly: args.includes('--validate-only'),
    ensemble: args.includes('--ensemble'),
    groundTruth: args.includes('--ground-truth')
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

  if (!claudeApiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx ts-node scripts/llm-scoring/index.ts [options]');
    process.exit(1);
  }

  if (options.ensemble && !openaiApiKey) {
    console.error('Error: OPENAI_API_KEY environment variable required for ensemble mode');
    console.error('Usage: ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npx ts-node scripts/llm-scoring/index.ts --ensemble');
    process.exit(1);
  }

  // Initialize scorer (single or ensemble)
  let scorer: ReviewScorer | EnsembleReviewScorer;

  if (options.ensemble) {
    scorer = new EnsembleReviewScorer(claudeApiKey, openaiApiKey!, {
      claudeModel: options.model,
      openaiModel: 'gpt-4o-mini',
      verbose: options.verbose
    });
    console.log('Using ENSEMBLE mode (Claude + GPT-4o-mini)\n');
  } else {
    scorer = new ReviewScorer(claudeApiKey, {
      model: options.model,
      verbose: options.verbose
    });
  }

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

  // Helper to get scorable text (fullText or excerpts)
  const getScorableText = (data: ReviewTextFile): string | null => {
    // Check fullText first (but not if it's an error page)
    if (data.fullText && data.fullText.length >= 100) {
      const lower = data.fullText.toLowerCase();
      if (!lower.includes('page not found') &&
          !lower.includes('404') &&
          !lower.includes('access denied')) {
        return data.fullText;
      }
    }

    // Fall back to excerpts
    const excerpts: string[] = [];
    if (data.bwwExcerpt) excerpts.push(data.bwwExcerpt);
    if (data.dtliExcerpt && data.dtliExcerpt !== data.bwwExcerpt) {
      excerpts.push(data.dtliExcerpt);
    }
    if (data.showScoreExcerpt &&
        data.showScoreExcerpt !== data.bwwExcerpt &&
        data.showScoreExcerpt !== data.dtliExcerpt) {
      excerpts.push(data.showScoreExcerpt);
    }

    if (excerpts.length > 0) {
      const combined = excerpts.join('\n\n');
      if (combined.length >= options.minTextLength) {
        return combined;
      }
    }

    return null;
  };

  // Apply text length filter - now includes reviews with excerpts
  const validFiles = filesToProcess.filter(f => getScorableText(f.data) !== null);

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

        // Show ensemble details if available
        const ensembleInfo = result.scoredFile.ensembleData
          ? ` [C:${result.scoredFile.ensembleData.claudeScore} O:${result.scoredFile.ensembleData.openaiScore}${result.scoredFile.ensembleData.needsReview ? ' ⚠️' : ''}]`
          : '';

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

  // Handle both single and ensemble scorer token usage
  if ('claude' in tokenUsage) {
    // Ensemble scorer
    const ensembleUsage = tokenUsage as { claude: { input: number; output: number }; openai: { input: number; output: number }; total: number };
    console.log(`Claude tokens: ${(ensembleUsage.claude.input + ensembleUsage.claude.output).toLocaleString()} (in: ${ensembleUsage.claude.input.toLocaleString()}, out: ${ensembleUsage.claude.output.toLocaleString()})`);
    console.log(`OpenAI tokens: ${(ensembleUsage.openai.input + ensembleUsage.openai.output).toLocaleString()} (in: ${ensembleUsage.openai.input.toLocaleString()}, out: ${ensembleUsage.openai.output.toLocaleString()})`);

    // Estimate cost
    const claudeInputCost = options.model.includes('haiku') ? 0.80 : 3.00;
    const claudeOutputCost = options.model.includes('haiku') ? 4.00 : 15.00;
    const openaiInputCost = 0.15;  // gpt-4o-mini
    const openaiOutputCost = 0.60;

    const claudeCost = (ensembleUsage.claude.input / 1_000_000) * claudeInputCost +
                       (ensembleUsage.claude.output / 1_000_000) * claudeOutputCost;
    const openaiCost = (ensembleUsage.openai.input / 1_000_000) * openaiInputCost +
                       (ensembleUsage.openai.output / 1_000_000) * openaiOutputCost;
    console.log(`Estimated cost: $${(claudeCost + openaiCost).toFixed(4)} (Claude: $${claudeCost.toFixed(4)}, OpenAI: $${openaiCost.toFixed(4)})`);
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
  --ensemble            Use ensemble mode (Claude + GPT-4o-mini for triangulation)
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
