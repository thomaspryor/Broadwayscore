import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOriginalRating } from '../../src/lib/format-original-rating';

test('star fractions read as stars, with or without the word', () => {
  assert.equal(formatOriginalRating('4/5 stars'), '4/5 stars');
  assert.equal(formatOriginalRating('4/5'), '4/5 stars');
  assert.equal(formatOriginalRating('3.5 out of 5'), '3.5/5 stars');
  assert.equal(formatOriginalRating('3/4'), '3/4 stars');
});

test('a /10 rating is not called stars', () => {
  assert.equal(formatOriginalRating('7/10'), '7/10');
});

test('a star count with no scale is kept as given', () => {
  assert.equal(formatOriginalRating('4 stars'), '4 stars');
  assert.equal(formatOriginalRating('1 star'), '1 star');
});

test('percentages and letter grades pass through', () => {
  assert.equal(formatOriginalRating('80%'), '80%');
  assert.equal(formatOriginalRating('B+'), 'B+');
  assert.equal(formatOriginalRating('c-'), 'C-');
  assert.equal(formatOriginalRating('B–'), 'B-');
  assert.equal(formatOriginalRating('F'), 'F');
});

test('ambiguous or non-rating values are dropped', () => {
  assert.equal(formatOriginalRating('82'), null);
  assert.equal(formatOriginalRating('4'), null);
  assert.equal(formatOriginalRating('Sentiment: Positive'), null);
  assert.equal(formatOriginalRating('Positive'), null);
  assert.equal(formatOriginalRating(''), null);
  assert.equal(formatOriginalRating(null), null);
  assert.equal(formatOriginalRating(undefined), null);
});
