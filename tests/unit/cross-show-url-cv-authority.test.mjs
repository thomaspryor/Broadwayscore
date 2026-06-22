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
const { shouldSkipCrossShowUrlFlag, shouldSkipWrongProductionAudit } = require('../../scripts/lib/review-guards');

describe('shouldSkipCrossShowUrlFlag', () => {
  test('CV-verified-correct (contentVerification.wrongProduction === false) → skip', () => {
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: false } }), true);
  });

  test('CV says wrong production → do NOT skip (heuristic may legitimately flag)', () => {
    assert.equal(shouldSkipCrossShowUrlFlag({ contentVerification: { wrongProduction: true } }), false);
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
