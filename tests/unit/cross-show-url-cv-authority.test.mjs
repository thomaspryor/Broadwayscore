/**
 * Regression test for shouldSkipCrossShowUrlFlag — the systematic fix for the
 * recurring B_false_positive_wp whac-a-mole (2026-06-22).
 *
 * Cross-show URL collision flaggers (gather-reviews.js ingest + rebuild-all-reviews.js
 * rebuild) decide which of N sibling productions owns a SHARED review URL using a weak
 * year-distance heuristic. When content verification has already affirmed the review
 * belongs to THIS production (contentVerification.wrongProduction === false), that weak
 * heuristic must NOT flag it wrongProduction — otherwise the B_false_positive_wp audit
 * fails CI every rebuild on transfer reviews (e.g. les-liaisons-dangereuses Broadway↔WE).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { shouldSkipCrossShowUrlFlag, shouldSkipWrongProductionAudit, isProductionAwareCvVerdict } = require('../../scripts/lib/review-guards');

describe('shouldSkipCrossShowUrlFlag', () => {
  test('CV verdict from a PRODUCTION-AWARE verifier (llm:/human/manual) → skip', () => {
    for (const verifiedBy of ['llm:gemini', 'llm:claude-haiku', 'llm:openai', 'human:editor', 'manual']) {
      assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: false, verifiedBy } }), true, verifiedBy);
    }
  });

  test('CV===false from a NON-production-checking default (heuristic/skip-short/absent) → do NOT skip', () => {
    // content-verifier.js defaults wrongProduction:false on these paths ("Heuristics
    // can't reliably detect this") — ~7% of all CV===false rows. Must not suppress the
    // year-distance flag on a default (ship-check 2026-06-23).
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: false, verifiedBy: 'heuristic' } }), false);
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: false, verifiedBy: 'skip-short' } }), false);
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: false } }), false); // no verifiedBy
  });

  test('isProductionAwareCvVerdict — only an actual verifier verdict counts', () => {
    assert.equal(isProductionAwareCvVerdict({ wrongProduction: false, verifiedBy: 'llm:gemini' }), true);
    assert.equal(isProductionAwareCvVerdict({ wrongProduction: false, verifiedBy: 'heuristic' }), false);
    assert.equal(isProductionAwareCvVerdict({ wrongProduction: false }), false);
    assert.equal(isProductionAwareCvVerdict({ wrongProduction: true, verifiedBy: 'llm:gemini' }), false);
    assert.equal(isProductionAwareCvVerdict(null), false);
  });

  test('CV says wrong production → do NOT skip (heuristic may legitimately flag)', () => {
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: true, verifiedBy: 'llm:gemini' } }), false);
  });

  test('no contentVerification → not skipped on that basis', () => {
    assert.equal(shouldSkipCrossShowUrlFlag({ url: 'https://x' }), false);
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: {} }), false);
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: null } }), false);
  });

  test('still honors the manual-clear / override breadcrumbs (superset of shouldSkipWrongProductionAudit)', () => {
    for (const d of [
      { wrongProductionManualClear: true },
      { wrongProductionOverride: true },
      { humanReviewedWrongProduction: false },
      { allowCrossMarket: true },
    ]) {
      assert.equal(shouldSkipWrongProductionAudit(d), true);
      assert.equal(shouldSkipCrossShowUrlFlag(d), true);
    }
  });

  test('a plain heuristic-flaggable review (no clear, no CV) → not skipped', () => {
    assert.equal(shouldSkipCrossShowUrlFlag({ wrongProduction: true, publishDate: '2016-10-01' }), false);
  });

  test('null/garbage input → false', () => {
    assert.equal(shouldSkipCrossShowUrlFlag(null), false);
    assert.equal(shouldSkipCrossShowUrlFlag(undefined), false);
    assert.equal(shouldSkipCrossShowUrlFlag('x'), false);
  });
});
