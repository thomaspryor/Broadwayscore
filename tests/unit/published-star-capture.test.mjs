// BRO-4486: a critic's star printed in the review text must be stored in
// originalScore so scoring anchors to it, and Culture Sauce's nested-<strong>
// star run must be readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findPublishedStarInText, capturePublishedStar } = require('../../scripts/lib/published-star-capture.js');
const { extractScore } = require('../../scripts/lib/score-extractors.js');

const PROSE = 'The cast is lively and the staging is clever, though the second act drags in places. '.repeat(6);

test('Culture Sauce spaced star run at the end of the review', () => {
  const text = `${PROSE}Schadenfreude offers its own comforts. ★★★ ★★ THE CHERRY ORCHARD Park Avenue Armory, Off Broadway`;
  const found = extractScore('', text, 'culturesauce');
  assert.equal(found.originalScore, '5/5 stars');
  assert.equal(found.normalizedScore, 100);
  assert.equal(found.source, 'unicode-stars');
  const twoStars = `${PROSE}a scoreless match. ★★ ☆ ☆☆ THE PASS LaMaMa`;
  assert.equal(extractScore('', twoStars, 'culturesauce').originalScore, '2/5 stars');
});

test('Culture Sauce star runs never join across a line break', () => {
  assert.equal(extractScore('', `${PROSE}★★\n★★★ end.`, 'culturesauce'), null);
});

test('NYSR star in the text is captured for an unanchored file', () => {
  const data = {
    outletId: 'nysr', scoreSource: 'llm-v6', assignedScore: 62,
    fullText: `September 27, 2026 How Shakespeare Saved My Life By Frank Scheck ★★★☆☆ ${PROSE}`,
  };
  assert.equal(capturePublishedStar(data), true);
  assert.equal(data.originalScore, '3/5 stars');
  assert.equal(data.originalScoreSource, 'unicode-stars');
  assert.equal(data.originalScoreNormalized, 60);
  assert.equal(data.originalScoreCapturedFrom, 'fullText');
  assert.equal(data.humanReviewScore, undefined, 'never freezes a flat score');
});

test('a cleared rating, a human score or an existing rating is left alone', () => {
  const base = { outletId: 'nysr', fullText: `By Frank Scheck ★★★☆☆ ${PROSE}` };
  assert.equal(findPublishedStarInText({ ...base, originalScoreCleared: true }), null);
  assert.equal(findPublishedStarInText({ ...base, humanReviewScore: 70 }), null);
  assert.equal(findPublishedStarInText({ ...base, originalScore: '4/5 stars' }), null);
});

test('text the rebuild would not use is never read for stars', () => {
  // ship-check: a Guardian roundup gave Eureka Day another play's ★★★.
  const base = { outletId: 'nysr', fullText: `By Frank Scheck ★★★☆☆ ${PROSE}` };
  assert.equal(findPublishedStarInText({ ...base, wrongProduction: true }), null);
  assert.equal(findPublishedStarInText({ ...base, wrongShow: true }), null);
  assert.equal(findPublishedStarInText({ ...base, duplicateOf: 'nysr--other.json' }), null);
  assert.equal(findPublishedStarInText({ ...base, isRoundupArticle: true }), null);
});

test('an aggregator-sourced file is left to aggregatorStars', () => {
  const data = { outletId: 'nysr', scoreSource: 'show-score-stars', fullText: `By Frank Scheck ★★★☆☆ ${PROSE}` };
  assert.equal(findPublishedStarInText(data), null);
});

test('a bare "4/5" in text is not treated as a published star', () => {
  const data = { outletId: 'timeout', fullText: `${PROSE} We saw it on 4/5 and left at the interval.` };
  assert.equal(findPublishedStarInText(data), null);
});
