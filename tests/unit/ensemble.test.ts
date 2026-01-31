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

import {
  ensembleScore,
  toModelScore,
  scoreToBucket,
  bucketDistance,
  median,
  mean,
  getAgreementLevel
} from '../../scripts/llm-scoring/ensemble';
import { ModelScore, SimplifiedLLMResult, Bucket } from '../../scripts/llm-scoring/types';

// ========================================
// HELPER FUNCTIONS
// ========================================

function makeModelScore(
  model: 'claude' | 'openai' | 'gemini',
  bucket: Bucket,
  score: number,
  options: Partial<ModelScore> = {}
): ModelScore {
  return {
    model,
    bucket,
    score,
    confidence: 'high',
    ...options
  };
}

function makeResult(bucket: Bucket, score: number): SimplifiedLLMResult {
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
    expect(scoreToBucket(100)).toBe('Rave');
    expect(scoreToBucket(85)).toBe('Rave');
    expect(scoreToBucket(92)).toBe('Rave');
  });

  test('returns Positive for 70-84', () => {
    expect(scoreToBucket(84)).toBe('Positive');
    expect(scoreToBucket(70)).toBe('Positive');
    expect(scoreToBucket(77)).toBe('Positive');
  });

  test('returns Mixed for 55-69', () => {
    expect(scoreToBucket(69)).toBe('Mixed');
    expect(scoreToBucket(55)).toBe('Mixed');
    expect(scoreToBucket(62)).toBe('Mixed');
  });

  test('returns Negative for 35-54', () => {
    expect(scoreToBucket(54)).toBe('Negative');
    expect(scoreToBucket(35)).toBe('Negative');
    expect(scoreToBucket(45)).toBe('Negative');
  });

  test('returns Pan for 0-34', () => {
    expect(scoreToBucket(34)).toBe('Pan');
    expect(scoreToBucket(0)).toBe('Pan');
    expect(scoreToBucket(20)).toBe('Pan');
  });
});

describe('bucketDistance', () => {
  test('same bucket returns 0', () => {
    expect(bucketDistance('Rave', 'Rave')).toBe(0);
    expect(bucketDistance('Mixed', 'Mixed')).toBe(0);
  });

  test('adjacent buckets return 1', () => {
    expect(bucketDistance('Rave', 'Positive')).toBe(1);
    expect(bucketDistance('Positive', 'Mixed')).toBe(1);
    expect(bucketDistance('Negative', 'Pan')).toBe(1);
  });

  test('distant buckets return correct distance', () => {
    expect(bucketDistance('Rave', 'Mixed')).toBe(2);
    expect(bucketDistance('Rave', 'Pan')).toBe(4);
    expect(bucketDistance('Positive', 'Pan')).toBe(3);
  });
});

