/**
 * Regression test for Rocky Horror 2026-04-23 opening night (Session 2 #10).
 *
 * Helen Shaw review was locked to humanReviewScore=82 (NYT Critic's Pick) but
 * the live site displayed llmScore=78. The operator expected humanReviewScore
 * to win. The brief codifies the semantic:
 *
 *   humanReviewScoreProvisional === true  → LLM can override (fall through)
 *   humanReviewScoreProvisional === false  → human locks it (P0 wins)
 *   humanReviewScoreProvisional === undefined → treat as false (locked)
 *
 * Run: node --test tests/unit/human-review-score-provisional.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');

// Minimum ensemble required to let P1 (high-conf LLM) return.
const ensemble = {
  needsReview: false,
  models: [{ score: 78 }, { score: 78 }],
};

test('humanReviewScore wins when humanReviewScoreProvisional=false', () => {
  const data = {
    humanReviewScore: 82,
    humanReviewScoreProvisional: false,
    llmScore: { score: 78, confidence: 'high' },
    ensembleData: ensemble,
    fullText: 'x'.repeat(2000),
  };
  const result = getBestScore(data);
  assert.equal(result.score, 82);
  assert.equal(result.source, 'human-review');
});

test('humanReviewScore wins when humanReviewScoreProvisional is undefined (default locked)', () => {
  const data = {
    humanReviewScore: 82,
    llmScore: { score: 78, confidence: 'high' },
    ensembleData: ensemble,
    fullText: 'x'.repeat(2000),
  };
  const result = getBestScore(data);
  assert.equal(result.score, 82);
  assert.equal(result.source, 'human-review');
});

test('LLM wins when humanReviewScoreProvisional=true', () => {
  const data = {
    humanReviewScore: 82,
    humanReviewScoreProvisional: true,
    llmScore: { score: 78, confidence: 'high' },
    ensembleData: ensemble,
    fullText: 'x'.repeat(2000),
  };
  const result = getBestScore(data);
  assert.equal(result.score, 78, 'provisional=true must allow LLM to override');
  assert.ok(result.source.startsWith('llmScore'), `expected llmScore source, got ${result.source}`);
});

test('provisional=true with no LLM score falls through to assignedScore / null', () => {
  const data = {
    humanReviewScore: 82,
    humanReviewScoreProvisional: true,
    assignedScore: 77,
  };
  const result = getBestScore(data);
  assert.equal(result.score, 77, 'should NOT use provisional humanReviewScore; falls to assignedScore');
  assert.equal(result.source, 'assignedScore');
});

test('scoreStatus=TO_BE_CALCULATED still returns null even with humanReviewScore', () => {
  const data = {
    scoreStatus: 'TO_BE_CALCULATED',
    humanReviewScore: 82,
  };
  const result = getBestScore(data);
  assert.equal(result, null);
});
