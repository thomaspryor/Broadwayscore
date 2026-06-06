// Tests the live-site parity DISPLAY gates in send-opening-digest.js:
//   - critic score: getMarketMinReviews() → 3 (London/Off-Bway), 5 (Broadway)
//   - audience grade: MIN_AUDIENCE_REVIEWS = 15
// Requires the REAL functions (CLAUDE.md rule 15) — no copied logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { minReviewsToShowScore, getAudience, MIN_AUDIENCE_REVIEWS } =
  require('../../scripts/send-opening-digest.js');

test('critic-score gate matches getMarketMinReviews', () => {
  assert.equal(minReviewsToShowScore('broadway'), 5);
  assert.equal(minReviewsToShowScore('off-broadway'), 3);
  assert.equal(minReviewsToShowScore('west-end'), 3);
  assert.equal(minReviewsToShowScore('off-west-end'), 3);
  assert.equal(minReviewsToShowScore(undefined), 5); // unknown → Broadway floor
});

test('MIN_AUDIENCE_REVIEWS mirrors the site (15)', () => {
  assert.equal(MIN_AUDIENCE_REVIEWS, 15);
});

const buzz = (n) => ({
  shows: { x: { combinedScore: 42, designation: 'Mixed', sources: { a: { reviewCount: n } } } },
});

test('audience grade suppressed below 15 reviews', () => {
  for (const n of [0, 1, 14]) {
    const a = getAudience(buzz(n), 'x');
    assert.equal(a.score, null, `n=${n} should yield null score`);
    assert.equal(a.designation, null, `n=${n} should yield null designation`);
    assert.equal(a.reviewCount, n, 'reviewCount still reported');
  }
});

test('audience grade shown at >= 15 reviews', () => {
  for (const n of [15, 40]) {
    const a = getAudience(buzz(n), 'x');
    assert.equal(a.score, 42, `n=${n} should show score`);
    assert.equal(a.designation, 'Mixed');
  }
});

test('unknown show → null audience (no crash)', () => {
  assert.equal(getAudience(buzz(20), 'missing'), null);
});