describe('median', () => {
  test('returns median of odd-length array', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([80, 85, 90])).toBe(85);
    expect(median([10, 50, 90])).toBe(50);
  });

  test('returns average of middle two for even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([80, 85])).toBe(82.5);
  });

  test('handles single value', () => {
    expect(median([50])).toBe(50);
  });

  test('handles empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('mean', () => {
  test('returns average of values', () => {
    expect(mean([80, 85, 90])).toBe(85);
    expect(mean([0, 100])).toBe(50);
    expect(mean([75, 75, 75])).toBe(75);
  });

  test('handles empty array', () => {
    expect(mean([])).toBe(0);
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

      expect(result.bucket).toBe('Rave');
      expect(result.score).toBeGreaterThanOrEqual(85);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.confidence).toBe('high');
      expect(result.source).toBe('ensemble-unanimous');
      expect(result.needsReview).toBe(false);
    });

    test('all Rave with wider spread', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 85),
        makeModelScore('openai', 'Rave', 95),
        makeModelScore('gemini', 'Rave', 100)
      );

      expect(result.bucket).toBe('Rave');
      expect(result.confidence).toBe('medium'); // wider spread
      expect(result.source).toBe('ensemble-unanimous');
    });

    test('all Mixed unanimous', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Mixed', 60),
        makeModelScore('openai', 'Mixed', 62),
        makeModelScore('gemini', 'Mixed', 58)
      );

      expect(result.bucket).toBe('Mixed');
      expect(result.score).toBeGreaterThanOrEqual(55);
      expect(result.score).toBeLessThanOrEqual(69);
      expect(result.source).toBe('ensemble-unanimous');
    });

    test('all Pan unanimous', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Pan', 20),
        makeModelScore('openai', 'Pan', 15),
        makeModelScore('gemini', 'Pan', 25)
      );

      expect(result.bucket).toBe('Pan');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(34);
    });
  });

  describe('2/3 majority with outlier', () => {
    test('2 Rave, 1 Positive (adjacent outlier)', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 92),
        makeModelScore('openai', 'Rave', 88),
        makeModelScore('gemini', 'Positive', 78)
      );

      expect(result.bucket).toBe('Rave');
      expect(result.source).toBe('ensemble-majority');
      expect(result.outlier?.model).toBe('gemini');
      expect(result.outlier?.bucket).toBe('Positive');
      expect(result.needsReview).toBe(false); // adjacent bucket, not severe
    });

    test('2 Positive, 1 Pan (severe outlier)', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Positive', 80),
        makeModelScore('openai', 'Positive', 78),
        makeModelScore('gemini', 'Pan', 25)
      );

      expect(result.bucket).toBe('Positive');
      expect(result.source).toBe('ensemble-majority');
      expect(result.outlier?.model).toBe('gemini');
      expect(result.outlier?.bucket).toBe('Pan');
      expect(result.needsReview).toBe(true); // 3 buckets apart
      expect(result.reviewReason).toContain('2+ buckets');
    });

    test('2 Mixed, 1 Rave (outlier)', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Mixed', 62),
        makeModelScore('openai', 'Rave', 90),
        makeModelScore('gemini', 'Mixed', 65)
      );

      expect(result.bucket).toBe('Mixed');
      expect(result.outlier?.model).toBe('openai');
      expect(result.outlier?.bucket).toBe('Rave');
      expect(result.needsReview).toBe(true); // 2 buckets apart
    });
  });

  describe('3-way disagreement (no consensus)', () => {
    test('all different buckets', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 92),
        makeModelScore('openai', 'Mixed', 58),
        makeModelScore('gemini', 'Pan', 25)
      );

      expect(result.source).toBe('ensemble-no-consensus');
      expect(result.confidence).toBe('low');
      expect(result.needsReview).toBe(true);
      expect(result.reviewReason).toBe('3-way bucket disagreement');
      expect(result.note).toContain('claude=Rave');
      expect(result.note).toContain('openai=Mixed');
      expect(result.note).toContain('gemini=Pan');
    });

    test('uses median score', () => {
      const result = ensembleScore(
        makeModelScore('claude', 'Rave', 95),
        makeModelScore('openai', 'Mixed', 60),
        makeModelScore('gemini', 'Negative', 40)
      );

      // Median of [95, 60, 40] = 60
      expect(result.score).toBe(60);
      expect(result.bucket).toBe('Mixed');
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

    expect(result.bucket).toBe('Positive');
    expect(result.source).toBe('two-model-fallback');
    expect(result.score).toBe(80); // average
    expect(result.needsReview).toBe(false);
  });

  test('2 disagree on bucket (adjacent)', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 86),
      makeModelScore('openai', 'Positive', 82),
      null
    );

    expect(result.source).toBe('two-model-fallback');
    expect(result.score).toBe(84); // average
    expect(result.bucket).toBe('Positive'); // derived from score 84
    expect(result.needsReview).toBe(false); // only 1 bucket apart
  });

  test('2 disagree on bucket (distant)', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Negative', 40),
      null
    );

    expect(result.source).toBe('two-model-fallback');
    expect(result.score).toBe(65); // average
    expect(result.confidence).toBe('low');
    expect(result.needsReview).toBe(true); // 3 buckets apart
  });

  test('high score delta triggers review', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Positive', 70),
      makeModelScore('openai', 'Positive', 88),
      null
    );

    expect(result.bucket).toBe('Positive');
    expect(result.needsReview).toBe(true); // delta of 18 > 15
    expect(result.reviewReason).toContain('delta');
  });

  test('one model has error', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Positive', 80),
      null,
      makeModelScore('gemini', 'Positive', 82, { error: 'API error' })
    );

    // Only claude succeeds
    expect(result.source).toBe('single-model-fallback');
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

    expect(result.bucket).toBe('Rave');
    expect(result.score).toBe(92);
    expect(result.source).toBe('single-model-fallback');
    expect(result.confidence).toBe('low');
    expect(result.needsReview).toBe(true);
    expect(result.note).toContain('claude');
  });

  test('only openai succeeds', () => {
    const result = ensembleScore(
      null,
      makeModelScore('openai', 'Mixed', 58),
      null
    );

    expect(result.bucket).toBe('Mixed');
    expect(result.score).toBe(58);
    expect(result.source).toBe('single-model-fallback');
  });

  test('only gemini succeeds', () => {
    const result = ensembleScore(
      null,
      null,
      makeModelScore('gemini', 'Pan', 20)
    );

    expect(result.bucket).toBe('Pan');
    expect(result.score).toBe(20);
  });
});

