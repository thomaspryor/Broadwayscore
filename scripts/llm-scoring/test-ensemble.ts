#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * Ensemble Scorer Pre-flight Test
 *
 * Tests the 3-model ensemble with real API keys and various review scenarios.
 * Verifies:
 * - All 3 models respond correctly
 * - Ensemble voting logic works
 * - Graceful degradation works (2-model, 1-model fallback)
 * - Input builder context generation works
 *
 * Run: ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
 *      npx ts-node scripts/llm-scoring/test-ensemble.ts
 *
 * Or for 2-model mode (no Gemini):
 *      ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *      npx ts-node scripts/llm-scoring/test-ensemble.ts --2model
 */

import { EnsembleReviewScorer } from './ensemble-scorer';
import { buildScoringInput, ReviewInputData } from './input-builder';

// ========================================
// TEST REVIEWS
// ========================================

const TEST_REVIEWS: Array<{
  name: string;
  reviewData: ReviewInputData;
  expectedBucket: 'Rave' | 'Positive' | 'Mixed' | 'Negative' | 'Pan';
  tolerance: number; // Allow bucket distance up to this
}> = [
  {
    name: 'Clear Rave (5 stars)',
    reviewData: {
      showTitle: 'Stereophonic',
      outlet: 'The New York Times',
      outletId: 'nytimes',
      criticName: 'Test Critic',
      fullText: `Daniel Aukin's superb production navigates the change without missing a beat.
The jam has been preserved. With the greater sense of distance at the Golden Theatre,
Stereophonic feels more than ever like watching a wide-screen film. There's nary a
false note. The result is richly satisfying multitrack production that showcases
one of the best ensemble casts on Broadway. An absolute triumph. (5/5 stars)`
    },
    expectedBucket: 'Rave',
    tolerance: 1 // Allow Positive as it's adjacent
  },
  {
    name: 'Mixed Review (uneven)',
    reviewData: {
      showTitle: 'Some Musical',
      outlet: 'Variety',
      outletId: 'variety',
      criticName: 'Test Critic',
      fullText: `The performances are committed, particularly in the lead role, but the play's
paranoid spiral feels more dated than prescient now. The first act sings while the second
drags. Worth seeing for the acting, but temper expectations. It's a mixed bag that will
appeal to some audiences more than others.`
    },
    expectedBucket: 'Mixed',
    tolerance: 1
  },
  {
    name: 'Negative Review (disappointing)',
    reviewData: {
      showTitle: 'Failed Show',
      outlet: 'The Hollywood Reporter',
      outletId: 'thr',
      criticName: 'Test Critic',
      fullText: `What should be a thrilling evening of theater is instead a tedious slog through
underwritten characters and predictable plot beats. The performers seem stranded by the
material, forced to emote wildly to compensate for the script's emptiness. The direction
is uninspired and the score is forgettable. Skip this one.`
    },
    expectedBucket: 'Negative',
    tolerance: 1
  },
  {
    name: 'Excerpt Only (truncated warning)',
    reviewData: {
      showTitle: 'Suffs',
      outlet: 'Washington Post',
      outletId: 'washpost',
      criticName: 'Test Critic',
      bwwExcerpt: `When "Suffs" premiered at the Public Theatre two years ago, it was a didactic, dull, overstuffed mess.`,
      dtliExcerpt: `What "Suffs" does capture is the excitement and urgency of being swept up in the fight for a just cause.`,
      bwwThumb: 'Up',
      dtliThumb: 'Up'
    },
    expectedBucket: 'Positive', // Should trust thumbs for truncated text
    tolerance: 2 // More tolerance for excerpt-only
  }
];

// ========================================
// TEST RUNNER
// ========================================

