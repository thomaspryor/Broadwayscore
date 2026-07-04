import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUrlClusters, canonicalReviewUrl } = require('../../scripts/lib/review-url-clusters.js');

test('canonicalReviewUrl strips query/hash/trailing slash and lowercases', () => {
  assert.equal(canonicalReviewUrl('https://x.com/Review/?utm=1#top'), 'https://x.com/review');
  assert.equal(canonicalReviewUrl('https://x.com/review/'), 'https://x.com/review');
  assert.equal(canonicalReviewUrl(null), '');
});

test('flags a byline explosion: one URL under many critic names', () => {
  const url = 'https://www.whatsonstage.com/news/midsummer-regents-park-review_1726521';
  const reviews = ['Alun Hood', 'Alex Wood', 'Miriam Sallon', 'Daniel Perks', 'Judi Herman', 'Theo Bosanquet']
    .map((c, i) => ({ file: `whatsonstage--${i}.json`, url: `${url}?variant=${i}`, criticName: c, contentTier: 'invalid' }));
  const clusters = findUrlClusters(reviews, 5);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 6);
  assert.equal(clusters[0].invalidCount, 6);
  assert.equal(clusters[0].bylines.length, 6);
});

test('does NOT flag a healthy show: distinct URLs, one per outlet', () => {
  const reviews = [
    { url: 'https://guardian.com/a', criticName: 'A' },
    { url: 'https://times.com/b', criticName: 'B' },
    { url: 'https://standard.com/c', criticName: 'C' },
    { url: 'https://whatsonstage.com/d', criticName: 'D' },
    { url: 'https://timeout.com/e', criticName: 'E' },
  ];
  assert.equal(findUrlClusters(reviews, 5).length, 0);
});

test('does NOT flag a legit syndication pair (below threshold)', () => {
  const reviews = [
    { url: 'https://ap.com/x', criticName: 'Mark Kennedy' },
    { url: 'https://ap.com/x', criticName: 'Mark Kennedy' },
  ];
  assert.equal(findUrlClusters(reviews, 5).length, 0);
});
