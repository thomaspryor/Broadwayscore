/**
 * BRO-4770: the standing star-band detector's predicates. Fixtures mirror the
 * slam-frank 1 Minute Critic incident (anchored rescore 57f1aab90 reverted by
 * gather commit c7aa1d3f7).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { starBandVerdict, scoringRegression } = require('../../scripts/lib/star-band-regression.js');

const BODY = 'A long thoughtful review of the show with plenty of detail. '.repeat(30);
const base = () => ({
  outletId: 'broadwayworld', outlet: 'BroadwayWorld', criticName: 'A Critic', url: 'https://example.com/r',
  fullText: BODY, textQuality: 'complete', contentTier: 'complete',
  originalScore: '3/5 stars', originalScoreNormalized: 60, scoreExtractedFrom: 'scraped-html',
});
const ctx = { category: 'off-west-end', show: { title: 'A Show' } };

const anchored = () => ({
  outletId: 'one-minute-critic', originalScoreNormalized: 80,
  scoreSource: 'anchored-v6', llmScore: { score: 78, band: { floor: 71, ceiling: 90 } },
  llmMetadata: { scoredAt: '2026-10-06T00:16:25.533Z' }, rescoreCompletedAt: '2026-10-06T00:16:26.000Z',
});
const reverted = () => ({
  outletId: 'one-minute-critic', originalScoreNormalized: 80,
  scoreSource: 'llm-v6', llmScore: { score: 80 },
  llmMetadata: { scoredAt: '2026-10-05T17:53:58.758Z' },
});

describe('scoringRegression (clobber signature)', () => {
  test('fires on the slam-frank revert and reports the lost band', () => {
    const r = scoringRegression(anchored(), reverted());
    assert.equal(r.kind, 'clobbered');
    assert.equal(r.lostBand, true);
    assert.ok(r.from > r.to);
  });
  test('a normal forward rescore is not a regression', () => {
    assert.equal(scoringRegression(reverted(), anchored()), null);
  });
  test('a deliberate clear is not a regression', () => {
    assert.equal(scoringRegression(anchored(), { ...reverted(), llmScore: null, llmMetadata: null }), null);
  });
  test('a different star on the two sides is not a regression', () => {
    assert.equal(scoringRegression(anchored(), { ...reverted(), originalScoreNormalized: 60 }), null);
  });
});

describe('starBandVerdict', () => {
  test('unanchored high-reliability star in an anchored market is flagged', () => {
    const d = { ...base(), scoreSource: 'llm-v6', llmScore: { score: 77, confidence: 'high' }, llmMetadata: { scoredAt: '2026-10-05T00:00:00Z' } };
    const v = starBandVerdict(d, ctx);
    assert.ok(v, 'expected a verdict');
    assert.equal(v.kind, 'unanchored');
  });
  test('anchored score outside its band by more than 2 is flagged once', () => {
    const d = { ...base(), scoreSource: 'anchored-v6', llmScore: { score: 43, band: { floor: 51, ceiling: 70 } } };
    const v = starBandVerdict(d, ctx);
    assert.ok(v, 'expected a verdict');
    assert.equal(v.kind, 'out-of-band');
    assert.equal(starBandVerdict({ ...d, starBandFlaggedAt: '2026-10-06T00:00:00Z' }, ctx), null);
  });
  test('inside the band, within tolerance, queued, or hand-overridden: no verdict', () => {
    const ok = { ...base(), scoreSource: 'anchored-v6', llmScore: { score: 60, band: { floor: 51, ceiling: 70 } } };
    assert.equal(starBandVerdict(ok, ctx), null);
    assert.equal(starBandVerdict({ ...ok, llmScore: { score: 49, band: { floor: 51, ceiling: 70 } } }, ctx), null);
    assert.equal(starBandVerdict({ ...ok, llmScore: { score: 30, band: { floor: 51, ceiling: 70 } }, needsRescore: true }, ctx), null);
    assert.equal(starBandVerdict({ ...ok, llmScore: { score: 30, band: { floor: 51, ceiling: 70 } }, humanReviewScore: 30 }, ctx), null);
  });
});
