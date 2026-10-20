import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');

// Catarina / The Reviews Hub's stored extraction shape (BRO-4045).
const percentageReview = (overrides = {}) => ({
  outletId: 'thereviewshub',
  originalScore: '60%',
  originalScoreNormalized: 60,
  scoreExtractionSource: 'reviewshub-percentage',
  scoreSource: 'llm-v6',
  llmScore: { score: 61, confidence: 'high' },
  fullText: 'The production makes a strong impression on its audience. '.repeat(10),
  ensembleData: { modelAgreement: 'unanimous' },
  ...overrides,
});

test('legacy percentage extraction beats llm-v6 and selects the originalRating relay source', () => {
  const data = percentageReview();
  const before = structuredClone(data);
  assert.deepEqual(getBestScore(data), { score: 60, source: 'originalScore-priority0' });
  assert.deepEqual(data, before, 'routing must not rewrite the private review record');
});

test('current percentage provenance still relays the publisher rating', () => {
  assert.deepEqual(getBestScore(percentageReview({
    scoreExtractionSource: undefined,
    originalScoreSource: 'reviewshub-percentage',
  })), { score: 60, source: 'originalScore-priority0' });
});

test('legacy provenance also supplies the published-rating gate without a v6 stamp', () => {
  assert.deepEqual(getBestScore(percentageReview({ scoreSource: undefined })), {
    score: 60, source: 'originalScore-priority0',
  });
});

test('normalized values without verified publisher provenance do not displace llm-v6', () => {
  for (const scoreExtractionSource of [undefined, 'show-score', 'numeric-stars', 'unknown']) {
    assert.deepEqual(getBestScore(percentageReview({ scoreExtractionSource })), {
      score: 61, source: 'llm-v6',
    });
  }
});

test('legacy provenance never overrides a newer low-reliability extraction', () => {
  assert.deepEqual(getBestScore(percentageReview({ originalScoreSource: 'numeric-stars' })), {
    score: 61, source: 'llm-v6',
  });
});

test('a cleared publisher rating stays cleared', () => {
  assert.deepEqual(getBestScore(percentageReview({ originalScoreCleared: true })), {
    score: 61, source: 'llmScore',
  });
});

test('human overrides and already anchored verdicts keep their precedence', () => {
  assert.deepEqual(getBestScore(percentageReview({ humanReviewScore: 65 })), {
    score: 65, source: 'human-review',
  });
  assert.deepEqual(getBestScore(percentageReview({ scoreSource: 'anchored-v6' })), {
    score: 61, source: 'anchored-v6',
  });
});
