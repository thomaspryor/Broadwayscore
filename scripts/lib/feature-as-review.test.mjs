import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { featureUrlSignal, paraphrasedReviewSignal } = require('./feature-as-review.js');

test('feature / blog / interview urls are flagged; review urls are not, even under /news/', () => {
  assert.equal(featureUrlSignal('https://archive.nytimes.com/artsbeat.blogs.nytimes.com/2010/04/14/the-men-behind-the-musicians-of-million-dollar-quartet/'), 'blog');
  assert.equal(featureUrlSignal('https://example.com/interview-with-the-cast/'), 'interview');
  assert.equal(featureUrlSignal('https://www.whatsonstage.com/news/romeo-and-juliet-review-tom-holland_1603000/'), null);
  assert.equal(featureUrlSignal('http://theater.nytimes.com/2010/04/12/theater/reviews/12million.html'), null);
  assert.equal(featureUrlSignal(null), null);
});

test('a body that reports another critic\'s verdict is flagged', () => {
  assert.ok(paraphrasedReviewSignal('Opened Sunday. In his review, Charles Isherwood calls it buoyant.'));
  assert.ok(paraphrasedReviewSignal('Times critic Ben Brantley called the revival a triumph.'));
  assert.equal(paraphrasedReviewSignal('The revival is a triumph and the cast is superb.'), null);
});
