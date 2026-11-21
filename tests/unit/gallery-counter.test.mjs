/**
 * BRO-305: an Evening Standard photo-gallery counter ("1/5", "1/10" alone on a
 * line) was stored as the critic's rating. Lehman Trilogy shipped 20 on a warm
 * review because the anchored scorer then held the score inside the 1/10 band,
 * which also hid it from the star-vs-score mismatch check (gap 0).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isGalleryCounterAt, isGalleryCounterRating } = require('../../scripts/lib/gallery-counter.js');
const { verifyInText } = require('../../scripts/lib/llm-score-extractor.js');
const { extractUKStarRating, extractGenericStarRating } = require('../../scripts/lib/score-extractors.js');
const { evaluateReview } = require('../../scripts/lib/star-score-mismatch.js');
const { applyVerifiedOriginalScore } = require('../../scripts/lib/verified-original-score.js');
const { queueRescoreForClearedRating } = require('../../scripts/lib/rescore-flagging.js');

const filler = 'The cast is superb and the production absorbing throughout the evening. '.repeat(12);
// Shape of the scraped Evening Standard page (american-buffalo-west-end-2015).
const STANDARD_TEXT = `${filler}\n\nAmerican Buffalo: new pictures show Damian Lewis rehearsing\n\n1/5\n\n${filler}\nUntil June 27, Wyndham's Theatre`;
const LEHMAN_TEXT = `${filler}\n\n1/10\n\n${filler}`;

test('a standalone 1/N line is a gallery counter', () => {
  assert.equal(isGalleryCounterRating('1/5', STANDARD_TEXT), true);
  assert.equal(isGalleryCounterRating('1/10', LEHMAN_TEXT), true);
  const at = STANDARD_TEXT.indexOf('1/5');
  assert.equal(isGalleryCounterAt(STANDARD_TEXT, at, 3), true);
});

test('counter detection survives formatting and unrelated dates (review findings)', () => {
  // The LLM raw / stored string often adds "stars".
  assert.equal(isGalleryCounterRating('1/5 stars', STANDARD_TEXT), true);
  // CRLF text.
  const crlf = STANDARD_TEXT.replace(/\n/g, '\r\n');
  assert.equal(isGalleryCounterRating('1/5', crlf), true);
  assert.equal(isGalleryCounterAt(crlf, crlf.indexOf('1/5'), 3), true);
  assert.equal(extractGenericStarRating('', `${filler}\r\n\r\n1/5\r\n`), null);
  // Run dates and fractions elsewhere are not inline uses of the rating.
  for (const extra of ['Until 11/5, Wyndham\'s', 'Opened 1/5/2015', 'a 1/5th share']) {
    assert.equal(isGalleryCounterRating('1/5', `${STANDARD_TEXT}\n${extra}`), true, extra);
  }
  assert.equal(isGalleryCounterRating('1/5', null), false);
});

test('real ratings are not counters', () => {
  // London Theatre prints its real rating as a "4/5" line: numerator is not 1.
  assert.equal(isGalleryCounterRating('4/5', `${filler}\n4/5\n${filler}`), false);
  // A 1/5 used in prose is a rating.
  assert.equal(isGalleryCounterRating('1/5', `${filler} I give it 1/5 stars.\n`), false);
  // Counter line plus the same fraction in a verdict sentence: keep the rating.
  assert.equal(isGalleryCounterRating('1/5', `${filler}\n1/5\n${filler} Rating: 1/5`), false);
  // A rating label above the line makes it the value, not a counter.
  assert.equal(isGalleryCounterRating('1/5', `${filler}\nRating:\n1/5\n${filler}`), false);
  const labelled = `${filler}\nOur verdict\n\n1/5\n`;
  assert.equal(isGalleryCounterAt(labelled, labelled.lastIndexOf('1/5'), 3), false);
  const prose = `${filler} rated 1/5 here`;
  assert.equal(isGalleryCounterAt(prose, prose.indexOf('1/5'), 3), false);
});

test('LLM extractor: a counter does not verify as a rating', () => {
  for (const type of ['numeric', 'stars']) {
    assert.equal(verifyInText({ found: true, raw: '1/5', value: 1, scale: 5, type }, STANDARD_TEXT), null);
  }
  assert.equal(verifyInText({ found: true, raw: '1/10', value: 1, scale: 10, type: 'numeric' }, LEHMAN_TEXT), null);
  const tailCounter = `${filler}\n\n1/5\n`;
  assert.equal(verifyInText({ found: true, raw: '1/5 stars', value: 1, scale: 5, type: 'stars' }, tailCounter), null);
  // Control: a printed fraction still verifies.
  const real = `${filler}\nOur verdict: 4/5`;
  assert.ok(verifyInText({ found: true, raw: '4/5', value: 4, scale: 5, type: 'numeric' }, real));
});

test('regex extractors skip the counter line', () => {
  assert.equal(extractUKStarRating('', STANDARD_TEXT), null);
  const tail = `${filler}\n\n1/5\n`;
  assert.equal(extractGenericStarRating('', tail), null);
  // Control: a verdict 2/5 near the end is still read.
  const real = `${filler}\nVerdict: 2/5\n`;
  assert.ok(extractUKStarRating('', real));
});

test('mismatch scan flags a stored counter even when the anchored LLM agrees', () => {
  const finding = evaluateReview({
    originalScore: '1/10', originalScoreSource: 'llm-gemini', scoreSource: 'anchored-v6',
    assignedScore: 20, llmScore: { score: 20, confidence: 'medium' }, fullText: LEHMAN_TEXT,
  });
  assert.ok(finding, 'Lehman shape must alert');
  assert.equal(finding.galleryCounter, true);
  // A real 1/10 the scorer agrees with does not alert.
  assert.equal(evaluateReview({
    originalScore: '1/10', scoreSource: 'anchored-v6', assignedScore: 15,
    llmScore: { score: 15, confidence: 'medium' }, fullText: `${filler} Score: 1/10`,
  }), null);
});

test('clearing a star queues a rescore of an LLM score that saw it', () => {
  const data = { outletId: 'standard', originalScore: '1/10', originalScoreNormalized: 10, scoreSource: 'anchored-v6', llmScore: { score: 20 } };
  assert.equal(applyVerifiedOriginalScore(data, null, 'gallery counter').ok, true);
  assert.equal(data.originalScoreCleared, true);
  assert.equal(data.needsRescore, true);
  assert.match(data.rescoreReason, /BRO-305/);
  // A human score is not touched by a rescore, so no flag.
  const human = { outletId: 'standard', originalScore: '1/10', scoreSource: 'anchored-v6', humanReviewScore: 80 };
  applyVerifiedOriginalScore(human, null, 'gallery counter');
  assert.notEqual(human.needsRescore, true);
});

test('cleared-rating rescore keeps the needsRescore => scoreable invariant', () => {
  const base = () => ({ outletId: 'standard', criticName: 'Henry Hitchings', fullText: LEHMAN_TEXT, contentTier: 'complete', scoreSource: 'anchored-v6', llmScore: { score: 20 } });
  assert.equal(queueRescoreForClearedRating(base(), 'x'), true);
  assert.equal(queueRescoreForClearedRating({ ...base(), _locked: true }, 'x'), false);
  assert.equal(queueRescoreForClearedRating({ ...base(), wrongShow: true }, 'x'), false);
  // Anchored read whose scoreSource an extractor relabelled still counts.
  assert.equal(queueRescoreForClearedRating({ ...base(), scoreSource: 'text-pattern', llmScore: { score: 20, band: { floor: 0, ceiling: 30 } } }, 'x'), true);
  assert.equal(queueRescoreForClearedRating({ ...base(), scoreSource: 'text-pattern' }, 'x'), false);
  // A provisional human score is still replaced by the LLM read.
  assert.equal(queueRescoreForClearedRating({ ...base(), humanReviewScore: 40, humanReviewScoreProvisional: true }, 'x'), true);
});
