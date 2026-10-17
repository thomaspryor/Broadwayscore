/**
 * BRO-37 — comparative within-show anchored scoring fixes the 97-clustering
 * bug: star-anchored reviews scored in ISOLATION all snap to the same q3≈97
 * within-band anchor (War Horse WE 2026: Time Out, FT, The Stage, Arts Desk
 * all landed at exactly 97 despite genuinely different prose warmth). Corpus:
 * the 5-star band [91,100] had 122/198 reviews at 96-97.
 *
 * scripts/lib/comparative-band.js (2026-06-05) is the fix: re-score a show's
 * same-band reviews TOGETHER so relative warmth spreads instead of collapsing.
 * This test locks in the actual clustering-reduction behavior against a
 * fixture that reproduces the reported bug, so a future edit to
 * combineComparative can't quietly regress back to uniform clustering.
 *
 * Run: node --test tests/unit/review-scoring-clustering.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { combineComparative } = require('../../scripts/lib/comparative-band.js');

const FIVE_STAR_BAND = { floor: 91, ceiling: 100 };

// The reported bug: 4 outlets, all isolated-scored to the same q3 anchor.
const WAR_HORSE_ISOLATED = {
  'timeout.json': 97,
  'financialtimes.json': 97,
  'thestage.json': 97,
  'artsdesk.json': 97,
};

function stdev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

test('clustering bug reproduction: 4 reviews isolated-scored to the same value', () => {
  const scores = Object.values(WAR_HORSE_ISOLATED);
  assert.equal(new Set(scores).size, 1, 'fixture must reproduce the all-97 clustering bug');
});

test('comparative pass spreads genuinely distinct warmth instead of leaving everything at 97', () => {
  // Two models independently rank the same 4 reviews by warmth and AGREE on
  // ordering (the validated 2026-06-05 GPT-4o + Gemini finding) — this is the
  // "real signal" case the fix is meant to act on.
  const modelA = { 'timeout.json': 96, 'financialtimes.json': 100, 'thestage.json': 97, 'artsdesk.json': 92 };
  const modelB = { 'timeout.json': 95, 'financialtimes.json': 99, 'thestage.json': 96, 'artsdesk.json': 91 };

  const combined = combineComparative([modelA, modelB], WAR_HORSE_ISOLATED, FIVE_STAR_BAND);
  const finalScores = Object.values(combined).map((c) => c.score);

  // The core regression this test guards: the fix must not leave the group
  // uniformly clustered when the models found real, agreeing distinctions.
  assert.notEqual(new Set(finalScores).size, 1, 'reviews with genuine warmth differences must not all land on the same score');
  assert.ok(stdev(finalScores) >= 2, `expected a natural spread across the band, got stdev=${stdev(finalScores)}`);

  // Every score must stay inside the star's band — comparative repositions
  // WITHIN [91,100], it never invents scores outside what the star allows.
  for (const s of finalScores) {
    assert.ok(s >= FIVE_STAR_BAND.floor && s <= FIVE_STAR_BAND.ceiling, `${s} must stay in [${FIVE_STAR_BAND.floor}, ${FIVE_STAR_BAND.ceiling}]`);
  }

  // The warmest review (FT, ranked top by both models) should end up at or
  // near the ceiling — the fix should not be shy of using the full range.
  assert.ok(combined['financialtimes.json'].score >= 97, 'the warmest review should score near the ceiling, not compress toward 97');
  for (const c of Object.values(combined)) assert.equal(c.applied, true);
});

test('guardrail: reviews that are genuinely equivalent stay equal — the fix must not invent fake spread', () => {
  // Both models see no real distinction between the 4 reviews (near-identical
  // scores). combineComparative must NOT force artificial variety here —
  // "reads as arbitrary" cuts both ways: manufactured spread on truly
  // equivalent prose would be just as fake as the original clustering.
  const modelA = { 'timeout.json': 97, 'financialtimes.json': 96, 'thestage.json': 97, 'artsdesk.json': 96 };
  const modelB = { 'timeout.json': 96, 'financialtimes.json': 97, 'thestage.json': 96, 'artsdesk.json': 97 };

  const combined = combineComparative([modelA, modelB], WAR_HORSE_ISOLATED, FIVE_STAR_BAND);
  const finalScores = Object.values(combined).map((c) => c.score);
  assert.ok(stdev(finalScores) <= 1, `equivalent reviews should stay near-equal, got stdev=${stdev(finalScores)}`);
});

test('guardrail: disagreeing model orderings fall back to isolated scores, never invent spread from noise', () => {
  // Models disagree on which review is warmest — there's no real signal, so
  // the fix must fall back to the (clustered) isolated scores rather than
  // fabricate a distinction. This is what stops the fix from just trading one
  // arbitrary-looking pattern for another.
  const modelA = { 'timeout.json': 100, 'financialtimes.json': 91, 'thestage.json': 97, 'artsdesk.json': 94 };
  const modelB = { 'timeout.json': 91, 'financialtimes.json': 100, 'thestage.json': 94, 'artsdesk.json': 97 };

  const combined = combineComparative([modelA, modelB], WAR_HORSE_ISOLATED, FIVE_STAR_BAND);
  for (const [id, isolated] of Object.entries(WAR_HORSE_ISOLATED)) {
    assert.equal(combined[id].score, isolated, `${id} should keep its isolated score when models disagree on ordering`);
    assert.equal(combined[id].applied, false);
  }
});
