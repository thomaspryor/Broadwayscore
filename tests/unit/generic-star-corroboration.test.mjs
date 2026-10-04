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
  detectBandFromReviewFile,
  adjudicationContradictsRecordStar,
  adjudicationStarBasisGone,
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

describe('detectBandFromReviewFile (write-time anchoring)', () => {
  test('an uncorroborated generic star no longer pins the rescore band as high-reliability', () => {
    const r = detectBandFromReviewFile(mincemeat());
    assert.ok(r && r.band);
    assert.equal(r.highReliability, false);
  });
  test('a corroborated or dedicated-extractor star keeps high-reliability', () => {
    assert.equal(detectBandFromReviewFile(mincemeat({ llmScore: { score: 25, confidence: 'high' } })).highReliability, true);
    assert.equal(detectBandFromReviewFile(mincemeat({ originalScoreSource: 'json-ld', scoreSource: 'json-ld' })).highReliability, true);
  });
});

describe('adjudicationContradictsRecordStar (cousins: Dolls House Part 2, Waverly Gallery)', () => {
  const dolls = (over = {}) => ({
    outletId: 'theater-life', originalScore: '4/5 stars', originalScoreNormalized: 80,
    originalScoreSource: 'text-footer-corrected', scoreSource: 'text-footer-corrected',
    llmScore: { score: 78, confidence: 'high' }, ensembleData: { needsReview: false }, fullText: 'x'.repeat(400),
    adjudicatedScore: 40, adjudicationNote: NOTE, adjudicationHistory: [{ sidedWith: 'originalScore' }], ...over,
  });
  test('adjudication that claims the star but sits in another bucket than the record star is contradicted', () => {
    assert.equal(adjudicationContradictsRecordStar(dolls()), true);
  });
  test('in-band placement, no star, or a low-reliability star are left to the other guards', () => {
    assert.equal(adjudicationContradictsRecordStar(dolls({ adjudicatedScore: 78 })), false);
    assert.equal(adjudicationContradictsRecordStar(dolls({ originalScoreNormalized: null })), false);
    assert.equal(adjudicationContradictsRecordStar(dolls({ originalScoreSource: 'numeric-stars', scoreSource: 'numeric-stars' })), false);
  });
  test('an adjudication that sided with the text/LLM is never second-guessed here', () => {
    assert.equal(adjudicationContradictsRecordStar(dolls({ adjudicationHistory: [{ sidedWith: 'llm' }] })), false);
  });
  test('getBestScore ships the record star (80), not the contradicting 40', () => {
    const r = getBestScore(dolls(), { stats: {} });
    assert.equal(r.score, 80);
    assert.equal(r.source, 'originalScore-priority0');
  });
});

describe('adjudicationStarBasisGone (take-me-out-2022 Theater Life: adjudicated 40, models 82-87, no rating on record)', () => {
  const noStar = (over = {}) => ({
    outletId: 'theater-life', fullText: 'x'.repeat(400), scoreSource: 'llm-v6',
    llmScore: { score: 84, confidence: 'high' }, ensembleData: { needsReview: false },
    adjudicatedScore: 40, adjudicationNote: NOTE, adjudicationHistory: [{ sidedWith: 'originalScore' }], ...over,
  });
  test('sided with the star, but no rating anywhere on the record', () => {
    assert.equal(adjudicationStarBasisGone(noStar()), true);
    assert.equal(adjudicationStarBasisGone(noStar({ originalScore: null, originalScoreNormalized: null, aggregatorStars: '' })), true);
  });
  test('any surviving rating field keeps the adjudication', () => {
    for (const f of [{ originalScore: '2/5 stars' }, { originalScoreNormalized: 40 }, { aggregatorStars: '2/5' },
      { starRating: '2/5' }, { originalRating: 'C' }, { previousOriginalScore: '2/5' }]) {
      assert.equal(adjudicationStarBasisGone(noStar(f)), false, JSON.stringify(f));
    }
  });
  test('BRO-4596: a cleared record with a stale originalScoreNormalized has no basis either', () => {
    assert.equal(adjudicationStarBasisGone(noStar({ originalScoreCleared: true, originalScoreNormalized: 40, previousOriginalScore: '2/5' })), true);
  });
  test('an adjudication that sided with the text/thumbs is untouched', () => {
    assert.equal(adjudicationStarBasisGone(noStar({ adjudicationHistory: [{ sidedWith: 'thumbs' }], adjudicationNote: 'Auto-adjudicated (high confidence, sided with thumbs): x' })), false);
  });
  test('getBestScore drops it and scores the text (84), not the phantom-star 40', () => {
    const stats = {};
    const r = getBestScore(noStar(), { stats });
    assert.equal(r.score, 84);
    assert.notEqual(r.source, 'adjudicated');
    assert.equal(stats.adjudicationSkippedUncorroboratedStar, 1);
  });
});

