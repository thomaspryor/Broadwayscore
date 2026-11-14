/**
 * Unit tests for scripts/lib/late-star-anchor.js — flag llm-v6 reviews that now
 * carry a high-reliability star for an anchored re-score. MUST scope to anchored
 * markets (WE/OWE); MUST NOT touch already-anchored, human-overridden, flagged,
 * or non-anchored-market reviews.
 *
 * Run: node --test tests/unit/late-star-anchor.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { needsLateStarReanchor } = require('../../scripts/lib/late-star-anchor.js');

const weStar = (over = {}) => ({
  scoreSource: 'llm-v6', originalScore: '3/5', originalScoreSource: 'timeout-svg-stars',
  category: 'west-end', llmScore: { score: 77 }, ...over,
});

describe('needsLateStarReanchor', () => {
  test('flags an llm-v6 WE review with a high-reliability late star → returns its band', () => {
    const r = needsLateStarReanchor(weStar());
    assert.ok(r && r.band, 'should return a band');
    assert.equal(r.band.floor, 51); assert.equal(r.band.ceiling, 70); // 3/5 band
  });

  test('off-west-end is also anchored', () => {
    assert.ok(needsLateStarReanchor(weStar({ category: 'off-west-end' })));
  });

  test('flags a Broadway review (anchored since the 2026-07-20 NYC rollout)', () => {
    assert.ok(needsLateStarReanchor(weStar({ category: 'broadway' })));
  });

  test('does NOT flag a regional review (not an anchored market)', () => {
    assert.equal(needsLateStarReanchor(weStar({ category: 'regional' })), null);
  });

  test('does NOT flag an already-anchored review', () => {
    assert.equal(needsLateStarReanchor(weStar({ scoreSource: 'anchored-v6' })), null);
  });

  test('does NOT flag a low-reliability star (extraction may be wrong)', () => {
    assert.equal(needsLateStarReanchor(weStar({ originalScoreSource: 'numeric-stars' })), null);
  });

  test('does NOT flag when there is no star', () => {
    assert.equal(needsLateStarReanchor(weStar({ originalScore: null, originalScoreSource: null })), null);
  });

  test('does NOT disturb a human override or a wrong-flagged review', () => {
    assert.equal(needsLateStarReanchor(weStar({ humanReviewScore: 55 })), null);
    assert.equal(needsLateStarReanchor(weStar({ wrongShow: true })), null);
  });

  // Inclusion gate: a review the scorer would reject (isScoreable → isIncludableForRebuild)
  // must NOT be flagged — else its needsRescore never clears and the queue accumulates
  // stuck entries (2026-06-30: 3 duplicateOf + 2 consent-wall stubs found stuck).
  test('does NOT flag a duplicate (not includable for rebuild → scorer rejects it)', () => {
    assert.equal(needsLateStarReanchor(weStar({ duplicateOf: 'other-critic.json' })), null);
  });

  test('does NOT flag an isNonReview file (not includable)', () => {
    assert.equal(needsLateStarReanchor(weStar({ isNonReview: true })), null);
  });
});

// 2026-07-11 extension: files whose scoreSource is an extraction label (scored
// pre-v6, or the v6 stamp was overwritten by a later star extraction) but which
// carry an ensemble LLM verdict. The rebuild serves their flat star conversion
// (P0.5) instead of a within-band sentiment score — they must be re-anchored.
// (Found via war-horse-west-end-2026 telegraph: LLM 91 high-conf + ensemble,
// scoreSource='telegraph-svg-stars', site showed flat 100.)
describe('needsLateStarReanchor — non-v6 stamp extension', () => {
  const overwritten = (over = {}) => ({
    scoreSource: 'telegraph-svg-stars', originalScore: '5/5 stars',
    category: 'west-end',
    llmScore: { score: 91 }, ensembleData: { models: 3 },
    ...over,
  });

  test('flags an extraction-stamped WE review with an ensemble LLM verdict → 5/5 band', () => {
    const r = needsLateStarReanchor(overwritten());
    assert.ok(r && r.band, 'should return a band');
    assert.equal(r.band.floor, 91); assert.equal(r.band.ceiling, 100);
  });

  test('does NOT flag when llmScore.band already present (anchored before; loop-proof marker)', () => {
    assert.equal(needsLateStarReanchor(overwritten({
      llmScore: { score: 94, band: { floor: 91, ceiling: 100 } },
    })), null);
  });

  test('does NOT flag without ensembleData (single-model — upgrade path handles those)', () => {
    assert.equal(needsLateStarReanchor(overwritten({ ensembleData: undefined })), null);
  });

  test('does NOT flag without any LLM verdict (star-only file, no prose to sentiment-read)', () => {
    assert.equal(needsLateStarReanchor(overwritten({ llmScore: undefined, ensembleData: undefined })), null);
  });

  test('does NOT flag a low-reliability extraction stamp (css-stars)', () => {
    assert.equal(needsLateStarReanchor(overwritten({ scoreSource: 'css-stars' })), null);
  });

  test('flags on Broadway (anchored since the 2026-07-20 NYC rollout)', () => {
    assert.ok(needsLateStarReanchor(overwritten({ category: 'broadway' })));
  });

  test('does NOT flag on regional (not an anchored market)', () => {
    assert.equal(needsLateStarReanchor(overwritten({ category: 'regional' })), null);
  });

  test('does NOT flag an adjudicated review (adjudication wins at read time)', () => {
    assert.equal(needsLateStarReanchor(overwritten({ adjudicatedScore: 72 })), null);
  });

  test('does NOT flag a bare-numeric aggregator relay (no star string anywhere)', () => {
    // Show Score writes originalScore=100 as a NUMBER — detectBandFromReviewFile
    // only reads string originalScore, so no band → no flag. The rebuild-side
    // guard (isUnambiguousRatingString) keeps the LLM score for these.
    assert.equal(needsLateStarReanchor(overwritten({
      scoreSource: 'llm-gemini', originalScore: 100,
    })), null);
  });
});

// BRO-4770: producer/consumer seam. enrich-reviews flagged 46 scraper_garbage files
// every 6h and audit-stuck-rescore-flags --fix cleared them again, because this
// predicate gated on isIncludableForRebuild while the scorer gates on isScoreable.
describe('needsLateStarReanchor agrees with the consumer (isScoreable)', () => {
  const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
  const BODY = 'A properly written review with plenty of detail about the show. '.repeat(20);
  const scoreable = (over = {}) => weStar({ fullText: BODY, textQuality: 'full', contentTier: 'complete', ...over });

  test('scraper_garbage text is never flagged (the scorer drops it)', () => {
    const d = scoreable({ incompleteReason: 'scraper_garbage' });
    assert.equal(isScoreable(d), false);
    assert.equal(needsLateStarReanchor(d, { category: 'west-end' }), null);
  });

  test('showNotMentioned without an excerpt is never flagged', () => {
    const d = scoreable({ showNotMentioned: true });
    assert.equal(needsLateStarReanchor(d, { category: 'west-end' }), null);
  });

  test('anything flagged is scoreable by the consumer', () => {
    const d = scoreable();
    const v = needsLateStarReanchor(d, { category: 'west-end' });
    if (v) assert.equal(isScoreable(d), true);
  });
});

// BRO-4838: City AM Teeth 'N' Smiles printed "★★" but was anchored to a relayed
// "4/4" (band 91-100) and shown at 92. Once the outlet's own rating is stored,
// the stale band must be re-anchored once, and only for the outlet's rating.
describe('needsLateStarReanchor — anchored to a stale band', () => {
  const stale = (over = {}) => weStar({
    scoreSource: 'anchored-v6', originalScore: '2/5 stars', originalScoreSource: 'unicode-stars-fallthrough',
    aggregatorStars: '4/4 stars', ensembleData: {}, llmScore: { score: 92, band: { floor: 91, ceiling: 100 } }, ...over,
  });

  test('re-anchors when the outlet rating gives a different band', () => {
    const r = needsLateStarReanchor(stale());
    assert.ok(r && r.band);
    assert.equal(r.band.floor, 31); assert.equal(r.band.ceiling, 50);
  });

  test('does not re-anchor once the band matches (no loop)', () => {
    assert.equal(needsLateStarReanchor(stale({ llmScore: { score: 40, band: { floor: 31, ceiling: 50 } } })), null);
  });

  test('a disagreeing relay alone never re-anchors', () => {
    assert.equal(needsLateStarReanchor(stale({ originalScore: null, originalScoreSource: null, aggregatorStars: '2/5 stars' })), null);
  });

  test('marks the verdict as a stale-band re-anchor', () => {
    assert.equal(needsLateStarReanchor(stale()).staleBand, true);
  });

  test('one try per stored rating: a re-score that did not rewrite the band is not re-queued', () => {
    assert.equal(needsLateStarReanchor(stale({ staleBandReanchoredFor: '2/5 stars' })), null);
    assert.ok(needsLateStarReanchor(stale({ staleBandReanchoredFor: '4/5 stars' })), 'a new rating gets its own try');
  });

  test('a low-reliability extraction never re-anchors an anchored file', () => {
    assert.equal(needsLateStarReanchor(stale({ originalScoreSource: 'numeric-stars' })), null);
  });

  test('a percentage rating anchored to a stale band is re-anchored, once', () => {
    const pct = stale({ originalScore: '60%', originalScoreSource: 'reviewshub-percentage', outletId: 'thereviewshub' });
    const r = needsLateStarReanchor(pct);
    assert.ok(r && r.staleBand);
    assert.equal(r.band.floor, 55); assert.equal(r.band.ceiling, 65);
    assert.equal(needsLateStarReanchor({ ...pct, staleBandReanchoredFor: '60%' }), null);
  });

  test('human override still wins', () => {
    assert.equal(needsLateStarReanchor(stale({ humanReviewScore: 90 })), null);
  });
});
