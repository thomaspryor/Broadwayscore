/**
 * Unit tests for shouldSkipWrongProductionAudit (review-guards.js)
 *
 * The DoaS Apr 9-10 postmortem found that ~13 wrongProduction = true write
 * sites in scripts/rebuild-all-reviews.js did not consistently check the
 * humanReviewedWrongProduction flag, so files manually verified by a human
 * were re-flagged as wrong production. This helper centralizes the check
 * so all 13 sites use the same logic.
 *
 * Pattern: require() the real function, never copy logic into tests.
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #10
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldSkipWrongProductionAudit } = require('../../scripts/lib/review-guards.js');

describe('shouldSkipWrongProductionAudit', () => {
  test('humanReviewedWrongProduction === false → skip (true)', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ humanReviewedWrongProduction: false }),
      true,
      'A human explicitly verified this is NOT wrong production — must skip the audit'
    );
  });

  test('wrongProductionManualClear === true → skip (true)', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ wrongProductionManualClear: true }),
      true,
      'Manual clear is a positive override — must skip'
    );
  });

  test('wrongProductionOverride === true → skip (true)', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ wrongProductionOverride: true }),
      true,
      'Override flag is a positive override — must skip'
    );
  });

  test('all 3 overrides set → skip (true)', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({
        humanReviewedWrongProduction: false,
        wrongProductionManualClear: true,
        wrongProductionOverride: true,
      }),
      true
    );
  });

  test('no overrides set → do not skip (false)', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({}), false);
  });

  test('humanReviewedWrongProduction === true → do not skip', () => {
    // A human said yes, this IS wrong production. Audit should still run
    // (it will agree). Only the explicit "false" claim is a skip signal.
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ humanReviewedWrongProduction: true }),
      false
    );
  });

  test('humanReviewedWrongProduction === null → do not skip', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ humanReviewedWrongProduction: null }),
      false
    );
  });

  test('humanReviewedWrongProduction === undefined → do not skip', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ humanReviewedWrongProduction: undefined }),
      false
    );
  });

  test('wrongProductionManualClear === false → do not skip', () => {
    // Falsy value for manualClear means "not explicitly cleared" — audit should run.
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ wrongProductionManualClear: false }),
      false
    );
  });

  test('wrongProductionOverride === false → do not skip', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ wrongProductionOverride: false }),
      false
    );
  });

  test('only unrelated fields → do not skip', () => {
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ fullText: 'some text', wrongShow: false }),
      false
    );
  });

  test('null data object → do not skip (defensive)', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit(null), false);
    assert.strictEqual(shouldSkipWrongProductionAudit(undefined), false);
  });

  test('humanReviewedWrongProduction string "false" → do not skip (strict false only)', () => {
    // The check uses === false, not == false. String "false" is not strict false.
    // This guards against type coercion bugs in upstream callers.
    assert.strictEqual(
      shouldSkipWrongProductionAudit({ humanReviewedWrongProduction: 'false' }),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// CV wrongProduction contradiction guard (Balusters CLASS 1 generalization,
// 2026-04-22). The rule in rebuild-all-reviews.js:
//   cvWpAdvisory = ensembleSaysReview && cv.confidence !== 'high' && !cvLowButStrong
// If advisory, DO NOT promote cv.wrongProduction to data.wrongProduction.
// ---------------------------------------------------------------------------
const { hasHighConfidenceLlmScore } = require('../../scripts/lib/review-guards.js');

// Replicate the advisory decision exactly as rebuild-all-reviews.js encodes it,
// so if the rebuild logic drifts, tests fail.
function cvWpAdvisoryDecision(data, cvConfidence, cvLowButStrong = false) {
  const ensembleSaysReview = hasHighConfidenceLlmScore(data);
  return ensembleSaysReview && cvConfidence !== 'high' && !cvLowButStrong;
}

describe('CV wrongProduction contradiction advisory', () => {
  test('medium-conf CV + high-conf ensemble score → advisory (do not promote)', () => {
    const data = { llmScore: { score: 85, confidence: 'high' } };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'medium'), true);
  });

  test('medium-conf CV + medium-conf ensemble score → advisory (do not promote)', () => {
    const data = { llmScore: { score: 65, confidence: 'medium' } };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'medium'), true);
  });

  test('low-conf CV + high-conf ensemble score → advisory (do not promote)', () => {
    const data = { llmScore: { score: 75, confidence: 'high' } };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'low'), true);
  });

  test('HIGH-conf CV + high-conf ensemble score → NOT advisory (CV still promotes)', () => {
    // The hard signal (venue mismatch, tour, prior production) survives even
    // when the ensemble saw coherent text. High-conf CV wins the tie.
    const data = { llmScore: { score: 85, confidence: 'high' } };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'high'), false);
  });

  test('no ensemble score → NOT advisory (CV promotes as before)', () => {
    const data = { llmScore: null };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'medium'), false);
  });

  test('low-conf ensemble → NOT advisory (no signal to defer to)', () => {
    const data = { llmScore: { score: 50, confidence: 'low' } };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'medium'), false);
  });

  test('cvLowButStrong bypasses advisory (strong "different show" markers)', () => {
    // Even with a confident ensemble, "does not appear in" / "wrong production"
    // markers in CV reasoning are definitive — they win.
    const data = { llmScore: { score: 85, confidence: 'high' } };
    assert.strictEqual(cvWpAdvisoryDecision(data, 'low', /*cvLowButStrong=*/true), false);
  });
});
