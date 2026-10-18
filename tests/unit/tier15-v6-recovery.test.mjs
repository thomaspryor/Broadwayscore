/**
 * BRO-4490: getBestScore must honour the tier-1.5 recovery of a wrongly
 * cleared star before the llm-v6 early return ships the unanchored LLM score,
 * and late-star-anchor must re-anchor once a refetch restores the star.
 *
 * Run: node --test tests/unit/tier15-v6-recovery.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getBestScore, isTier15OverrideActive, tier15RecoveredStarForV6 } = require('../../scripts/lib/rebuild-helpers.js');
const { needsLateStarReanchor } = require('../../scripts/lib/late-star-anchor.js');
const { setExtractedScore } = require('../../scripts/lib/score-routing.js');

// Shape of stranger-things-the-first-shadow-west-end-2023/plays-international:
// a printed 3/5 cleared by the tier-1.5 audit, scored llm-v6 at 76.
const cleared = (over = {}) => ({
  outletId: 'timeout',
  scoreSource: 'llm-v6',
  originalScore: null,
  previousOriginalScore: '3/5 stars',
  originalScoreSource: 'unicode-stars',
  originalScoreCleared: true,
  originalScoreClearedReason: 'extraction-no-evidence-in-text (tier 1.5, was 3/5)',
  llmScore: { score: 76, confidence: 'high' },
  ensembleData: { claudeScore: 76 },
  fullText: 'x'.repeat(400),
  ...over,
});

describe('getBestScore: tier-1.5 recovery beats the llm-v6 early return', () => {
  test('recovered 3/5 ships its star value, not the unanchored 76', () => {
    const stats = {};
    const r = getBestScore(cleared(), { stats });
    assert.equal(r.score, 60);
    assert.equal(r.source, 'originalScore-priority0');
    assert.equal(stats.tier15RecoveryOverV6, 1);
  });

  test('a recovered star the ensemble contradicts across buckets keeps the LLM and is flagged', () => {
    const flags = [];
    const d = cleared({ previousOriginalScore: '4/5 stars', llmScore: { score: 26, confidence: 'medium' } });
    const r = getBestScore(d, { flagForHumanReview: (_d, reason) => flags.push(reason) });
    assert.equal(r.source, 'llm-v6');
    assert.equal(r.score, 26);
    assert.deepEqual(flags, ['tier15-recovery-llm-conflict']);
  });

  test('a low-confidence LLM does not veto the recovered star', () => {
    const r = getBestScore(cleared({ previousOriginalScore: '4/5', llmScore: { score: 46, confidence: 'low' } }));
    assert.equal(r.score, 80);
  });

  test('low-reliability extraction source is not recovered over llm-v6', () => {
    const r = getBestScore(cleared({ originalScoreSource: 'numeric-stars' }));
    assert.equal(r.source, 'llm-v6');
    assert.equal(r.score, 76);
  });

  test('ambiguous bare-number previous score is not recovered', () => {
    assert.equal(tier15RecoveredStarForV6(cleared({ previousOriginalScore: '100' })), null);
    assert.equal(getBestScore(cleared({ previousOriginalScore: '100' })).source, 'llm-v6');
  });

  test('no-score outlet: the clear stands', () => {
    const d = cleared({ outletId: 'nydailynews' });
    assert.equal(isTier15OverrideActive(d), false);
    assert.equal(getBestScore(d).source, 'llm-v6');
  });

  test('a clear for another reason is not a tier-1.5 override', () => {
    const d = cleared({ originalScoreClearedReason: 'aggregator-in-p0-slot' });
    assert.equal(isTier15OverrideActive(d), false);
    assert.equal(getBestScore(d).source, 'llm-v6');
  });

  test('anchored-v6 is untouched (already band-constrained)', () => {
    const d = cleared({ scoreSource: 'anchored-v6', llmScore: { score: 66, confidence: 'high', band: { floor: 51, ceiling: 70 } } });
    assert.equal(getBestScore(d).source, 'anchored-v6');
  });
});

describe('late-star-anchor after a refetch restores the cleared star', () => {
  test('structural refetch retires the clear, then the file is queued for an anchored re-score', () => {
    const d = cleared({ category: 'west-end' });
    // Before the refetch there is no stored star, so nothing to anchor to.
    assert.equal(needsLateStarReanchor(d), null);
    setExtractedScore(d, { value: '3/5 stars', normalizedValue: 60, source: 'timeout-svg-stars' });
    assert.notEqual(d.originalScoreCleared, true, 'structural star retires the tier-1.5 clear');
    assert.equal(d.originalScore, '3/5 stars');
    const r = needsLateStarReanchor(d);
    assert.ok(r && r.band, 'should return a band');
    assert.equal(r.band.floor, 51);
    assert.equal(r.band.ceiling, 70);
  });
});
