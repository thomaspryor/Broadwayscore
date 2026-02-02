/**
 * Unit Tests for Ensemble Voting Logic
 *
 * Tests all voting scenarios:
 * - 3-model unanimous
 * - 3-model majority (2/3)
 * - 3-model no consensus
 * - 2-model fallback
 * - 1-model fallback
 * - All fail case
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Register ts-node with the scripts tsconfig (CommonJS/node resolution)
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const {
  ensembleScore,
  toModelScore,
  scoreToBucket,
  bucketDistance,
  median,
  mean,
  getAgreementLevel
} = require('../../scripts/llm-scoring/ensemble');

// ========================================
// HELPER FUNCTIONS
// ========================================

function makeModelScore(model, bucket, score, options = {}) {
  return {
    model,
    bucket,
    score,
    confidence: 'high',
    ...options
  };
}

function makeResult(bucket, score) {
  return {
    bucket,
    score,
    confidence: 'high',
    verdict: 'test verdict',
    keyQuote: 'test quote',
    reasoning: 'test reasoning'
  };
}

// ========================================
// UTILITY FUNCTION TESTS
// ========================================

describe('scoreToBucket', () => {
  test('returns Rave for 85-100', () => {
    assert.strictEqual(scoreToBucket(100), 'Rave');
    assert.strictEqual(scoreToBucket(85), 'Rave');
    assert.strictEqual(scoreToBucket(92), 'Rave');
  });

  test('returns Positive for 70-84', () => {
    assert.strictEqual(scoreToBucket(84), 'Positive');
    assert.strictEqual(scoreToBucket(70), 'Positive');
    assert.strictEqual(scoreToBucket(77), 'Positive');
  });

  test('returns Mixed for 55-69', () => {
    assert.strictEqual(scoreToBucket(69), 'Mixed');
    assert.strictEqual(scoreToBucket(55), 'Mixed');
    assert.strictEqual(scoreToBucket(62), 'Mixed');
  });

  test('returns Negative for 35-54', () => {
    assert.strictEqual(scoreToBucket(54), 'Negative');
    assert.strictEqual(scoreToBucket(35), 'Negative');
    assert.strictEqual(scoreToBucket(45), 'Negative');
  });

  test('returns Pan for 0-34', () => {
    assert.strictEqual(scoreToBucket(34), 'Pan');
    assert.strictEqual(scoreToBucket(0), 'Pan');
    assert.strictEqual(scoreToBucket(20), 'Pan');
  });
});

describe('bucketDistance', () => {
  test('same bucket returns 0', () => {
    assert.strictEqual(bucketDistance('Rave', 'Rave'), 0);
    assert.strictEqual(bucketDistance('Mixed', 'Mixed'), 0);
  });

  test('adjacent buckets return 1', () => {
    assert.strictEqual(bucketDistance('Rave', 'Positive'), 1);
    assert.strictEqual(bucketDistance('Positive', 'Mixed'), 1);
    assert.strictEqual(bucketDistance('Negative', 'Pan'), 1);
  });

  test('distant buckets return correct distance', () => {
    assert.strictEqual(bucketDistance('Rave', 'Mixed'), 2);
    assert.strictEqual(bucketDistance('Rave', 'Pan'), 4);
    assert.strictEqual(bucketDistance('Positive', 'Pan'), 3);
  });
});

describe('median', () => {
  test('returns median of odd-length array', () => {
    assert.strictEqual(median([1, 2, 3]), 2);
    assert.strictEqual(median([80, 85, 90]), 85);
    assert.strictEqual(median([10, 50, 90]), 50);
  });

  test('returns average of middle two for even-length array', () => {
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(median([80, 85]), 82.5);
  });

  test('handles single value', () => {
    assert.strictEqual(median([50]), 50);
  });

  test('handles empty array', () => {
    assert.strictEqual(median([]), 0);
  });
});

describe('mean', () => {
  test('returns average of values', () => {
    assert.strictEqual(mean([80, 85, 90]), 85);
    assert.strictEqual(mean([0, 100]), 50);
    assert.strictEqual(mean([75, 75, 75]), 75);
  });

  test('handles empty array', () => {
    assert.strictEqual(mean([]), 0);
  });
});

// ========================================
// 3-MODEL ENSEMBLE TESTS
// ========================================

describe('ensembleScore - 3 models', () => {
  describe('unanimous agreement', () => {
    test('all Rave with tight spread', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 92),
        makeModelScore('openai', 'Rave', 90),
        makeModelScore('gemini', 'Rave', 94)
      );

      assert.strictEqual(result.bucket, 'Rave');
      assert.ok(result.score >= 85, `score ${result.score} should be >= 85`);
      assert.ok(result.score <= 100, `score ${result.score} should be <= 100`);
      assert.strictEqual(result.confidence, 'high');
      assert.strictEqual(result.source, 'ensemble-unanimous');
      assert.strictEqual(result.needsReview, false);
    });

    test('all Rave with wider spread', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 85),
        makeModelScore('openai', 'Rave', 95),
        makeModelScore('gemini', 'Rave', 100)
      );

      assert.strictEqual(result.bucket, 'Rave');
      assert.strictEqual(result.confidence, 'medium'); // wider spread
      assert.strictEqual(result.source, 'ensemble-unanimous');
    });

    test('all Mixed unanimous', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Mixed', 60),
        makeModelScore('openai', 'Mixed', 62),
        makeModelScore('gemini', 'Mixed', 58)
      );

      assert.strictEqual(result.bucket, 'Mixed');
      assert.ok(result.score >= 55, `score ${result.score} should be >= 55`);
      assert.ok(result.score <= 69, `score ${result.score} should be <= 69`);
      assert.strictEqual(result.source, 'ensemble-unanimous');
    });

    test('all Pan unanimous', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Pan', 20),
        makeModelScore('openai', 'Pan', 15),
        makeModelScore('gemini', 'Pan', 25)
      );

      assert.strictEqual(result.bucket, 'Pan');
      assert.ok(result.score >= 0, `score ${result.score} should be >= 0`);
      assert.ok(result.score <= 34, `score ${result.score} should be <= 34`);
    });
  });

  describe('2/3 majority with outlier', () => {
    test('2 Rave, 1 Positive (adjacent outlier)', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 92),
        makeModelScore('openai', 'Rave', 88),
        makeModelScore('gemini', 'Positive', 78)
      );

      assert.strictEqual(result.bucket, 'Rave');
      assert.strictEqual(result.source, 'ensemble-majority');
      assert.strictEqual(result.outlier?.model, 'gemini');
      assert.strictEqual(result.outlier?.bucket, 'Positive');
      assert.strictEqual(result.needsReview, false); // adjacent bucket, not severe
    });

    test('2 Positive, 1 Pan (severe outlier)', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Positive', 80),
        makeModelScore('openai', 'Positive', 78),
        makeModelScore('gemini', 'Pan', 25)
      );

      assert.strictEqual(result.bucket, 'Positive');
      assert.strictEqual(result.source, 'ensemble-majority');
      assert.strictEqual(result.outlier?.model, 'gemini');
      assert.strictEqual(result.outlier?.bucket, 'Pan');
      assert.strictEqual(result.needsReview, true); // 3 buckets apart
      assert.ok(result.reviewReason.includes('2+ buckets'), `reviewReason should contain '2+ buckets'`);
    });

    test('2 Mixed, 1 Rave (outlier)', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Mixed', 62),
        makeModelScore('openai', 'Rave', 90),
        makeModelScore('gemini', 'Mixed', 65)
      );

      assert.strictEqual(result.bucket, 'Mixed');
      assert.strictEqual(result.outlier?.model, 'openai');
      assert.strictEqual(result.outlier?.bucket, 'Rave');
      assert.strictEqual(result.needsReview, true); // 2 buckets apart
    });
  });

  describe('3-way disagreement (no consensus)', () => {
    test('all different buckets', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 92),
        makeModelScore('openai', 'Mixed', 58),
        makeModelScore('gemini', 'Pan', 25)
      );

      assert.strictEqual(result.source, 'ensemble-no-consensus');
      assert.strictEqual(result.confidence, 'low');
      assert.strictEqual(result.needsReview, true);
      assert.strictEqual(result.reviewReason, '3-way bucket disagreement');
      assert.ok(result.note.includes('claude=Rave'), `note should contain 'claude=Rave'`);
      assert.ok(result.note.includes('openai=Mixed'), `note should contain 'openai=Mixed'`);
      assert.ok(result.note.includes('gemini=Pan'), `note should contain 'gemini=Pan'`);
    });

    test('uses median score', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 95),
        makeModelScore('openai', 'Mixed', 60),
        makeModelScore('gemini', 'Negative', 40)
      );

      // Median of [95, 60, 40] = 60
      assert.strictEqual(result.score, 60);
      assert.strictEqual(result.bucket, 'Mixed');
    });
  });
});

// ========================================
// 2-MODEL FALLBACK TESTS
// ========================================

describe('ensembleScore - 2 models (fallback)', () => {
  test('2 agree on bucket', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Positive', 78),
      makeModelScore('openai', 'Positive', 82),
      null
    );

    assert.strictEqual(result.bucket, 'Positive');
    assert.strictEqual(result.source, 'two-model-fallback');
    assert.strictEqual(result.score, 80); // average
    assert.strictEqual(result.needsReview, false);
  });

  test('2 disagree on bucket (adjacent)', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 86),
      makeModelScore('openai', 'Positive', 82),
      null
    );

    assert.strictEqual(result.source, 'two-model-fallback');
    assert.strictEqual(result.score, 84); // average
    assert.strictEqual(result.bucket, 'Positive'); // derived from score 84
    assert.strictEqual(result.needsReview, false); // only 1 bucket apart
  });

  test('2 disagree on bucket (distant)', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Negative', 40),
      null
    );

    assert.strictEqual(result.source, 'two-model-fallback');
    assert.strictEqual(result.score, 65); // average
    assert.strictEqual(result.confidence, 'low');
    assert.strictEqual(result.needsReview, true); // 3 buckets apart
  });

  test('high score delta triggers review', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Positive', 70),
      makeModelScore('openai', 'Positive', 88),
      null
    );

    assert.strictEqual(result.bucket, 'Positive');
    assert.strictEqual(result.needsReview, true); // delta of 18 > 15
    assert.ok(result.reviewReason.includes('delta'), `reviewReason should contain 'delta'`);
  });

  test('one model has error', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Positive', 80),
      null,
      makeModelScore('gemini', 'Positive', 82, { error: 'API error' })
    );

    // Only claude succeeds
    assert.strictEqual(result.source, 'single-model-fallback');
  });
});

// ========================================
// 1-MODEL FALLBACK TESTS
// ========================================

describe('ensembleScore - 1 model (fallback)', () => {
  test('only claude succeeds', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 92),
      null,
      null
    );

    assert.strictEqual(result.bucket, 'Rave');
    assert.strictEqual(result.score, 92);
    assert.strictEqual(result.source, 'single-model-fallback');
    assert.strictEqual(result.confidence, 'low');
    assert.strictEqual(result.needsReview, true);
    assert.ok(result.note.includes('claude'), `note should contain 'claude'`);
  });

  test('only openai succeeds', () => {
    const result = ensembleScore(
      null,
      makeModelScore('openai', 'Mixed', 58),
      null
    );

    assert.strictEqual(result.bucket, 'Mixed');
    assert.strictEqual(result.score, 58);
    assert.strictEqual(result.source, 'single-model-fallback');
  });

  test('only gemini succeeds', () => {
    const result = ensembleScore(
      null,
      null,
      makeModelScore('gemini', 'Pan', 20)
    );

    assert.strictEqual(result.bucket, 'Pan');
    assert.strictEqual(result.score, 20);
  });
});

// ========================================
// ALL-FAIL CASE
// ========================================

describe('ensembleScore - all fail', () => {
  test('returns neutral fallback', () => {
    const result = ensembleScore(null, null, null);

    assert.strictEqual(result.score, 50);
    assert.strictEqual(result.bucket, 'Mixed');
    assert.strictEqual(result.confidence, 'low');
    assert.strictEqual(result.needsReview, true);
    assert.strictEqual(result.reviewReason, 'All models failed to score');
    assert.strictEqual(result.note, 'All models failed');
  });

  test('all models have errors', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 90, { error: 'API error' }),
      makeModelScore('openai', 'Rave', 90, { error: 'API error' }),
      makeModelScore('gemini', 'Rave', 90, { error: 'API error' })
    );

    assert.strictEqual(result.note, 'All models failed');
    assert.strictEqual(result.needsReview, true);
  });
});

// ========================================
// HELPER FUNCTION TESTS
// ========================================

describe('toModelScore', () => {
  test('converts SimplifiedLLMResult to ModelScore', () => {
    const result = makeResult('Positive', 80);
    const modelScore = toModelScore(result, 'claude');

    assert.strictEqual(modelScore.model, 'claude');
    assert.strictEqual(modelScore.bucket, 'Positive');
    assert.strictEqual(modelScore.score, 80);
    assert.strictEqual(modelScore.verdict, 'test verdict');
    assert.strictEqual(modelScore.error, undefined);
  });

  test('handles null result', () => {
    const modelScore = toModelScore(null, 'openai');

    assert.strictEqual(modelScore.model, 'openai');
    assert.strictEqual(modelScore.bucket, 'Mixed');
    assert.strictEqual(modelScore.score, 50);
    assert.strictEqual(modelScore.error, 'No result');
  });

  test('handles error parameter', () => {
    const result = makeResult('Positive', 80);
    const modelScore = toModelScore(result, 'gemini', 'API timeout');

    assert.strictEqual(modelScore.error, 'API timeout');
    assert.strictEqual(modelScore.bucket, 'Mixed'); // fallback
  });
});

describe('getAgreementLevel', () => {
  test('returns unanimous when all same', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Rave', 92),
      makeModelScore('gemini', 'Rave', 88)
    ];
    assert.strictEqual(getAgreementLevel(results), 'unanimous');
  });

  test('returns majority when 2/3 agree', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Rave', 92),
      makeModelScore('gemini', 'Mixed', 60)
    ];
    assert.strictEqual(getAgreementLevel(results), 'majority');
  });

  test('returns split when all different', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Mixed', 60),
      makeModelScore('gemini', 'Pan', 20)
    ];
    assert.strictEqual(getAgreementLevel(results), 'split');
  });

  test('returns insufficient for single result', () => {
    const results = [makeModelScore('claude', 'Rave', 90)];
    assert.strictEqual(getAgreementLevel(results), 'insufficient');
  });

  test('filters out results with errors', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Rave', 92, { error: 'failed' })
    ];
    assert.strictEqual(getAgreementLevel(results), 'insufficient');
  });
});
