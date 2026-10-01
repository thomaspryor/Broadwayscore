/**
 * BRO-4499: a generic free-text star match ("1/5" from page chrome) that the
 * ensemble contradicts must not outrank the model read, through any of the
 * three paths it used to win: the star-sided adjudication (P0a), the direct
 * star / aggregatorStars relay (P0.5), and the adjudication prompt's trusted
 * "Original Rating" label.
 *
 * Fixture mirrors the live Operation Mincemeat / Chicago Tribune / Chris Jones
 * record (reader report 2026-10-01) with the review text replaced by filler.
 *
 * Run: node --test tests/unit/generic-star-corroboration.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  isGenericPatternStar,
  isUncorroboratedGenericStar,
  adjudicationSidedWithStars,
} = require('../../scripts/lib/star-reliability.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
const { buildUserPrompt } = require('../../scripts/lib/adjudication-prompt.js');

const NOTE = 'Auto-adjudicated (high confidence, sided with originalScore): The 1/5 star rating is definitive';
const mincemeat = (over = {}) => ({
  outletId: 'chicagotribune',
  fullText: 'x'.repeat(400),
  scoreSource: 'sentiment-strong-positive',
  originalScoreNormalized: 20,
  originalScoreSource: 'numeric-stars',
  aggregatorStars: '1/5',
  llmScore: { score: 67, confidence: 'medium' },
  ensembleData: { needsReview: false },
  adjudicatedScore: 40,
  adjudicationNote: NOTE,
  adjudicationHistory: [{ sidedWith: 'originalScore', score: 40 }],
  ...over,
});

describe('isGenericPatternStar', () => {
  test('reads originalScoreSource even when a later pass overwrote scoreSource', () => {
    assert.equal(isGenericPatternStar(mincemeat()), true);
  });
  test('dedicated extractor labels are not generic', () => {
    assert.equal(isGenericPatternStar({ originalScoreSource: 'json-ld', scoreSource: 'json-ld' }), false);
    assert.equal(isGenericPatternStar({ originalScoreSource: 'unicode-stars' }), false);
    assert.equal(isGenericPatternStar(null), false);
  });
});

describe('isUncorroboratedGenericStar', () => {
  test('generic star vs a bucket-flipping, 25+ point LLM gap → uncorroborated', () => {
    assert.equal(isUncorroboratedGenericStar(mincemeat(), 20), true);
  });
  test('LLM agrees within 25 points → corroborated', () => {
    assert.equal(isUncorroboratedGenericStar(mincemeat({ llmScore: { score: 40, confidence: 'high' } }), 20), false);
  });
  test('same bucket → corroborated even with a wide gap', () => {
    assert.equal(isUncorroboratedGenericStar(mincemeat({ llmScore: { score: 38, confidence: 'high' } }), 5), false);
  });
  test('low-confidence LLM never discredits a star', () => {
    assert.equal(isUncorroboratedGenericStar(mincemeat({ llmScore: { score: 67, confidence: 'low' } }), 20), false);
  });
  test('a dedicated-extractor star is never discredited here', () => {
    assert.equal(isUncorroboratedGenericStar(mincemeat({ originalScoreSource: 'json-ld', scoreSource: 'json-ld' }), 20), false);
  });
  test('no LLM score → nothing to corroborate against', () => {
    assert.equal(isUncorroboratedGenericStar(mincemeat({ llmScore: null }), 20), false);
  });
});

describe('adjudicationSidedWithStars', () => {
  test('structured sidedWith wins', () => {
    assert.equal(adjudicationSidedWithStars(mincemeat()), true);
    assert.equal(adjudicationSidedWithStars({ adjudicationHistory: [{ sidedWith: 'llm' }], adjudicationNote: NOTE }), false);
  });
  test('falls back to note wording, including "sided with stars"', () => {
    assert.equal(adjudicationSidedWithStars({ adjudicationNote: NOTE }), true);
    assert.equal(adjudicationSidedWithStars({ adjudicationNote: 'Auto-adjudicated (high confidence, sided with stars): x' }), true);
    assert.equal(adjudicationSidedWithStars({ adjudicationNote: 'Auto-adjudicated (high confidence, sided with thumbs): x' }), false);
    assert.equal(adjudicationSidedWithStars({}), false);
  });
});

describe('getBestScore on the Mincemeat-shaped record', () => {
  test('the junk-star adjudication (40) is skipped and the star relay (20) is ignored → LLM text read', () => {
    const stats = {};
    const r = getBestScore(mincemeat(), { stats });
    assert.equal(r.score, 67);
    assert.match(r.source, /^llmScore/);
    assert.equal(stats.adjudicationSkippedUncorroboratedStar, 1);
    assert.equal(stats.skippedUncorroboratedGenericStar, 1);
  });
  test('works with the star only on aggregatorStars (relay slot)', () => {
    const r = getBestScore(mincemeat({ originalScore: undefined, adjudicatedScore: undefined }), { stats: {} });
    assert.equal(r.score, 67);
  });
  test('a human override still wins over everything', () => {
    assert.deepEqual(getBestScore(mincemeat({ humanReviewScore: 90 }), { stats: {} }), { score: 90, source: 'human-review' });
  });
  test('regression guard: a dedicated-extractor 1/5 on the same outlet is still honoured', () => {
    const r = getBestScore(mincemeat({
      originalScore: '1/5 stars', originalScoreSource: 'unicode-stars', scoreSource: 'unicode-stars',
      adjudicatedScore: undefined, aggregatorStars: undefined,
    }), { stats: {} });
    assert.equal(r.score, 20);
  });
  test('regression guard: an adjudication that sided with a verified-extractor star still stands', () => {
    const r = getBestScore(mincemeat({
      originalScoreSource: 'unicode-stars', scoreSource: 'llm-v6', aggregatorStars: undefined,
    }), { stats: {} });
    assert.equal(r.score, 40);
    assert.equal(r.source, 'adjudicated');
  });
});

describe('adjudication prompt labelling', () => {
  const review = { outletId: 'chicagotribune', llmScore: 67, llmBucket: 'Mixed', llmConfidence: 'medium', reason: 'outlier' };
  test('generic-pattern star is labelled UNVERIFIED, not "Original Rating" ground truth', () => {
    const p = buildUserPrompt(review, { outletId: 'chicagotribune', originalScore: '1/5', originalScoreSource: 'numeric-stars', fullText: 'text' }, 'Show');
    assert.match(p, /UNVERIFIED/);
    assert.doesNotMatch(p, /### Original Rating\n/);
  });
  test('dedicated-extractor star on a known star outlet is still trusted', () => {
    const p = buildUserPrompt(review, { outletId: 'chicagotribune', originalScore: '3/5', originalScoreSource: 'unicode-stars', fullText: 'text' }, 'Show');
    assert.match(p, /### Original Rating\n3\/5/);
  });
});