// ========================================
// ALL-FAIL CASE
// ========================================

describe('ensembleScore - all fail', () => {
  test('returns neutral fallback', () => {
    const result = ensembleScore(null, null, null);

    expect(result.score).toBe(50);
    expect(result.bucket).toBe('Mixed');
    expect(result.confidence).toBe('low');
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toBe('All models failed to score');
    expect(result.note).toBe('All models failed');
  });

  test('all models have errors', () => {
    const result = ensembleScore(
      makeModelScore('claude', 'Rave', 90, { error: 'API error' }),
      makeModelScore('openai', 'Rave', 90, { error: 'API error' }),
      makeModelScore('gemini', 'Rave', 90, { error: 'API error' })
    );

    expect(result.note).toBe('All models failed');
    expect(result.needsReview).toBe(true);
  });
});

// ========================================
// HELPER FUNCTION TESTS
// ========================================

describe('toModelScore', () => {
  test('converts SimplifiedLLMResult to ModelScore', () => {
    const result = makeResult('Positive', 80);
    const modelScore = toModelScore(result, 'claude');

    expect(modelScore.model).toBe('claude');
    expect(modelScore.bucket).toBe('Positive');
    expect(modelScore.score).toBe(80);
    expect(modelScore.verdict).toBe('test verdict');
    expect(modelScore.error).toBeUndefined();
  });

  test('handles null result', () => {
    const modelScore = toModelScore(null, 'openai');

    expect(modelScore.model).toBe('openai');
    expect(modelScore.bucket).toBe('Mixed');
    expect(modelScore.score).toBe(50);
    expect(modelScore.error).toBe('No result');
  });

  test('handles error parameter', () => {
    const result = makeResult('Positive', 80);
    const modelScore = toModelScore(result, 'gemini', 'API timeout');

    expect(modelScore.error).toBe('API timeout');
    expect(modelScore.bucket).toBe('Mixed'); // fallback
  });
});

describe('getAgreementLevel', () => {
  test('returns unanimous when all same', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Rave', 92),
      makeModelScore('gemini', 'Rave', 88)
    ];
    expect(getAgreementLevel(results)).toBe('unanimous');
  });

  test('returns majority when 2/3 agree', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Rave', 92),
      makeModelScore('gemini', 'Mixed', 60)
    ];
    expect(getAgreementLevel(results)).toBe('majority');
  });

  test('returns split when all different', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Mixed', 60),
      makeModelScore('gemini', 'Pan', 20)
    ];
    expect(getAgreementLevel(results)).toBe('split');
  });

  test('returns insufficient for single result', () => {
    const results = [makeModelScore('claude', 'Rave', 90)];
    expect(getAgreementLevel(results)).toBe('insufficient');
  });

  test('filters out results with errors', () => {
    const results = [
      makeModelScore('claude', 'Rave', 90),
      makeModelScore('openai', 'Rave', 92, { error: 'failed' })
    ];
    expect(getAgreementLevel(results)).toBe('insufficient');
  });
});
