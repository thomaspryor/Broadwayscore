#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * Helen Shaw NYT Lost Boys regression fixture (Issue #7, 2026-04-26)
 *
 * Standalone test that scores the frozen fixture review through the 3-model
 * ensemble using the candidate `SYSTEM_PROMPT_V5_STRUCTURAL` prompt and asserts
 * the result lands in the 75-82 range (mid-Positive). This is the gating
 * regression for the praise→critique→wistful-close failure mode.
 *
 * The fixture itself (review text, baseline, assertion bounds) is committed at
 * `tests/fixtures/llm-prompt/helen-shaw-nyt-lost-boys-2026.json`. The fixture
 * is frozen — do not regenerate from disk.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/llm-scoring/test-helen-shaw-fixture.ts
 *   --baseline   also score with current prompt for side-by-side comparison
 *   --verbose    print model-by-model scores
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
} from './config';

try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
} catch {}

const FIXTURE_PATH = path.join(__dirname, '../../tests/fixtures/llm-prompt/helen-shaw-nyt-lost-boys-2026.json');

interface Fixture {
  schemaVersion: number;
  fixtureName: string;
  source: {
    showId: string;
    showTitle: string;
    outlet: string;
    outletId: string;
    criticName: string;
    category: string;
    venue: string;
    publishDate: string;
    reviewUrl: string | null;
  };
  fullText: string;
  baseline: {
    promptVersion: string;
    ensembleScore: number;
    ensembleBucket: string;
    perModel: Record<string, { score: number; bucket: string }>;
    manualOverride: { score: number; bucket: string; notes: string };
  };
  assertion: {
    targetMin: number;
    targetMax: number;
    targetBucket: string;
    notes: string;
  };
}

async function scoreEnsemble(
  scorers: { claude: ReviewScorer; openai: OpenAIReviewScorer; gemini: GeminiScorer },
  text: string,
  context: string,
  systemPrompt: string
) {
  const [claudeOutcome, openaiOutcome, geminiOutcome] = await Promise.all([
    scorers.claude.scoreReviewV5(text, context, systemPrompt),
    scorers.openai.scoreReviewV5(text, context, systemPrompt),
    scorers.gemini.scoreReview(text, context, systemPrompt),
  ]);
  const claudeR = (claudeOutcome.success && !claudeOutcome.rejected) ? claudeOutcome.result! : null;
  const openaiR = (openaiOutcome.success && !openaiOutcome.rejected) ? openaiOutcome.result! : null;
  const geminiR = (geminiOutcome.success && !geminiOutcome.rejected) ? geminiOutcome.result! : null;

  const ens = ensembleScore(
    claudeR ? toModelScore(claudeR, 'claude') : null,
    openaiR ? toModelScore(openaiR, 'openai') : null,
    geminiR ? toModelScore(geminiR, 'gemini') : null
  );

  return { ens, perModel: { claude: claudeR, openai: openaiR, gemini: geminiR } };
}

async function main() {
  const args = process.argv.slice(2);
  const VERBOSE = args.includes('--verbose');
  const ALSO_BASELINE = args.includes('--baseline');

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!claudeKey || !openaiKey || !geminiKey) {
    console.error('Missing API key(s). Need ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.');
    process.exit(1);
  }

  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`Fixture missing: ${FIXTURE_PATH}`);
    process.exit(1);
  }

  const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

  const scorers = {
    claude: new ReviewScorer(claudeKey, { model: 'claude-sonnet-4-6', verbose: false }),
    openai: new OpenAIReviewScorer(openaiKey, { model: 'gpt-4o', verbose: false }),
    // gemini-2.5-flash for separate quota pool — see test-prompt-structural-ab.ts
    gemini: new GeminiScorer(geminiKey, { model: 'gemini-2.5-flash' as any, verbose: false }),
  };

  const reviewData: ReviewInputData = {
    showId: fixture.source.showId,
    showTitle: fixture.source.showTitle,
    outlet: fixture.source.outlet,
    outletId: fixture.source.outletId,
    criticName: fixture.source.criticName,
    publishDate: fixture.source.publishDate,
    category: fixture.source.category,
    venue: fixture.source.venue,
    fullText: fixture.fullText,
  };
  const built = buildScoringInput(reviewData);

  console.log('='.repeat(70));
  console.log(`  Helen Shaw NYT Lost Boys regression fixture`);
  console.log(`  Target: ${fixture.assertion.targetMin}-${fixture.assertion.targetMax} (${fixture.assertion.targetBucket})`);
  console.log(`  Baseline (${fixture.baseline.promptVersion}): ${fixture.baseline.ensembleScore} (${fixture.baseline.ensembleBucket})`);
  console.log('='.repeat(70));

  if (ALSO_BASELINE) {
    console.log(`\n[1/2] Scoring with OLD prompt (${PROMPT_VERSION})...`);
    const oldRun = await scoreEnsemble(scorers, built.text, built.context, SYSTEM_PROMPT_V5);
    console.log(`  Ensemble: ${oldRun.ens.score} (${oldRun.ens.bucket}) [${oldRun.ens.source}]`);
    if (VERBOSE) {
      console.log(`    claude: ${oldRun.perModel.claude?.score} (${oldRun.perModel.claude?.bucket})`);
      console.log(`    openai: ${oldRun.perModel.openai?.score} (${oldRun.perModel.openai?.bucket})`);
      console.log(`    gemini: ${oldRun.perModel.gemini?.score} (${oldRun.perModel.gemini?.bucket})`);
    }
  }

  const stage = ALSO_BASELINE ? `[2/2] ` : '';
  console.log(`\n${stage}Scoring with CANDIDATE prompt (${PROMPT_VERSION_CANDIDATE})...`);
  const newRun = await scoreEnsemble(scorers, built.text, built.context, SYSTEM_PROMPT_V5_STRUCTURAL);
  console.log(`  Ensemble: ${newRun.ens.score} (${newRun.ens.bucket}) [${newRun.ens.source}]`);
  if (VERBOSE) {
    console.log(`    claude: ${newRun.perModel.claude?.score} (${newRun.perModel.claude?.bucket})`);
    console.log(`    openai: ${newRun.perModel.openai?.score} (${newRun.perModel.openai?.bucket})`);
    console.log(`    gemini: ${newRun.perModel.gemini?.score} (${newRun.perModel.gemini?.bucket})`);
  }

  const score = newRun.ens.score;
  const passed = score >= fixture.assertion.targetMin && score <= fixture.assertion.targetMax;

  console.log('\n' + '='.repeat(70));
  if (passed) {
    console.log(`  ✅ FIXTURE PASSED — score ${score} in [${fixture.assertion.targetMin}, ${fixture.assertion.targetMax}]`);
  } else {
    console.log(`  ⛔ FIXTURE FAILED — score ${score} OUTSIDE [${fixture.assertion.targetMin}, ${fixture.assertion.targetMax}]`);
    console.log(`     Iterate the structural-prompt guidance and rerun.`);
  }
  console.log('='.repeat(70) + '\n');

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(99);
});
