/**
 * Unit tests for the anchored-v6 / llm-v6 precedence path in getBestScore.
 *
 * Sprint 3 of star-anchored bands rollout (Phase B). When the ANCHORED_BANDS_PILOT
 * flag was set during scoring, the file's scoreSource is stamped 'anchored-v6'
 * (with band metadata) or 'llm-v6' (unanchored fallback). getBestScore at
 * read-time must prefer the within-band LLM score over the original star-flat,
 * but still defer to humanReviewScore (P0) and adjudicatedScore (P0a).
 *
 * Run: node --test tests/unit/anchored-precedence.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getBestScore } = require('../../scripts/lib/rebuild-helpers');

// Helper: minimal data shape that satisfies getBestScore.
function makeData(extra = {}) {
  return {
    showId: 'test-show',
    outletId: 'guardian',
    source: 'guardian',
    ...extra,
  };
}

describe('anchored-v6 precedence', () => {
  it('anchored-v6 + llmScore wins over originalScore', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      llmScore: { score: 94, band: { floor: 91, ceiling: 100 } },
      originalScore: 100,
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 94);
    assert.strictEqual(res.source, 'anchored-v6');
  });

  it('llm-v6 + llmScore wins over a LOW-reliability late star', () => {
    // llm-v6 means "no usable star AT SCORING TIME". A later-scraped star from a
    // LOW-reliability source (css/text-pattern/numeric-stars) is exactly the
    // noise that made the pipeline keep the LLM in the first place, so the LLM
    // score still wins. See LOW_RELIABILITY_STAR_SOURCES in rebuild-helpers.js.
    const data = makeData({
      scoreSource: 'llm-v6',
      llmScore: { score: 88 },
      originalScore: 80,
      originalScoreSource: 'numeric-stars',
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 88);
    assert.strictEqual(res.source, 'llm-v6');
  });

  it('llm-v6 DEFERS to a HIGH-reliability late-arriving published star', () => {
    // 2026-06-30 behavior change: when an 'llm-v6' review later carries a
    // parseable star from a trustworthy (non-low-reliability) source, the
    // published star wins over the LLM fallback.
    const data = makeData({
      scoreSource: 'llm-v6',
      llmScore: { score: 88 },
      originalScore: '4/5 stars',
      originalScoreSource: 'unicode-stars',
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 80);
  });

  it('llm-v6 DEFERS to an unambiguous star string even with no originalScoreSource', () => {
    // Late stars written without an extraction-source stamp (e.g. cyrano
    // times-uk '5/5 stars') still count when the raw form is unambiguous.
    const data = makeData({
      scoreSource: 'llm-v6',
      llmScore: { score: 92 },
      originalScore: '5/5 stars',
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 100);
  });

  it('band marker heals a stamp-overwritten anchored verdict (extraction label scoreSource)', () => {
    // Anchored-scored (llmScore.band present), then a later star extraction
    // overwrote scoreSource. The anchored verdict must still win over the
    // flat conversion.
    const data = makeData({
      scoreSource: 'telegraph-svg-stars',
      llmScore: { score: 94, band: { floor: 91, ceiling: 100 } },
      originalScore: '5/5 stars',
      originalScoreSource: 'telegraph-svg-stars',
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 94);
    assert.strictEqual(res.source, 'anchored-v6');
  });

  it('STALE band marker (current star outside band) falls through to the published star', () => {
    // equus telegraph shape: anchored to an aggregator-relayed 5/5, but the
    // outlet's own extraction later wrote 4/5. The current star must decide.
    const data = makeData({
      scoreSource: 'telegraph-svg-stars',
      llmScore: { score: 96, band: { floor: 91, ceiling: 100 } },
      originalScore: '4/5 stars',
      originalScoreSource: 'telegraph-svg-stars',
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 80);
    assert.strictEqual(res.source, 'originalScore-priority0');
  });

  it('llm-v6 KEEPS the LLM over a bare-numeric originalScore with no source (aggregator relay)', () => {
    // 2026-07-11 hardening: a bare numeric originalScore with no extraction
    // source is an aggregator's normalized 0-100 relay (Show Score), not a
    // published star. It must NOT knock llm-v6 out of the early return —
    // that shipped Show Score's flat 100 over the LLM's 94 (JCS london-theatre).
    const data = makeData({
      scoreSource: 'llm-v6',
      llmScore: { score: 94 },
      originalScore: 100,
      source: 'show-score-playwright',
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 94);
    assert.strictEqual(res.source, 'llm-v6');
  });

  it('humanReviewScore (P0) still beats anchored-v6', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      llmScore: { score: 94 },
      humanReviewScore: 78,
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 78);
    assert.strictEqual(res.source, 'human-review');
  });

  it('humanReviewScoreProvisional=true does NOT lock — falls through to anchored-v6', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      llmScore: { score: 94 },
      humanReviewScore: 78,
      humanReviewScoreProvisional: true,
    });
    const res = getBestScore(data, { stats: {} });
    assert.strictEqual(res.score, 94);
    assert.strictEqual(res.source, 'anchored-v6');
  });

  it('adjudicatedScore (P0a) beats anchored-v6 when no verified star', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      llmScore: { score: 94 },
      adjudicatedScore: 72,
      // No verified star source → adjudication is allowed
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 72);
    assert.strictEqual(res.source, 'adjudicated');
  });

  it('anchored-v6 with no llmScore falls through to originalScore', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      originalScore: 80,
      // llmScore missing — anchored stamping requires llmScore, but be defensive
    });
    const res = getBestScore(data);
    assert.strictEqual(res.source, 'originalScore-priority0');
    assert.strictEqual(res.score, 80);
  });

  it('anchored-v6 with non-numeric llmScore.score falls through', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      llmScore: { score: null },
      originalScore: 80,
    });
    const res = getBestScore(data);
    assert.strictEqual(res.source, 'originalScore-priority0');
  });

  it('anchored-v6 with out-of-range llmScore.score falls through', () => {
    const data = makeData({
      scoreSource: 'anchored-v6',
      llmScore: { score: 150 },
      originalScore: 80,
    });
    const res = getBestScore(data);
    // 150 is out of [0, 100] — anchored path is skipped, P0.5 runs.
    assert.strictEqual(res.source, 'originalScore-priority0');
  });

  it('unrelated scoreSource (json-ld) is unaffected by Sprint 3', () => {
    const data = makeData({
      scoreSource: 'json-ld',
      originalScore: 100,
    });
    const res = getBestScore(data);
    assert.strictEqual(res.score, 100);
    assert.strictEqual(res.source, 'originalScore-priority0');
  });

  it('boundary scores 0 and 100 both pass through', () => {
    const a = makeData({ scoreSource: 'anchored-v6', llmScore: { score: 0 } });
    const b = makeData({ scoreSource: 'anchored-v6', llmScore: { score: 100 } });
    assert.strictEqual(getBestScore(a).score, 0);
    assert.strictEqual(getBestScore(b).score, 100);
  });
});

describe('shouldUseAnchoredMode (Phase B-WE W1-T3)', () => {
  const { shouldUseAnchoredMode } = require('../../scripts/lib/star-reliability');

  it('west-end category auto-anchors regardless of envFlag', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: 'west-end', envFlag: false }), true);
    assert.strictEqual(shouldUseAnchoredMode({ category: 'west-end', envFlag: true }), true);
  });

  it('off-west-end category auto-anchors regardless of envFlag', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: 'off-west-end', envFlag: false }), true);
  });

  it('broadway + envFlag=true → anchored (existing pilot path preserved)', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: 'broadway', envFlag: true }), true);
  });

  it('broadway + envFlag=false → anchored (in ANCHORED_MARKETS since the 2026-07-20 NYC rollout)', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: 'broadway', envFlag: false }), true);
  });

  it('off-broadway + envFlag=false → anchored (in ANCHORED_MARKETS since the 2026-07-20 NYC rollout)', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: 'off-broadway', envFlag: false }), true);
  });

  it('regional + envFlag=false → unanchored (not in ANCHORED_MARKETS)', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: 'regional', envFlag: false }), false);
  });

  it('category=null → unanchored even with envFlag=true (deny-list drift safety)', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: null, envFlag: true }), false);
  });

  it('category=undefined → unanchored even with envFlag=true', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: undefined, envFlag: true }), false);
  });

  it('category="" → unanchored even with envFlag=true', () => {
    assert.strictEqual(shouldUseAnchoredMode({ category: '', envFlag: true }), false);
  });
});

describe('detectBandFromReviewFile (star-reliability helper)', () => {
  const { detectBandFromReviewFile } = require('../../scripts/lib/star-reliability');

  it('high-reliability 5/5 → band [91,100]', () => {
    const result = detectBandFromReviewFile({
      starRating: '5/5 stars',
      outletId: 'guardian',
      scoreSource: 'json-ld',
    });
    assert.deepStrictEqual(result.band, { fraction: 1, floor: 91, ceiling: 100 });
    assert.strictEqual(result.highReliability, true);
    assert.strictEqual(result.kind, 'star');
  });

  it('low-reliability css-stars 4/5 → band but flagged low-rel', () => {
    const result = detectBandFromReviewFile({
      starRating: '4/5',
      outletId: 'some-blog',
      scoreSource: 'css-stars',
    });
    assert.deepStrictEqual(result.band, { fraction: 0.8, floor: 71, ceiling: 90 });
    assert.strictEqual(result.highReliability, false);
  });

  it('USA Today 3.5/4 (Gardner case) → band [71,90] high-rel', () => {
    const result = detectBandFromReviewFile({
      originalRating: '3.5/4 stars',
      outletId: 'usatoday',
      scoreSource: 'json-ld',
    });
    assert.deepStrictEqual(result.band, { fraction: 0.875, floor: 71, ceiling: 90 });
    assert.strictEqual(result.highReliability, true);
  });

  it('EW letter grade A- → band [83,88] high-rel with fraction:-1 sentinel', () => {
    const result = detectBandFromReviewFile({
      originalRating: 'A-',
      outletId: 'ew',
      scoreSource: 'extracted-grade',
    });
    assert.deepStrictEqual(result.band, { fraction: -1, floor: 83, ceiling: 88 });
    assert.strictEqual(result.kind, 'letter-grade');
  });

  it('no star/grade returns null', () => {
    const result = detectBandFromReviewFile({
      outletId: 'nytimes',
      scoreSource: null,
    });
    assert.strictEqual(result, null);
  });

  it('aggregatorStars used as fallback when starRating missing', () => {
    const result = detectBandFromReviewFile({
      aggregatorStars: '4/5',
      outletId: 'london-box-office',
    });
    assert.deepStrictEqual(result.band, { fraction: 0.8, floor: 71, ceiling: 90 });
  });

  it('empty review file returns null', () => {
    assert.strictEqual(detectBandFromReviewFile(null), null);
    assert.strictEqual(detectBandFromReviewFile({}), null);
  });
});
