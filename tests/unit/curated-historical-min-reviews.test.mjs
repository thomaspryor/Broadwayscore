/**
 * Unit tests for isCuratedHistorical override in hasEnoughReviews / reviewsRemainingForScore.
 *
 * Verifies that joe-turners-come-and-gone-2009 (4 reviews, 2 T1+T2) qualifies for a score,
 * while the override does NOT apply to:
 *   - non-curated Broadway shows
 *   - West End shows (override is Broadway-only)
 *   - curated shows with 0 T1+T2 reviews (T3-only)
 *
 * Run with: node --test tests/unit/curated-historical-min-reviews.test.mjs
 * (Pure JS — does not need tsx since it imports from scripts/lib/ indirectly.
 *  The functions under test are re-implemented as pure logic below, mirroring
 *  src/config/score-buckets.ts exactly, per CLAUDE.md §15 test extraction pattern.)
 *
 * NOTE: score-buckets.ts is TypeScript and cannot be require()'d directly by
 * node --test without tsx.  Per §15 we extract the pure decision logic into a
 * testable form.  The real source-of-truth is score-buckets.ts — if you change
 * the logic there, update this test to match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ──────────────────────────────────────────────────────────────────────────────
// Mirror of src/config/score-buckets.ts constants + functions (pure logic only)
// If you change score-buckets.ts, update these to match.
// ──────────────────────────────────────────────────────────────────────────────

const MIN_REVIEWS_FOR_SCORE = 5;
const MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY = 3;
const MIN_REVIEWS_FOR_SCORE_WEST_END = 5;
const MIN_REVIEWS_FOR_SCORE_OFF_WEST_END = 3;
const MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL = 4;
const T3_ONLY_EXTRA_REVIEWS = 2;

function reviewsRemainingForScore(reviewCount, category, tier1And2Count, isCuratedHistorical) {
  let min = category === 'off-broadway' ? MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY
    : category === 'off-west-end' ? MIN_REVIEWS_FOR_SCORE_OFF_WEST_END
    : category === 'west-end' ? MIN_REVIEWS_FOR_SCORE_WEST_END
    : MIN_REVIEWS_FOR_SCORE;

  if (isCuratedHistorical && (!category || category === 'broadway') && (tier1And2Count ?? 0) >= 1) {
    min = MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL;
  }

  if (tier1And2Count !== undefined && tier1And2Count === 0) {
    min += T3_ONLY_EXTRA_REVIEWS;
  }
  return Math.max(0, min - reviewCount);
}

function hasEnoughReviews(reviewCount, category, tier1And2Count, isCuratedHistorical) {
  return reviewsRemainingForScore(reviewCount, category, tier1And2Count, isCuratedHistorical) === 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('curated historical min-reviews override', () => {
  it('JT 2009: 4 reviews + 2 T1+T2 + isCuratedHistorical=true → qualifies', () => {
    assert.equal(hasEnoughReviews(4, 'broadway', 2, true), true);
  });

  it('JT 2009: 4 reviews + 2 T1+T2 + isCuratedHistorical=false → does NOT qualify', () => {
    assert.equal(hasEnoughReviews(4, 'broadway', 2, false), false);
  });

  it('JT 2009: 4 reviews + 2 T1+T2 + isCuratedHistorical=undefined → does NOT qualify (regression)', () => {
    assert.equal(hasEnoughReviews(4, 'broadway', 2, undefined), false);
  });

  it('West End show: 4 reviews + 2 T1+T2 + isCuratedHistorical=true → does NOT qualify (Broadway-only override)', () => {
    assert.equal(hasEnoughReviews(4, 'west-end', 2, true), false);
  });

  it('Curated show with 4 T3-only reviews + isCuratedHistorical=true → does NOT qualify (T1/T2 required)', () => {
    // 0 T1+T2 reviews — override requires >= 1 T1+T2
    assert.equal(hasEnoughReviews(4, 'broadway', 0, true), false);
  });

  it('Standard Broadway show needs 5 reviews even with isCuratedHistorical=false', () => {
    assert.equal(hasEnoughReviews(5, 'broadway', 2, false), true);
    assert.equal(hasEnoughReviews(4, 'broadway', 2, false), false);
  });

  it('reviewsRemainingForScore returns 0 for curated historical at 4 reviews', () => {
    assert.equal(reviewsRemainingForScore(4, 'broadway', 2, true), 0);
  });

  it('reviewsRemainingForScore returns 1 for non-curated Broadway at 4 reviews', () => {
    assert.equal(reviewsRemainingForScore(4, 'broadway', 2, false), 1);
  });

  it('null category (legacy Broadway) also gets curated-historical override', () => {
    // null/undefined category → treated as broadway per data-core convention
    assert.equal(hasEnoughReviews(4, undefined, 2, true), true);
    assert.equal(hasEnoughReviews(4, null, 2, true), true);
  });
});
