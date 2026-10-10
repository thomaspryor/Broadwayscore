import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNoReviewExpectedActive, detectReactivation, hasStaticNoReviewClaim, DECAY_DAYS } =
  require('./coverage-expectation.js');

const DAY = 86400000;
const NOW = Date.parse('2026-07-22T00:00:00Z');

describe('isNoReviewExpectedActive (14d decay)', () => {
  test('fresh determination (decided today) suppresses', () => {
    const outlets = { ap: { coverageExpectation: 'none', coverageExpectationDecidedAt: '2026-07-22' } };
    assert.equal(isNoReviewExpectedActive(outlets, 'ap', NOW), true);
  });

  test('determination exactly at the 14d boundary still suppresses', () => {
    const decidedAt = new Date(NOW - DECAY_DAYS * DAY).toISOString().slice(0, 10);
    const outlets = { ap: { coverageExpectation: 'none', coverageExpectationDecidedAt: decidedAt } };
    assert.equal(isNoReviewExpectedActive(outlets, 'ap', NOW), true);
  });

  test('expired determination (>14d old) re-enters GAP — no longer suppresses', () => {
    const decidedAt = new Date(NOW - 20 * DAY).toISOString().slice(0, 10);
    const outlets = { ap: { coverageExpectation: 'none', coverageExpectationDecidedAt: decidedAt } };
    assert.equal(isNoReviewExpectedActive(outlets, 'ap', NOW), false);
  });

  test('reviewsTheater:false form also decays', () => {
    const decidedAt = new Date(NOW - 30 * DAY).toISOString().slice(0, 10);
    const outlets = { latimes: { reviewsTheater: false, coverageExpectationDecidedAt: decidedAt } };
    assert.equal(isNoReviewExpectedActive(outlets, 'latimes', NOW), false);
  });

  test('determination with no decidedAt timestamp never suppresses (requires re-probe evidence)', () => {
    const outlets = { ap: { coverageExpectation: 'none' } };
    assert.equal(isNoReviewExpectedActive(outlets, 'ap', NOW), false);
  });

  test('outlet with no claim at all is not suppressed', () => {
    const outlets = { nytimes: { coverageExpectation: 'reviews' } };
    assert.equal(isNoReviewExpectedActive(outlets, 'nytimes', NOW), false);
  });

  test('unknown outlet id is not suppressed', () => {
    assert.equal(isNoReviewExpectedActive({}, 'ghost-outlet', NOW), false);
  });
});

describe('detectReactivation', () => {
  test('a scored review from a reviewsTheater:false outlet fires reactivation', () => {
    const outlets = { ap: { reviewsTheater: false, coverageExpectationDecidedAt: '2026-07-22' } };
    const r = detectReactivation(outlets, new Set(['ap', 'nytimes']));
    assert.deepEqual(r, ['ap']);
  });

  test('reactivation fires even for an already-decayed determination', () => {
    const decidedAt = new Date(NOW - 100 * DAY).toISOString().slice(0, 10);
    const outlets = { ap: { coverageExpectation: 'none', coverageExpectationDecidedAt: decidedAt } };
    const r = detectReactivation(outlets, new Set(['ap']));
    assert.deepEqual(r, ['ap']);
  });

  test('no reactivation when the scored outlet has no no-review claim', () => {
    const outlets = { nytimes: { coverageExpectation: 'reviews' } };
    const r = detectReactivation(outlets, new Set(['nytimes']));
    assert.deepEqual(r, []);
  });

  test('empty scored set yields no reactivations', () => {
    const outlets = { ap: { coverageExpectation: 'none', coverageExpectationDecidedAt: '2026-07-22' } };
    assert.deepEqual(detectReactivation(outlets, new Set()), []);
  });
});

describe('hasStaticNoReviewClaim', () => {
  test('true for coverageExpectation:none regardless of decidedAt', () => {
    assert.equal(hasStaticNoReviewClaim({ ap: { coverageExpectation: 'none' } }, 'ap'), true);
  });
  test('true for reviewsTheater:false', () => {
    assert.equal(hasStaticNoReviewClaim({ ap: { reviewsTheater: false } }, 'ap'), true);
  });
  test('false when neither field is set', () => {
    assert.equal(hasStaticNoReviewClaim({ ap: {} }, 'ap'), false);
  });
});
