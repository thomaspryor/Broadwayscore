// BRO-6606: the shared urlLooksLikeReview refuses film-fan, book shop and announcement URLs for every caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { urlLooksLikeReview } = require('./review-guards.js');

test('urlLooksLikeReview refuses non-review hosts and announcement slugs', () => {
  for (const u of [
    'https://letterboxd.com/pattinsins/film/the-little-mermaid-2023/',
    'https://timesbookshop.co.uk/pig-heart-boy-9781839044472/',
    'https://theatreweekly.com/full-details-announced-for-jekyll-hyde-at-liverpool-everyman-this-july/',
  ]) assert.equal(urlLooksLikeReview(u, 'Jekyll and Hyde'), false, u);
});

test('urlLooksLikeReview still accepts a real review URL', () => {
  assert.equal(
    urlLooksLikeReview('https://www.theguardian.com/stage/article/2024/jun/27/sense-and-sensibility-review-pitlochry-festival-theatre', 'Sense and Sensibility'),
    true,
  );
});

test('an announcement-token slug that is a review still passes', () => {
  assert.equal(urlLooksLikeReview('https://example.com/reviews/jekyll-hyde-uk-tour-review', 'Jekyll and Hyde'), true);
});