describe('adjudicationSidedWithStars', () => {
  test('covers the wording variants seen in the corpus', () => {
    for (const w of ['aggregatorStars', 'rating', 'aggregator', 'stars', 'originalScore']) {
      assert.equal(adjudicationSidedWithStars({ adjudicationHistory: [{ sidedWith: w }] }), true, w);
    }
  });
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
  test('a null originalScoreNormalized is not read as a 0-point star', () => {
    const r = getBestScore(mincemeat({ originalScoreNormalized: null }), { stats: {} });
    assert.equal(r.score, 40);
    assert.equal(r.source, 'adjudicated');
  });
  test('the last-resort aggregatorStars fallback cannot re-ingest the junk star', () => {
    const r = getBestScore(mincemeat({ ensembleData: undefined, adjudicatedScore: undefined, llmScore: { score: 67, confidence: 'medium' } }), { stats: {} });
    // no ensemble data and no other score field: unscored (null), not a fabricated 20
    assert.equal(r, null);
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

describe('BRO-4596: clearing a star must not leave its star-sided adjudication publishing', () => {
  const { invalidateStarSidedAdjudication } = require('../../scripts/lib/star-reliability.js');
  const cleared = (over = {}) => mincemeat({
    originalScore: null, originalScoreNormalized: null, aggregatorStars: undefined,
    originalScoreSource: undefined, scoreSource: 'llm-v6',
    previousOriginalScore: '1/5', originalScoreCleared: true,
    llmScore: { score: 82, confidence: 'high' }, ...over,
  });

  test('previousOriginalScore on an originalScoreCleared record is no basis', () => {
    assert.equal(adjudicationStarBasisGone(cleared()), true);
    assert.equal(adjudicationStarBasisGone(cleared({ originalScoreCleared: undefined })), false);
    assert.equal(adjudicationStarBasisGone(cleared({ aggregatorStars: '4/5' })), false);
  });

  test('getBestScore no longer publishes the dependent adjudication of an already-cleared record', () => {
    const r = getBestScore(cleared(), { stats: {} });
    assert.notEqual(r && r.score, 40, JSON.stringify(r));
  });

  test('helper drops a star-sided adjudication, keeps an audit copy and history entry', () => {
    const d = cleared();
    assert.equal(invalidateStarSidedAdjudication(d, 'tier 1.5'), true);
    assert.equal(d.adjudicatedScore, null);
    assert.equal(d.adjudicatedScoreInvalidated.score, 40);
    assert.equal(d.adjudicatedScoreInvalidated.reason, 'tier 1.5');
    assert.equal(adjudicationSidedWithStars(d), false);
    assert.equal(invalidateStarSidedAdjudication(d, 'again'), false);
  });

  test('helper leaves an adjudication that sided with the models', () => {
    const d = cleared({ adjudicationHistory: [{ sidedWith: 'llm' }], adjudicationNote: 'Auto-adjudicated (high confidence, sided with llm): x' });
    assert.equal(invalidateStarSidedAdjudication(d, 'x'), false);
    assert.equal(d.adjudicatedScore, 40);
    assert.equal(invalidateStarSidedAdjudication(null, 'x'), false);
  });

  test('every script that discards a star calls the helper', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['fix-p0-score-corruption.js', 'reconcile-source-scores.js']) {
      assert.match(readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8'), /invalidateStarSidedAdjudication\(/, f);
    }
  });
});
