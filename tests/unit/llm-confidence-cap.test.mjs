/**
 * Unit tests for the confidence cap logic in ensemble-scorer.ts
 * (and the short-excerpt clamp in input-builder.ts).
 *
 * The DoaS Apr 9-10 postmortem (#14) found Variety was scored 73/Positive
 * with high confidence from a 180-char BWW excerpt. The full review was
 * actually Mixed (66) once we got the real text. Two bugs:
 *
 *   1. input-builder.ts forced low confidence only when uniqueExcerpts.size <= 1
 *      — but didn't clamp on text LENGTH. A 180-char excerpt could escape
 *      to medium confidence if multiple excerpts were technically present.
 *
 *   2. ensemble-scorer.ts wrote ensembleResult.confidence directly into
 *      llmScore.confidence — ignoring the input's confidence entirely. So
 *      even when input was correctly low-confidence, the ensemble's
 *      "high agreement → high confidence" overrode the input.
 *
 * The fixes:
 *   - input-builder: clamp to low when text < 200 chars (excerpt-only)
 *   - ensemble-scorer: cap final confidence to LOWER of (ensemble, input)
 *   - operator escape hatch via reviewFile.confidenceOverride
 *
 * These tests don't load the full TypeScript ensemble (would require ts-node).
 * Instead, they exercise the cap logic with a small re-implementation that
 * mirrors the production code. If the production code drifts, the test will
 * still pass — but the integration check at S7-T18 (re-score DoaS Variety)
 * is the canonical verification.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { capLlmConfidence: capConfidence } = require('../../scripts/lib/llm-confidence.js');

describe('capConfidence (LOWER of ensemble + input, with override)', () => {
  test('ensemble high + input low → low (input wins, the cap)', () => {
    assert.strictEqual(capConfidence('high', 'low'), 'low');
  });

  test('ensemble high + input medium → medium', () => {
    assert.strictEqual(capConfidence('high', 'medium'), 'medium');
  });

  test('ensemble high + input high → high', () => {
    assert.strictEqual(capConfidence('high', 'high'), 'high');
  });

  test('ensemble low + input high → low (ensemble wins, also the cap)', () => {
    assert.strictEqual(capConfidence('low', 'high'), 'low');
  });

  test('ensemble medium + input low → low', () => {
    assert.strictEqual(capConfidence('medium', 'low'), 'low');
  });

  test('override="high" bypasses both → high', () => {
    assert.strictEqual(capConfidence('low', 'low', 'high'), 'high');
    assert.strictEqual(capConfidence('high', 'high', 'low'), 'low'); // override low even when both high
  });

  test('null/undefined inputs default to medium', () => {
    assert.strictEqual(capConfidence(null, null), 'medium');
    assert.strictEqual(capConfidence(undefined, 'high'), 'medium');
    assert.strictEqual(capConfidence('high', undefined), 'medium');
  });
});

describe('Variety DoaS Apr 9-10 #14 scenario (regression)', () => {
  test('180-char BWW excerpt, ensemble all-positive → final low (NOT high)', () => {
    // This is the scenario that broke: 3 models all returned Positive 73
    // with their own "high agreement" confidence, but the input was a
    // 180-char single aggregator excerpt. The cap should force low.
    const ensembleConfidence = 'high';     // 3-model agreement on Positive
    const inputConfidence = 'low';         // <200 char excerpt, clamped by S5-T2
    const final = capConfidence(ensembleConfidence, inputConfidence);
    assert.strictEqual(final, 'low');
  });

  test('full text 5000 chars, ensemble high → final high (no regression)', () => {
    // Don't break the happy path for full-text reviews.
    const ensembleConfidence = 'high';
    const inputConfidence = 'high';
    assert.strictEqual(capConfidence(ensembleConfidence, inputConfidence), 'high');
  });

  test('truncated text + ensemble medium → final medium', () => {
    assert.strictEqual(capConfidence('medium', 'medium'), 'medium');
  });
});
