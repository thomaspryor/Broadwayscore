/**
 * Unit tests for review-guards.js — isLikelyWrongProduction
 *
 * Tests the date-mismatch guard that flags reviews likely from a prior production.
 * Pattern: require() the real function, never copy logic into tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isLikelyWrongProduction } = require('../../scripts/lib/review-guards.js');

describe('isLikelyWrongProduction', () => {
  test('review 91 days before show -> true', () => {
    // 91 days before 2026-06-01 = 2026-03-02
    assert.strictEqual(isLikelyWrongProduction('2026-03-02', '2026-06-01'), true);
  });

  test('review 89 days before show -> false', () => {
    // 89 days before 2026-06-01 = 2026-03-04
    assert.strictEqual(isLikelyWrongProduction('2026-03-04', '2026-06-01'), false);
  });

  test('review on show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-06-01', '2026-06-01'), false);
  });

  test('review after show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-07-15', '2026-06-01'), false);
  });

  test('no review date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction(null, '2026-06-01'), false);
    assert.strictEqual(isLikelyWrongProduction('', '2026-06-01'), false);
  });

  test('no show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-03-01', null), false);
    assert.strictEqual(isLikelyWrongProduction('2026-03-01', ''), false);
  });

  test('date with ordinal suffix ("May 10th, 2019") -> correctly parsed', () => {
    assert.strictEqual(isLikelyWrongProduction('May 10th, 2019', '2026-06-01'), true);
  });

  test('2016 review for 2026 show -> true', () => {
    assert.strictEqual(isLikelyWrongProduction('2016-04-15', '2026-06-01'), true);
  });

  test('2018 review for 2018 show -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2018-09-15', '2018-10-01'), false);
  });
});
