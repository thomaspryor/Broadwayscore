#!/usr/bin/env npx ts-node --project scripts/tsconfig.json
/**
 * Gemini Scorer Smoke Test
 *
 * Tests Gemini API connectivity with a hardcoded review.
 * Run: GEMINI_API_KEY=... npx ts-node scripts/llm-scoring/test-gemini.ts
 */

import { GeminiScorer } from './gemini-scorer';

const TEST_REVIEW = `
Daniel Aukin's superb production navigates the change without missing a beat.
The jam has been preserved. With the greater sense of distance at the Golden Theatre,
Stereophonic feels more than ever like watching a wide-screen film. There's nary a
false note. The result is richly satisfying multitrack production that showcases
one of the best ensemble casts on Broadway. An absolute triumph. (5/5 stars)
`;

const EXPECTED_BUCKET = 'Rave';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('ERROR: GEMINI_API_KEY environment variable not set');
    console.error('Usage: GEMINI_API_KEY=your-key npx ts-node scripts/llm-scoring/test-gemini.ts');
    process.exit(1);
  }

  console.log('=== Gemini Scorer Smoke Test ===\n');
  console.log('Testing API connectivity...\n');

  const scorer = new GeminiScorer(apiKey, { verbose: true });

  try {
    const result = await scorer.scoreReview(TEST_REVIEW.trim());

    if (!result.success) {
      console.error('\nERROR: Gemini scoring failed');
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log('\n=== Result ===');
    console.log('Bucket:', result.result!.bucket);
    console.log('Score:', result.result!.score);
    console.log('Confidence:', result.result!.confidence);
    console.log('Verdict:', result.result!.verdict);
    console.log('Key Quote:', result.result!.keyQuote);
    console.log('Reasoning:', result.result!.reasoning);

    console.log('\n=== Token Usage ===');
    console.log('Input tokens:', result.inputTokens);
    console.log('Output tokens:', result.outputTokens);

    // Validate result
    if (result.result!.bucket !== EXPECTED_BUCKET) {
      console.log(`\n⚠️  WARNING: Expected bucket "${EXPECTED_BUCKET}", got "${result.result!.bucket}"`);
      console.log('This may indicate prompt tuning is needed.');
    } else {
      console.log(`\n✅ SUCCESS: Bucket matches expected "${EXPECTED_BUCKET}"`);
    }

    if (result.result!.score < 85 || result.result!.score > 100) {
      console.log(`\n⚠️  WARNING: Score ${result.result!.score} outside Rave range (85-100)`);
    }

    console.log('\n=== Smoke Test Passed ===');
    process.exit(0);
  } catch (error: any) {
    console.error('\nERROR: Unexpected error during test');
    console.error(error.message || error);
    process.exit(1);
  }
}

main();
