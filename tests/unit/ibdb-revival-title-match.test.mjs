import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRevivalTitleMatch, normalizeForTitleMatch } = require('../../scripts/lib/ibdb-dates.js');

const ibdb = (slug, title) => ({ url: `https://www.ibdb.com/broadway-production/${slug}`, title });

test('word overlap alone is not a prior production (BRO-5975: You Go On vs Before You Go)', () => {
  assert.equal(isRevivalTitleMatch('You Go On', ibdb('before-you-go-3113', 'Before You Go')), false);
});

test('exact titles still match, accents and "&" folded', () => {
  assert.equal(isRevivalTitleMatch('La Bohème', ibdb('la-boheme-4524', 'La Bohème | IBDB')), true);
  assert.equal(isRevivalTitleMatch('Miss Julie', ibdb('miss-julie-2782', 'Miss Julie')), true);
  assert.equal(isRevivalTitleMatch('Romeo & Juliet', ibdb('romeo-and-juliet-532', 'Romeo and Juliet')), true);
});

test('"&" and "and" normalize the same', () => {
  assert.equal(normalizeForTitleMatch('Romeo & Juliet'), normalizeForTitleMatch('Romeo and Juliet'));
  assert.equal(normalizeForTitleMatch('Jekyll&Hyde'), 'jekyll and hyde');
});

test('a short title inside a much longer one is still rejected', () => {
  assert.equal(isRevivalTitleMatch('The Unknown', ibdb('the-unknown-soldier-and-his-wife-3', 'The Unknown Soldier and His Wife')), false);
});
