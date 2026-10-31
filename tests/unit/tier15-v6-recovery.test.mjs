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
const { getBestScore, isTier15OverrideActive, tier15RecoveredStarForV6, isUnambiguousRatingString } = require('../../scripts/lib/rebuild-helpers.js');
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

  test('a low-confidence LLM still vetoes a cross-bucket recovered star', () => {
    const r = getBestScore(cleared({ previousOriginalScore: '4/5', llmScore: { score: 46, confidence: 'low' } }));
    assert.equal(r.source, 'llm-v6');
    assert.equal(r.score, 46);
  });

  test('the-lightning-thief-2019 Time Out shape stays 46 (text-pattern star, URL corrected, low-conf LLM)', () => {
    const d = cleared({
      originalScoreSource: undefined, previousOriginalScore: '4/5', originalScoreNormalized: 80,
      originalScoreClearedReason: 'extraction-no-evidence-in-text (tier 1.5, was text-pattern)',
      urlCorrectedFrom: 'https://example.org/old', previousUrl: 'https://example.org/old',
      llmScore: { score: 46, confidence: 'low' },
    });
    const r = getBestScore(d);
    assert.equal(r.source, 'llm-v6');
    assert.equal(r.score, 46);
  });

  test('the extraction source is read from the clear reason when originalScoreSource is gone', () => {
    const base = { originalScoreSource: undefined, originalScoreNormalized: 60, llmScore: { score: 66, confidence: 'high' } };
    const lowRel = cleared({ ...base, originalScoreClearedReason: 'extraction-no-evidence-in-text (tier 1.5, was text-pattern)' });
    assert.equal(tier15RecoveredStarForV6(lowRel), null);
    assert.equal(getBestScore(lowRel).source, 'llm-v6');
    const highRel = cleared({ ...base, originalScoreClearedReason: 'extraction-no-evidence-in-text (tier 1.5, was unicode-stars)' });
    assert.equal(tier15RecoveredStarForV6(highRel).extractedBy, 'unicode-stars');
    assert.equal(getBestScore(highRel).score, 60);
    const unknown = cleared({ ...base, originalScoreClearedReason: 'extraction-no-evidence-in-text' });
    assert.equal(tier15RecoveredStarForV6(unknown), null, 'unknown provenance is not trusted');
  });

  test('a star read before the URL was corrected is not recovered', () => {
    assert.equal(getBestScore(cleared({ urlCorrectedFrom: 'https://example.org/old' })).source, 'llm-v6');
    assert.equal(getBestScore(cleared({ previousUrl: 'https://example.org/old' })).source, 'llm-v6');
  });

  test('the gate judges the value P0.5 ships (originalScoreNormalized)', () => {
    // A stored normalized value within the stale guard's 6 points is what P0.5 ships.
    const d = cleared({ previousOriginalScore: '4 stars', originalScoreNormalized: 76, llmScore: { score: 70, confidence: 'high' } });
    assert.equal(tier15RecoveredStarForV6(d).flat, 76);
    assert.equal(getBestScore(d).score, 76);
    // A stale one (>6 off an unambiguous string) is re-parsed in both places.
    const stale = cleared({ previousOriginalScore: '4 stars', originalScoreNormalized: 20, llmScore: { score: 70, confidence: 'high' } });
    assert.equal(tier15RecoveredStarForV6(stale).flat, 80);
    assert.equal(getBestScore(stale).score, 80);
  });

  test('a date-like previous score (10/18) is not a rating', () => {
    assert.equal(isUnambiguousRatingString('10/18'), false);
    assert.equal(isUnambiguousRatingString('12/25'), false);
    assert.equal(isUnambiguousRatingString('3/5'), true);
    assert.equal(isUnambiguousRatingString('0/3 stars'), true);
    assert.equal(isUnambiguousRatingString('8/10'), true);
    assert.equal(isUnambiguousRatingString('3.5/4'), true);
    assert.equal(isUnambiguousRatingString('17/40'), true); // morris-theatre-dc scale
    assert.equal(tier15RecoveredStarForV6(cleared({ previousOriginalScore: '10/18' })), null);
    assert.equal(getBestScore(cleared({ previousOriginalScore: '10/18' })).source, 'llm-v6');
  });

  test('P0.5 refusing the recovered star falls back to the llm-v6 verdict, not P0.75+', () => {
    const stats = {};
    const d = cleared({ scoreConfidence: 'low', fullText: 'A fine evening. ★★★★★' + ' padding'.repeat(60) });
    const r = getBestScore(d, { stats });
    assert.equal(r.source, 'llm-v6');
    assert.equal(r.score, 76);
    assert.equal(stats.tier15RecoveryRejectedAtP05, 1);
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