async function runTests() {
  console.log('='.repeat(60));
  console.log('  ENSEMBLE SCORER PRE-FLIGHT TEST');
  console.log('='.repeat(60) + '\n');

  // Check API keys
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!claudeKey) {
    console.error('ERROR: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  if (!openaiKey) {
    console.error('ERROR: OPENAI_API_KEY not set');
    process.exit(1);
  }

  const use2ModelMode = process.argv.includes('--2model') || !geminiKey;

  console.log('API Keys:');
  console.log(`  Claude: ${claudeKey ? '✅' : '❌'}`);
  console.log(`  OpenAI: ${openaiKey ? '✅' : '❌'}`);
  console.log(`  Gemini: ${geminiKey ? '✅' : (use2ModelMode ? '⏭️ (2-model mode)' : '❌')}`);
  console.log('');
  console.log(`Mode: ${use2ModelMode ? '2-model (Claude + OpenAI)' : '3-model (Claude + OpenAI + Gemini)'}`);
  console.log('');

  // Create scorer
  const scorer = new EnsembleReviewScorer(
    claudeKey!,
    openaiKey!,
    use2ModelMode ? undefined : geminiKey,
    {
      claudeModel: 'claude-sonnet-4-20250514',
      openaiModel: 'gpt-4o',
      geminiModel: 'gemini-2.0-flash',
      verbose: true
    }
  );

  console.log(`Model count: ${scorer.getModelCount()}`);
  console.log('');

  // Track results
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  // Run tests
  for (const test of TEST_REVIEWS) {
    console.log('-'.repeat(60));
    console.log(`TEST: ${test.name}`);
    console.log('-'.repeat(60));

    // Build input context
    const scoringInput = buildScoringInput(test.reviewData);

    console.log('\nInput Analysis:');
    console.log(`  Text quality: ${scoringInput.textQuality}`);
    console.log(`  Confidence: ${scoringInput.confidence}`);
    console.log(`  Has aggregator context: ${scoringInput.includesAggregatorContext}`);
    console.log(`  Text length: ${scoringInput.text.length} chars`);

    if (scoringInput.context) {
      console.log(`  Context preview: ${scoringInput.context.substring(0, 100)}...`);
    }

    try {
      console.log('\nScoring with ensemble...\n');
      const result = await scorer.scoreReview(scoringInput.text, scoringInput.context);

      console.log('\nResult:');
      console.log(`  Final Bucket: ${result.bucket}`);
      console.log(`  Final Score: ${result.score}`);
      console.log(`  Confidence: ${result.confidence}`);
      console.log(`  Source: ${result.source}`);
      console.log(`  Agreement: ${result.agreement || 'N/A'}`);

      console.log('\nModel Results:');
      if (result.modelResults.claude) {
        console.log(`  Claude: ${result.modelResults.claude.bucket} (${result.modelResults.claude.score})${result.modelResults.claude.error ? ' [ERROR]' : ''}`);
      }
      if (result.modelResults.openai) {
        console.log(`  OpenAI: ${result.modelResults.openai.bucket} (${result.modelResults.openai.score})${result.modelResults.openai.error ? ' [ERROR]' : ''}`);
      }
      if (result.modelResults.gemini !== undefined) {
        if (result.modelResults.gemini) {
          console.log(`  Gemini: ${result.modelResults.gemini.bucket} (${result.modelResults.gemini.score})${result.modelResults.gemini.error ? ' [ERROR]' : ''}`);
        } else {
          console.log(`  Gemini: N/A (not configured)`);
        }
      }

      if (result.outlier) {
        console.log(`\n  Outlier detected: ${result.outlier.model} chose ${result.outlier.bucket}`);
      }

      if (result.needsReview) {
        console.log(`\n  ⚠️  Needs review: ${result.reviewReason}`);
      }

      // Check result
      const bucketOrder = ['Pan', 'Negative', 'Mixed', 'Positive', 'Rave'];
      const expectedIdx = bucketOrder.indexOf(test.expectedBucket);
      const actualIdx = bucketOrder.indexOf(result.bucket);
      const distance = Math.abs(expectedIdx - actualIdx);

      if (distance <= test.tolerance) {
        console.log(`\n✅ PASSED: Bucket ${result.bucket} is within tolerance of expected ${test.expectedBucket}`);
        passed++;
      } else {
        console.log(`\n❌ FAILED: Expected ${test.expectedBucket}, got ${result.bucket} (distance ${distance}, tolerance ${test.tolerance})`);
        failed++;
        failures.push(`${test.name}: Expected ${test.expectedBucket}, got ${result.bucket}`);
      }
    } catch (error: any) {
      console.error(`\n❌ ERROR: ${error.message}`);
      failed++;
      failures.push(`${test.name}: Error - ${error.message}`);
    }

    console.log('');
  }

  // Summary
  console.log('='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Passed: ${passed}/${TEST_REVIEWS.length}`);
  console.log(`  Failed: ${failed}/${TEST_REVIEWS.length}`);

  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
  }

  // Token usage
  const usage = scorer.getTokenUsage();
  console.log('\n  Token Usage:');
  console.log(`    Claude: ${usage.claude.input} in / ${usage.claude.output} out`);
  console.log(`    OpenAI: ${usage.openai.input} in / ${usage.openai.output} out`);
  if (usage.gemini) {
    console.log(`    Gemini: ${usage.gemini.input} in / ${usage.gemini.output} out`);
  }
  console.log(`    Total: ${usage.total} tokens`);

  console.log('');

  if (failed > 0) {
    console.log('⚠️  Pre-flight test completed with failures');
    process.exit(1);
  } else {
    console.log('✅ Pre-flight test passed!');
    process.exit(0);
  }
}

// ========================================
// MAIN
// ========================================

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
