/**
 * Ranking/display parity for Social Pulse sentiment (task #544).
 *
 * #527 gated the DISPLAY of `positivePct` behind `shouldShowSentiment`
 * (src/lib/social-pulse-display.ts) but left RANKING untouched: /trending
 * sorted every eligible show by compositeScore = volume × positivePct/100
 * using the raw, ungated percentage — so a 2-post "100% positive" show got
 * a full sentiment multiplier in the sort while the same card refused to
 * print "100%" on the page it linked to.
 *
 * These tests require the REAL production functions (not reimplemented
 * logic) per CLAUDE.md's test-extraction rule, and assert that both
 * ranking call sites — compute-social-pulse-ranks.js (the nightly writer)
 * and data-social-pulse.ts's getTopTrendingShows fallback — fall back to
 * NEUTRAL_POSITIVE_PCT (50) whenever shouldShowSentiment({positivePct,
 * opinionSample}) is false, even when positivePct is a real, non-null
 * number.
 *
 * Runs in the tsx unit batch (test.yml) so it can import the TS side
 * directly, same precedent as social-pulse-display.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { computeCompositeScore, shouldShowSentiment: scorerShouldShow, NEUTRAL_POSITIVE_PCT } = require(
  '../../scripts/lib/social-pulse-scorer',
);
const { groupByMarket, assignRanks } = require('../../scripts/compute-social-pulse-ranks');

const { computeFallbackCompositeScore } = await import('../../src/lib/data-social-pulse.ts');
const { shouldShowSentiment } = await import('../../src/lib/social-pulse-display.ts');

// A thin-sample, real-number positivePct that shouldShowSentiment rejects.
const THIN = { positivePct: 100, opinionSample: 2 };
// A trusted, real-number positivePct that shouldShowSentiment accepts.
const TRUSTED = { positivePct: 55, opinionSample: 50 };

test('scripts/lib/social-pulse-scorer.js and src/lib/social-pulse-display.ts agree on the trust gate', () => {
  assert.equal(scorerShouldShow(THIN), false);
  assert.equal(shouldShowSentiment(THIN), false);
  assert.equal(scorerShouldShow(TRUSTED), true);
  assert.equal(shouldShowSentiment(TRUSTED), true);
});

test('compute-social-pulse-ranks.js: a thin-sample show is scored at NEUTRAL_POSITIVE_PCT, not its raw %', () => {
  const groups = groupByMarket([
    { data: { showId: 'thin-sample-show', market: 'Broadway', volume: 60, ...THIN } },
    { data: { showId: 'trusted-sample-show', market: 'Broadway', volume: 60, ...TRUSTED } },
  ]);
  assignRanks(groups);
  const entries = groups.get('Broadway');
  const thin = entries.find((e) => e.data.showId === 'thin-sample-show');
  const trusted = entries.find((e) => e.data.showId === 'trusted-sample-show');

  // Thin show's composite must equal volume × NEUTRAL_POSITIVE_PCT/100, not
  // volume × its raw (untrusted) 100%.
  assert.equal(thin.newCompositeScore, computeCompositeScore(60, NEUTRAL_POSITIVE_PCT));
  assert.notEqual(thin.newCompositeScore, computeCompositeScore(60, THIN.positivePct));

  // Trusted show's composite uses its real percentage.
  assert.equal(trusted.newCompositeScore, computeCompositeScore(60, TRUSTED.positivePct));

  // At equal volume, the fix must flip the order: trusted (55%, real) beats
  // thin (100%, untrusted-to-50%) even though the thin show's raw % is higher.
  assert.ok(trusted.newCompositeScore > thin.newCompositeScore);
  assert.equal(entries[0].data.showId, 'trusted-sample-show');
  assert.equal(entries[1].data.showId, 'thin-sample-show');
});

test('data-social-pulse.ts getTopTrendingShows fallback: same neutral-50 gate as the ranker', () => {
  const thinScore = computeFallbackCompositeScore({ volume: 60, effectiveVolume: undefined, ...THIN });
  const trustedScore = computeFallbackCompositeScore({ volume: 60, effectiveVolume: undefined, ...TRUSTED });

  assert.equal(thinScore, computeCompositeScore(60, NEUTRAL_POSITIVE_PCT));
  assert.notEqual(thinScore, computeCompositeScore(60, THIN.positivePct));
  assert.equal(trustedScore, computeCompositeScore(60, TRUSTED.positivePct));
  assert.ok(trustedScore > thinScore);
});

test('legacy v2 files (no opinionSample field) still rank on their raw percentage', () => {
  const legacy = { volume: 60, effectiveVolume: undefined, positivePct: 45, opinionSample: undefined };
  assert.equal(shouldShowSentiment(legacy), true);
  assert.equal(computeFallbackCompositeScore(legacy), computeCompositeScore(60, 45));
});

test('null positivePct (zero opinion-bearing posts) still falls back to neutral, unchanged from #527', () => {
  const zeroOpinion = { volume: 60, effectiveVolume: undefined, positivePct: null, opinionSample: 0 };
  assert.equal(computeFallbackCompositeScore(zeroOpinion), computeCompositeScore(60, NEUTRAL_POSITIVE_PCT));
});
