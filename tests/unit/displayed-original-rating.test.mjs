import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { displayedOriginalRating } = require('../../scripts/lib/displayed-original-rating.js');

const band = (floor, ceiling) => ({ band: { floor, ceiling, fraction: 0.5 } });

test('a rating that is the score is shown (originalScore-priority0)', () => {
  assert.equal(displayedOriginalRating('originalScore-priority0', { originalScore: '4/5 stars' }), '4/5 stars');
});

test('a relayed aggregator star that drove the score is shown', () => {
  assert.equal(displayedOriginalRating('aggregatorStars-relay', { aggregatorStars: '3/5 stars' }), '3/5 stars');
  assert.equal(displayedOriginalRating('aggregatorStars-fallback', { aggregatorStars: '3/5 stars' }), '3/5 stars');
});

test('an anchored review shows the rating whose band it was scored within', () => {
  const data = { outletId: 'whatsonstage', scoreSource: 'anchored-v6', originalScore: '2/5 stars', aggregatorStars: '3/5 stars', llmScore: band(31, 50) };
  assert.equal(displayedOriginalRating('anchored-v6', data), '2/5 stars');
});

test('an anchored review with only a relayed star shows that star', () => {
  const data = { outletId: 'revstanstheatreblog', scoreSource: 'anchored-v6', aggregatorStars: '5/5 stars', llmScore: band(91, 100) };
  assert.equal(displayedOriginalRating('anchored-v6', data), '5/5 stars');
});

test('an anchored letter grade is shown', () => {
  const data = { outletId: 'ew', scoreSource: 'anchored-v6', originalScore: 'B+', fullText: 'A fine night. Grade: B+', llmScore: band(77, 82) };
  assert.equal(displayedOriginalRating('anchored-v6', data), 'B+');
});

test('a rating extracted after anchoring (different band) is not shown', () => {
  // Equus/Telegraph: anchored to a relayed 5/5 (91-100), then the outlet's own 4/5 was extracted (71-90).
  const data = { outletId: 'telegraph', scoreSource: 'anchored-v6', originalScore: '4/5 stars', aggregatorStars: '5/5 stars', llmScore: band(91, 100) };
  assert.equal(displayedOriginalRating('anchored-v6', data), null);
});

test('an anchored review with no stored band shows nothing', () => {
  const data = { outletId: 'whatsonstage', scoreSource: 'anchored-v6', originalScore: '2/5 stars', llmScore: { score: 38 } };
  assert.equal(displayedOriginalRating('anchored-v6', data), null);
  assert.equal(displayedOriginalRating('anchored-v6', { outletId: 'whatsonstage', scoreSource: 'anchored-v6', originalScore: '2/5 stars' }), null);
});

test('a rating that played no part in the score is not shown', () => {
  const data = { outletId: 'whatsonstage', originalScore: '2/5 stars', aggregatorStars: '3/5 stars', llmScore: band(31, 50) };
  assert.equal(displayedOriginalRating('llm-v6', data), null);
  assert.equal(displayedOriginalRating('llmScore', data), null);
  assert.equal(displayedOriginalRating('human-review', data), null);
  assert.equal(displayedOriginalRating('adjudicated', data), null);
});

test('an anchored review with no detectable rating shows nothing', () => {
  assert.equal(displayedOriginalRating('anchored-v6', { outletId: 'nytimes', scoreSource: 'anchored-v6', llmScore: band(71, 90) }), null);
});
