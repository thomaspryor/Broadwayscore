// BRO-5295: findPhantomTextStar against the real extractor on the corpus shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractScore } = require('./score-extractors.js');
const { findPhantomTextStar, phantomRatings, ratingKey } = require('./phantom-text-star.js');

const PAD = ' A filler sentence about the musical, long enough that the extractor treats this as a full review body.';
const rec = (text, extra = {}) => ({ outletId: 'hercampus', originalScore: '2/5', originalScoreSource: 'numeric-stars', fullText: text + PAD, ...extra });

test('Her Campus: 2/5 from "1992 starring" is a phantom, even on a cleared record', () => {
  const d = rec('The film from 1992 starring Meryl Streep.', { originalScoreCleared: true });
  assert.deepEqual(findPhantomTextStar(d, extractScore), { stored: '2/5', phantoms: ['2/5'] });
});

test('phantomRatings sees year+starring, number tail and StarTribune; skips real ratings', () => {
  assert.deepEqual(phantomRatings('in 2004 starring X'), ['4/5']);
  assert.deepEqual(phantomRatings('some 14 stars'), ['4/5']);
  assert.deepEqual(phantomRatings('(c) 2014 StarTribune'), ['4/5']);
  assert.deepEqual(phantomRatings('Verdict: 4 stars. Great.'), []);
  assert.deepEqual(phantomRatings('5 out of 5 starsSaturday August'), []);
});

test('a real rating that the extractor still reproduces is not flagged', () => {
  const d = rec('Verdict: 2 stars. Thin, though it was filmed in 1992 starring Meryl Streep.');
  assert.equal(findPhantomTextStar(d, extractScore), null);
});

test('only the generic text sources are judged; a store without a matching context is ignored', () => {
  assert.equal(findPhantomTextStar(rec('The film from 1992 starring Meryl.', { originalScoreSource: 'timeout-svg-stars' }), extractScore), null);
  assert.equal(findPhantomTextStar(rec('The film from 1995 starring Meryl.', { originalScore: '2/5' }), extractScore), null); // 5/5 phantom, stored 2/5
  assert.equal(findPhantomTextStar(null, extractScore), null);
});

test('ratingKey normalises the stored spellings', () => {
  assert.equal(ratingKey('4/5 stars'), '4/5');
  assert.equal(ratingKey('4.5/5'), '4.5/5');
  assert.equal(ratingKey('4 stars'), '4/5');
  assert.equal(ratingKey('B+'), null);
});
