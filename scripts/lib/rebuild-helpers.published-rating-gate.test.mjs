/**
 * scripts/lib/rebuild-helpers.js P0.5 published-rating gate — BRO-4204 audit S6-T5.
 *
 * A bare numeric originalScore (Show-Score's 75 relayed by a manual writer) is
 * NOT a published rating. P0.5 requires isUnambiguousRatingString, an
 * OUTLET_VERIFIED source, or the star form in starRating. When aggregatorStars
 * drives the score the source is labelled 'aggregatorStars-relay' and
 * rebuild-all-reviews.js displays the relayed star as originalRating.
 *
 * Uses the REAL getBestScore / publishedRatingEvidence (CLAUDE.md §15).
 *
 * Run: node --test scripts/lib/rebuild-helpers.published-rating-gate.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  getBestScore,
  publishedRatingEvidence,
  isPublishedRatingEvidence,
  isUnambiguousRatingString,
  isOnStarLadder,
  SCORE_SOURCE_LABELS,
} = require('./rebuild-helpers.js');
const { OUTLET_VERIFIED_SOURCES, KNOWN_STAR_OUTLETS } = require('./score-extractors.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Real the-rocky-horror-show-2026 manual-ingest shape (humanReviewScore removed
// so P0.5 is the path under test). Show-Score relayed 75; no star form anywhere.
const ROCKY_NUMERIC = {
  outletId: 'nytimes',
  source: 'manual',
  originalScore: 75,
  fullText: 'x'.repeat(300),
  llmScore: { score: 82, confidence: 'high' },
  ensembleData: { modelAgreement: 'unanimous' },
};

describe('publishedRatingEvidence', () => {
  test('Rocky Horror shape: originalScore 75 numeric, source manual, no starRating → NOT a published rating', () => {
    assert.equal(publishedRatingEvidence(75, ROCKY_NUMERIC), null);
    assert.equal(isPublishedRatingEvidence('75', ROCKY_NUMERIC), false);
  });

  test('"4/5 stars" → rating (unambiguous star form)', () => {
    assert.equal(publishedRatingEvidence('4/5 stars', { source: 'manual' }), 'unambiguous');
    assert.equal(publishedRatingEvidence('★★★★', {}), 'unambiguous');
    assert.equal(publishedRatingEvidence('B+', {}), 'unambiguous');
    assert.equal(publishedRatingEvidence('4 out of 5', {}), 'unambiguous');
  });

  test('"88.6/100" from theatre-record → rating, per isUnambiguousRatingString (explicit denominator) — documented decision', () => {
    // An X/N form re-parses reliably (parseNumericRating handles "/100"), so the
    // shared helper treats it as unambiguous even from a relay source. Gating
    // X/100 strings on provenance would need its own field; not done here.
    assert.equal(isUnambiguousRatingString('88.6/100'), true);
    assert.equal(publishedRatingEvidence('88.6/100', { source: 'theatre-record' }), 'unambiguous');
  });

  test('bare numeric / percentage strings with a verified extraction source are ratings', () => {
    assert.ok(OUTLET_VERIFIED_SOURCES.has('reviewshub-percentage'));
    assert.equal(publishedRatingEvidence('80%', { scoreSource: 'reviewshub-percentage' }), 'verified-scoreSource');
    assert.equal(publishedRatingEvidence('80%', { originalScoreSource: 'reviewshub-percentage' }), 'verified-originalScoreSource');
    assert.equal(publishedRatingEvidence('80%', { scoreSource: 'llm-v6' }), null);
  });

  test('star form riding alongside the normalized number (manual ingest) is evidence', () => {
    assert.equal(publishedRatingEvidence(80, { starRating: '4/5' }), 'starRating');
    assert.equal(publishedRatingEvidence(80, { starRating: '' }), null);
  });

  // 'star-ladder' (S6-T5 follow-up): the strict gate's scoring-delta replaced
  // ~50 T1 star relays (Time Out 60/80, Guardian 80/100, Times UK 80) with LLM
  // reads. A bare number ON the outlet's registry star ladder is that relay.
  test('bare number on the outlet\'s star ladder (registry starScale) is a published rating; off the ladder stays ambiguous', () => {
    assert.equal(publishedRatingEvidence(60, { outletId: 'timeout', source: 'web-search' }, { starScale: 5 }), 'star-ladder');
    assert.equal(publishedRatingEvidence('100', { outletId: 'guardian' }, { starScale: 5 }), 'star-ladder');
    assert.equal(publishedRatingEvidence(75, { outletId: 'usatoday' }, { starScale: 4 }), 'star-ladder', '3 of 4 stars');
    assert.equal(publishedRatingEvidence(75, { outletId: 'timeout' }, { starScale: 5 }), null, 'Rocky Horror\'s 75 is not on a 5-star ladder');
    assert.equal(publishedRatingEvidence(70, { outletId: 'timeout' }, { starScale: 5 }), null, 'half stars are not relayed as whole-star numbers');
    assert.equal(publishedRatingEvidence(88, { outletId: 'ew' }, { starScale: null }), null, 'no starScale → no ladder');
    assert.equal(publishedRatingEvidence(80, { outletId: 'nydailynews' }, { starScale: undefined }), null);
    assert.equal(publishedRatingEvidence(0, { outletId: 'timeout' }, { starScale: 5 }), null, '0 stars is not a rung');
    assert.equal(publishedRatingEvidence(120, { outletId: 'timeout' }, { starScale: 5 }), null);
    assert.equal(isOnStarLadder(80, 5), true);
    assert.equal(isOnStarLadder(80, 4), false);
    assert.equal(isOnStarLadder('60', 5), true);
    assert.equal(isOnStarLadder('3/5', 5), false, 'strings that are not bare numbers are the unambiguous path, not the ladder');
  });

  test('star ladder reads the real registry by outletId when no override is given (timeout=5, usatoday=4, ew=none)', () => {
    assert.equal(publishedRatingEvidence(60, { outletId: 'timeout' }), 'star-ladder');
    assert.equal(publishedRatingEvidence(75, { outletId: 'usatoday' }), 'star-ladder');
    assert.equal(publishedRatingEvidence(75, { outletId: 'timeout' }), null);
    assert.equal(publishedRatingEvidence(88, { outletId: 'ew' }), null);
    assert.equal(publishedRatingEvidence(80, { outletId: 'no-such-outlet' }), null);
  });

  test('getBestScore: Time Out web-search 60 (★★★ relay) keeps originalScore-priority0; the same 60 at an outlet with no star scale falls to the LLM', () => {
    const base = { source: 'web-search', originalScore: 60, fullText: 'x'.repeat(300), llmScore: { score: 71, confidence: 'high' }, ensembleData: { modelAgreement: 'unanimous' } };
    const timeout = getBestScore({ ...base, outletId: 'timeout' });
    assert.equal(timeout.source, 'originalScore-priority0', JSON.stringify(timeout));
    assert.equal(timeout.score, 60);
    const noScale = getBestScore({ ...base, outletId: 'nytg' });
    assert.notEqual(noScale.source, 'originalScore-priority0', JSON.stringify(noScale));
  });
});

describe('getBestScore P0.5 gate', () => {
  test('Rocky Horror numeric 75 falls through to the ensemble LLM (P1), not originalScore-priority0', () => {
    const stats = {};
    const result = getBestScore(ROCKY_NUMERIC, { stats });
    assert.deepEqual(result, { score: 82, source: 'llmScore' });
    assert.equal(stats.skippedAmbiguousOriginalScore, 1);
  });

  test('same file with "4/5 stars" scores from the published rating', () => {
    const result = getBestScore({ ...ROCKY_NUMERIC, originalScore: '4/5 stars' });
    assert.deepEqual(result, { score: 80, source: 'originalScore-priority0' });
  });

  test('numeric originalScore + starRating "3/5" scores from the star form', () => {
    const result = getBestScore({ ...ROCKY_NUMERIC, outletId: 'guardian', originalScore: 60, starRating: '3/5' });
    assert.deepEqual(result, { score: 60, source: 'originalScore-priority0' });
  });

  test('bare numeric with an outlet-verified scoreSource still scores (unchanged behaviour)', () => {
    const result = getBestScore({ ...ROCKY_NUMERIC, outletId: 'thereviewshub', originalScore: '80%', scoreSource: 'reviewshub-percentage' });
    assert.deepEqual(result, { score: 80, source: 'originalScore-priority0' });
  });

  test('ambiguous numeric with no LLM leaves the review unscored at P0.5 (no phantom rating)', () => {
    const result = getBestScore({ outletId: 'nytimes', source: 'manual', originalScore: 75 });
    assert.equal(result, null);
  });

  test('aggregatorStars driving the score is labelled aggregatorStars-relay', () => {
    assert.ok(KNOWN_STAR_OUTLETS.has('guardian'));
    const result = getBestScore({
      outletId: 'guardian', source: 'westendtheatre', aggregatorStars: '4/5',
      fullText: 'x'.repeat(300), llmScore: { score: 90, confidence: 'high' }, ensembleData: {},
    });
    assert.deepEqual(result, { score: 80, source: 'aggregatorStars-relay' });
  });

  test('ambiguous (off-ladder) originalScore falls through to a usable aggregatorStars relay', () => {
    // 82 is not a rung of the Guardian's 5-star ladder (80 would be ★★★★ and
    // count as 'star-ladder' evidence), so it is a bare relayed number.
    const result = getBestScore({
      outletId: 'guardian', source: 'web-search', originalScore: 82, aggregatorStars: '4/5',
      fullText: 'x'.repeat(300), llmScore: { score: 90, confidence: 'high' }, ensembleData: {},
    });
    assert.deepEqual(result, { score: 80, source: 'aggregatorStars-relay' });
  });

  test('originalScore-priority0 label is unchanged when the outlet\'s own rating scores', () => {
    const result = getBestScore({ outletId: 'guardian', originalScore: '4/5', aggregatorStars: '3/5' });
    assert.deepEqual(result, { score: 80, source: 'originalScore-priority0' });
  });
});

describe('rebuild-all-reviews.js emits the relayed star as originalRating', () => {
  test('source text maps aggregatorStars-relay → data.aggregatorStars', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'rebuild-all-reviews.js'), 'utf8');
    assert.match(src, /source === 'aggregatorStars-relay' \|\| source === 'aggregatorStars-fallback'\)\s*\n?\s*\? data\.aggregatorStars \|\| null/);
    // S7-T11: the stats seed is derived from SCORE_SOURCE_LABELS (every label
    // getBestScore emits) instead of a hand-copied list, so the relay counter
    // is seeded at 0 through the spread — assert the label is in the list and
    // the seed spreads it.
    assert.ok(SCORE_SOURCE_LABELS.includes('aggregatorStars-relay'));
    assert.match(src, /\.\.\.Object\.fromEntries\(SCORE_SOURCE_LABELS\.map\(\(label\) => \[label, 0\]\)\)/);
  });
});
