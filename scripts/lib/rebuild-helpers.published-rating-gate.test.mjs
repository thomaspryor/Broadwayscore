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

  test('ambiguous originalScore falls through to a usable aggregatorStars relay', () => {
    const result = getBestScore({
      outletId: 'guardian', source: 'web-search', originalScore: 80, aggregatorStars: '4/5',
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
    assert.match(src, /'aggregatorStars-relay': 0/);
  });
});
