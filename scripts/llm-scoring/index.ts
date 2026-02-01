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
import { runCalibration, runEnsembleCalibration } from './calibration';
import { runValidation } from './validation';
import { findGroundTruthReviews, calculateGroundTruthCalibration, printGroundTruthReport } from './ground-truth';
import { ReviewTextFile, ScoringPipelineOptions, PipelineRunSummary } from './types';

// Import content quality module for garbage detection
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assessTextQuality } = require('../lib/content-quality.js');

import { detectMultiShow } from './multi-show-detector';
import { PROMPT_VERSION } from './config';

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
// CONSTANTS
// ========================================

const REVIEW_TEXTS_DIR = path.join(__dirname, '../../data/review-texts');
const RUNS_LOG_PATH = path.join(__dirname, '../../data/llm-scoring-runs.json');
const GARBAGE_SKIPS_PATH = path.join(__dirname, '../../data/llm-scoring-garbage-skips.json');

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
  outdated: boolean;
  ensembleCalibrateOnly: boolean;
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

  const outdated = args.includes('--outdated');

  return {
    showId,
    unscoredOnly: !args.includes('--rescore') && !args.includes('--needs-rescore') && !outdated,
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
    outdated,
    ensembleCalibrateOnly: args.includes('--ensemble-calibrate')
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
    scorer = new EnsembleReviewScorer(claudeApiKey, openaiApiKey!, geminiApiKey, {
      claudeModel: options.model,
      openaiModel: 'gpt-4o',
      geminiModel: 'gemini-2.0-flash',
      verbose: options.verbose
    });
    const modelCount = (scorer as EnsembleReviewScorer).getModelCount();
    if (modelCount === 3) {
      console.log('Using 3-MODEL ensemble mode (Claude Sonnet + GPT-4o + Gemini 2.0 Flash)\n');
    } else {
      console.log('Using 2-MODEL ensemble mode (Claude Sonnet + GPT-4o)\n');
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

  // Filter based on mode
  let filesToProcess: typeof allFiles;
  if (options.needsRescore) {
    // Filter to reviews flagged for rescoring (had excerpt-based score, now have fullText)
    filesToProcess = allFiles.filter(f => (f.data as any).needsRescore === true);
    console.log(`Filtering to reviews flagged for rescoring: ${filesToProcess.length} reviews\n`);
  } else if (options.outdated) {
    // Filter to reviews scored with an older prompt version
    filesToProcess = allFiles.filter(f => {
      const meta = (f.data as any).llmMetadata;
      if (!meta || !meta.promptVersion) return false;
      return compareSemver(meta.promptVersion, PROMPT_VERSION) < 0;
    });
    console.log(`Filtering to outdated reviews (promptVersion < ${PROMPT_VERSION}): ${filesToProcess.length} reviews\n`);
  } else if (options.unscoredOnly) {
    // Filter to unscored reviews
    filesToProcess = allFiles.filter(f => !(f.data as any).llmScore);
  } else {
    filesToProcess = allFiles;
  }

  // Track garbage skips for logging
  const garbageSkips: GarbageSkipEntry[] = [];

  // Helper to get scorable text (fullText or excerpts)
  // Uses the full content-quality module for comprehensive garbage detection
  const getScorableText = (data: ReviewTextFile, filePath: string): string | null => {
    // Check fullText first (but not if it's garbage)
    if (data.fullText && data.fullText.length >= 100) {
      // Use the comprehensive content-quality module for garbage detection
      const qualityCheck: ContentQualityResult = assessTextQuality(data.fullText, data.showId);

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
    if ((data as any).nycTheatreExcerpt &&
        (data as any).nycTheatreExcerpt !== data.bwwExcerpt &&
        (data as any).nycTheatreExcerpt !== data.dtliExcerpt &&
        (data as any).nycTheatreExcerpt !== data.showScoreExcerpt) {
      excerpts.push((data as any).nycTheatreExcerpt);
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
  const validFiles = filesToProcess.filter(f => getScorableText(f.data, f.path) !== null);

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
  let garbageSkipped = 0;
  let suspiciousWarnings = 0;
  const errorDetails: Array<{ showId: string; outletId: string; error: string }> = [];
  // Note: garbageSkips is declared earlier and shared with getScorableText()

  for (let i = 0; i < finalFiles.length; i++) {
    const { path: filePath, data: reviewFile } = finalFiles[i];

    // Progress
    const showName = reviewFile.showId;
    const outletName = reviewFile.outlet || reviewFile.outletId;
    process.stdout.write(`[${i + 1}/${finalFiles.length}] ${showName} / ${outletName}... `);

    // Pre-scoring content quality check
    const scorableText = getScorableText(reviewFile, filePath);
    if (scorableText && reviewFile.fullText && reviewFile.fullText.length >= 100) {
      // Get show title for context
      const showTitle = reviewFile.showId
        ? reviewFile.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ')
        : '';

      const qualityResult: ContentQualityResult = assessTextQuality(reviewFile.fullText, showTitle);

      if (qualityResult.quality === 'garbage' && qualityResult.confidence === 'high') {
        // Check if we have good excerpts to fall back to
        const hasGoodExcerpts = (reviewFile.bwwExcerpt && reviewFile.bwwExcerpt.length >= 50) ||
                                (reviewFile.dtliExcerpt && reviewFile.dtliExcerpt.length >= 50) ||
                                (reviewFile.showScoreExcerpt && reviewFile.showScoreExcerpt.length >= 50) ||
                                ((reviewFile as any).nycTheatreExcerpt && (reviewFile as any).nycTheatreExcerpt.length >= 50);

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

    // Multi-show detection: skip roundup articles
    if (scorableText && reviewFile.showId) {
      const multiShowResult = detectMultiShow(scorableText, reviewFile.showId);

      if (multiShowResult.recommendation === 'skip') {
        console.log(`SKIPPED (multi-show: ${multiShowResult.reason})`);
        // Mark the file so it's not retried
        if (!options.dryRun) {
          const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fileData.isMultiShowReview = true;
          fileData.multiShowReason = multiShowResult.reason;
          saveReviewFile(filePath, fileData);
        }
        skipped++;
        continue;
      }

      if (multiShowResult.recommendation === 'warn' && options.verbose) {
        console.log(`(WARNING: ${multiShowResult.reason}) `);
      }
    }

    try {
      const result = await scorer.scoreReviewFile(reviewFile);

      if (result.success && result.scoredFile) {
        // Always clear needsRescore flag after successful scoring
        const scoredAny = result.scoredFile as any;
        if (scoredAny.needsRescore) {
          delete scoredAny.needsRescore;
          scoredAny.rescoreCompletedAt = new Date().toISOString();
        }

        if (!options.dryRun) {
          saveReviewFile(filePath, result.scoredFile);
        }

        const score = result.scoredFile.llmScore.score;
        const bucket = result.scoredFile.llmScore.bucket;
        const confidence = result.scoredFile.llmScore.confidence;

        // Show ensemble details if available
        const ed = result.scoredFile.ensembleData;
        let ensembleInfo = '';
        if (ed) {
          const geminiPart = ed.geminiScore !== null && ed.geminiScore !== undefined ? ` G:${ed.geminiScore}` : '';
          ensembleInfo = ` [C:${ed.claudeScore} O:${ed.openaiScore}${geminiPart}${ed.needsReview ? ' ⚠️' : ''}]`;
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
  console.log(`Garbage skipped: ${garbageSkipped}`);
  console.log(`Suspicious warnings: ${suspiciousWarnings}`);
  console.log(`Errors: ${errors}`);

  // Handle both single and ensemble scorer token usage
  if ('claude' in tokenUsage) {
    // Ensemble scorer
    const ensembleUsage = tokenUsage as { claude: { input: number; output: number }; openai: { input: number; output: number }; gemini: { input: number; output: number } | null; total: number };
    console.log(`Claude tokens: ${(ensembleUsage.claude.input + ensembleUsage.claude.output).toLocaleString()} (in: ${ensembleUsage.claude.input.toLocaleString()}, out: ${ensembleUsage.claude.output.toLocaleString()})`);
    console.log(`OpenAI tokens: ${(ensembleUsage.openai.input + ensembleUsage.openai.output).toLocaleString()} (in: ${ensembleUsage.openai.input.toLocaleString()}, out: ${ensembleUsage.openai.output.toLocaleString()})`);
    if (ensembleUsage.gemini) {
      console.log(`Gemini tokens: ${(ensembleUsage.gemini.input + ensembleUsage.gemini.output).toLocaleString()} (in: ${ensembleUsage.gemini.input.toLocaleString()}, out: ${ensembleUsage.gemini.output.toLocaleString()})`);
    }

    // Estimate cost
    const claudeInputCost = options.model.includes('haiku') ? 0.80 : 3.00;
    const claudeOutputCost = options.model.includes('haiku') ? 4.00 : 15.00;
    const openaiInputCost = 2.50;  // gpt-4o
    const openaiOutputCost = 10.00;
    const geminiInputCost = 1.25;  // gemini-1.5-pro
    const geminiOutputCost = 5.00;

    const claudeCost = (ensembleUsage.claude.input / 1_000_000) * claudeInputCost +
                       (ensembleUsage.claude.output / 1_000_000) * claudeOutputCost;
    const openaiCost = (ensembleUsage.openai.input / 1_000_000) * openaiInputCost +
                       (ensembleUsage.openai.output / 1_000_000) * openaiOutputCost;
    const geminiCost = ensembleUsage.gemini
      ? (ensembleUsage.gemini.input / 1_000_000) * geminiInputCost +
        (ensembleUsage.gemini.output / 1_000_000) * geminiOutputCost
      : 0;
    const totalCost = claudeCost + openaiCost + geminiCost;
    const costBreakdown = ensembleUsage.gemini
      ? `Claude: $${claudeCost.toFixed(4)}, OpenAI: $${openaiCost.toFixed(4)}, Gemini: $${geminiCost.toFixed(4)}`
      : `Claude: $${claudeCost.toFixed(4)}, OpenAI: $${openaiCost.toFixed(4)}`;
    console.log(`Estimated cost: $${totalCost.toFixed(4)} (${costBreakdown})`);
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
  --outdated            Re-score reviews with promptVersion older than current
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
