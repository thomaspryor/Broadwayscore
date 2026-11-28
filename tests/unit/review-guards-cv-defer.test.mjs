/**
 * S3-T6 — Unit tests for the `cv-promotion-deferred` flagReason carve-out.
 *
 * Contract:
 *   - `flaggedForReview=true && flagReason='cv-promotion-deferred'` reviews
 *     ARE includable (they appear in reviews.json — that's the entire point
 *     of the S3-T5 defer mechanism).
 *   - the canonical isIncludableForRebuild handles this — these
 *     reviews are scoreable.
 *   - `flaggedForReview=true` with a *different* flagReason must continue
 *     to follow the existing semantics (no new gating on flaggedForReview
 *     alone).
 *
 * Pattern: require() the real function, never copy logic into tests.
 * Cross-ref: memory/feedback_includability_predicates_must_be_canonical.md
 *            memory/feedback_test_extraction_pattern.md
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isIncludableForRebuild, hasValidScore } = require('../../scripts/lib/review-guards.js');
// Sprint 1 unification: the review-text-scoreable.js mirror is deleted. Its
// passesFlagFilters → isIncludableForRebuild; its wouldBeIncludedInRebuild →
// isIncludableForRebuild && hasValidScore (the SCORED axis).

function makeBaseReview(overrides = {}) {
  return {
    showId: 'mother-russia-off-broadway-2026',
    outletId: 'new-york-sun',
    criticName: 'Elysa Gardner',
    fullText: 'A '.repeat(800) + 'compelling review with brilliant performance and excellent direction.',
    llmScore: { score: 80, confidence: 'high' },
    contentTier: 'complete',
    publishDate: '2026-04-15',
    textFetchedAt: '2026-04-15T10:00:00Z',
    ...overrides,
  };
}

describe('S3-T6: cv-promotion-deferred carve-out', () => {
  test('isIncludableForRebuild: cv-promotion-deferred review is includable', () => {
    const data = makeBaseReview({
      flaggedForReview: true,
      flagReason: 'cv-promotion-deferred',
    });
    assert.strictEqual(isIncludableForRebuild(data), true);
  });

  test('isIncludableForRebuild: cv-promotion-deferred review passes', () => {
    const data = makeBaseReview({
      flaggedForReview: true,
      flagReason: 'cv-promotion-deferred',
    });
    assert.strictEqual(isIncludableForRebuild(data), true);
  });

  test('isIncludableForRebuild+hasValidScore: cv-promotion-deferred review qualifies', () => {
    const data = makeBaseReview({
      flaggedForReview: true,
      flagReason: 'cv-promotion-deferred',
    });
    assert.strictEqual((isIncludableForRebuild(data) && hasValidScore(data)), true);
  });

  test('flaggedForReview alone (different flagReason) — existing semantics unchanged for clean review', () => {
    // Baseline contract: today, neither predicate rejects on `flaggedForReview`.
    // This test pins that behavior so any future generic flag-based reject
    // surfaces as a test break (and the contributor is forced to look at the
    // documentation carve-out and re-add the cv-promotion-deferred path).
    const data = makeBaseReview({
      outletId: 'variety',
      flaggedForReview: true,
      flagReason: 'some-other-reason',
    });
    assert.strictEqual(isIncludableForRebuild(data), true);
    assert.strictEqual(isIncludableForRebuild(data), true);
  });

  test('cv-promotion-deferred + wrongProduction (uncleared) — still excluded by wrongProduction rule', () => {
    // The carve-out is NOT a blanket return-true. Other exclusion rules
    // (wrongProduction without a manual clear) still apply.
    const data = makeBaseReview({
      flaggedForReview: true,
      flagReason: 'cv-promotion-deferred',
      wrongProduction: true,
    });
    assert.strictEqual(isIncludableForRebuild(data), false);
    assert.strictEqual(isIncludableForRebuild(data), false);
  });

  test('cv-promotion-deferred + wrongProduction (cleared) — included', () => {
    // wrongProduction cleared by human review → cv-promotion-deferred path
    // should still let the review through.
    const data = makeBaseReview({
      flaggedForReview: true,
      flagReason: 'cv-promotion-deferred',
      wrongProduction: true,
      wrongProductionManualClear: true,
    });
    assert.strictEqual(isIncludableForRebuild(data), true);
  });

  test('no flaggedForReview + no flagReason — clean review still includable', () => {
    const data = makeBaseReview();
    assert.strictEqual(isIncludableForRebuild(data), true);
    assert.strictEqual(isIncludableForRebuild(data), true);
  });
});
