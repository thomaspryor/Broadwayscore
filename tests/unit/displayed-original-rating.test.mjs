import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { displayedOriginalRating } = require('../../scripts/lib/displayed-original-rating.js');

test('a rating that is the score is shown (originalScore-priority0)', () => {
  assert.equal(displayedOriginalRating('originalScore-priority0', { originalScore: '4/5 stars' }), '4/5 stars');
});

test('a relayed aggregator star that drove the score is shown', () => {
  assert.equal(displayedOriginalRating('aggregatorStars-relay', { aggregatorStars: '3/5 stars' }), '3/5 stars');
  assert.equal(displayedOriginalRating('aggregatorStars-fallback', { aggregatorStars: '3/5 stars' }), '3/5 stars');
});

test('an anchored review shows the rating that pinned its band', () => {
  const data = { outletId: 'whatsonstage', scoreSource: 'anchored-v6', originalScore: '2/5 stars', aggregatorStars: '3/5 stars' };
  assert.equal(displayedOriginalRating('anchored-v6', data), '2/5 stars');
});

test('an anchored review with only a relayed star shows that star', () => {
  const data = { outletId: 'revstanstheatreblog', scoreSource: 'anchored-v6', aggregatorStars: '5/5 stars' };
  assert.equal(displayedOriginalRating('anchored-v6', data), '5/5 stars');
});

test('an anchored letter grade is shown', () => {
  const data = { outletId: 'ew', scoreSource: 'anchored-v6', originalScore: 'B+', fullText: 'A fine night. Grade: B+' };
  assert.equal(displayedOriginalRating('anchored-v6', data), 'B+');
});

test('a rating that played no part in the score is not shown', () => {
  const data = { outletId: 'whatsonstage', originalScore: '2/5 stars', aggregatorStars: '3/5 stars' };
  assert.equal(displayedOriginalRating('llm-v6', data), null);
  assert.equal(displayedOriginalRating('llmScore', data), null);
  assert.equal(displayedOriginalRating('human-review', data), null);
  assert.equal(displayedOriginalRating('adjudicated', data), null);
});

test('an anchored review with no detectable rating shows nothing', () => {
  assert.equal(displayedOriginalRating('anchored-v6', { outletId: 'nytimes', scoreSource: 'anchored-v6' }), null);
});
