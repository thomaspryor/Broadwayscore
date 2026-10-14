/**
 * Advanced-filter score-tier predicates.
 *
 * Why this test exists: inScoreRange() used closed integer ranges
 * (83-100/75-82/65-74/55-64/0-54) against a fractional criticScore.score.
 * Scores in the open intervals (54-55, 64-65, 74-75, 82-83) matched no
 * tier — 106 shows were invisible to the Advanced Filter panel even with
 * all five tiers selected, despite their badge showing a rounded value
 * that IS covered (e.g. 82.94 displays as 83). Fixed by rounding before
 * bucketing, mirroring isCriticalGold() in src/config/score-buckets.ts.
 * Same bug fixed on iOS 2026-07-26 (advanced-filters.ts, commit e2a99a6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORE_TIER_CRITICAL_GOLD,
  SCORE_TIER_RECOMMENDED,
  SCORE_TIER_WORTH_SEEING,
  SCORE_TIER_SKIPPABLE,
  SCORE_TIER_CRITICAL_MISS,
  type FilterPredicateCtx,
} from '../../src/lib/show-filter-predicates';
import type { ShowCardShow } from '../../src/components/show-cards/types';

const TIERS = [
  SCORE_TIER_CRITICAL_GOLD,
  SCORE_TIER_RECOMMENDED,
  SCORE_TIER_WORTH_SEEING,
  SCORE_TIER_SKIPPABLE,
  SCORE_TIER_CRITICAL_MISS,
];

const ctx: FilterPredicateCtx = {
  tonyWinnerIds: new Set(),
  tonyNomineeIds: new Set(),
  olivierWinnerIds: new Set(),
  olivierNomineeIds: new Set(),
  dramaDeskWinnerIds: new Set(),
  pulitzerWinnerIds: new Set(),
  dateRanges: [],
  scoreMode: 'critics',
};

const show = (score: number | undefined): ShowCardShow =>
  ({ id: 'x', criticScore: score === undefined ? undefined : { score } } as unknown as ShowCardShow);

test('82.94 (badge shows 83) matches Critical Gold, not Recommended', () => {
  const s = show(82.94);
  assert.equal(SCORE_TIER_CRITICAL_GOLD(s, ctx), true);
  assert.equal(SCORE_TIER_RECOMMENDED(s, ctx), false);
});

test('74.9 (badge shows 75) matches Recommended, not Worth Seeing', () => {
  const s = show(74.9);
  assert.equal(SCORE_TIER_RECOMMENDED(s, ctx), true);
  assert.equal(SCORE_TIER_WORTH_SEEING(s, ctx), false);
});

test('every fractional score lands in exactly one tier', () => {
  for (const score of [54.4, 54.6, 64.5, 74.49, 82.5, 99.9, 0.4]) {
    const s = show(score);
    const matches = TIERS.filter((tier) => tier(s, ctx));
    assert.equal(matches.length, 1, `score ${score} matched ${matches.length} tiers`);
  }
});

test('missing score matches no tier', () => {
  const s = show(undefined);
  for (const tier of TIERS) {
    assert.equal(tier(s, ctx), false);
  }
});
