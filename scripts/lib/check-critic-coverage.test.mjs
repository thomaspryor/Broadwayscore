import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlKey, ourUrlsFor, mergeArticlesBySource, computeCriticCoverage } from './check-critic-coverage.js';

test('urlKey normalizes protocol, www, trailing slash, and query string', () => {
  assert.equal(urlKey('https://www.nytimes.com/2026/06/07/theater/foo.html'), 'nytimes.com/2026/06/07/theater/foo.html');
  assert.equal(urlKey('http://nytimes.com/2026/06/07/theater/foo.html/'), 'nytimes.com/2026/06/07/theater/foo.html');
  assert.equal(urlKey('https://www.vulture.com/article/foo.html?utm_source=x'), 'vulture.com/article/foo.html');
});

test('urlKey returns null for unparseable input', () => {
  assert.equal(urlKey('not a url'), null);
  assert.equal(urlKey(''), null);
});

test('ourUrlsFor only matches the given critic name', () => {
  const reviews = [
    { criticName: 'Jesse Green', url: 'https://www.nytimes.com/a.html' },
    { criticName: 'Helen Shaw', url: 'https://www.newyorker.com/b.html' },
  ];
  const set = ourUrlsFor(reviews, 'Jesse Green');
  assert.deepEqual([...set], ['nytimes.com/a.html']);
});

test('mergeArticlesBySource collects sources and keeps latest date', () => {
  const articles = [
    { url: 'https://vulture.com/article/x.html', title: 'X review', date: '2026-01-01', source: 'muckrack' },
    { url: 'https://vulture.com/article/x.html', title: 'X review', date: '2026-01-05', source: 'vulture' },
  ];
  const map = mergeArticlesBySource(articles);
  const entry = map.get('vulture.com/article/x.html');
  assert.deepEqual(entry.sources, ['muckrack', 'vulture']);
  assert.equal(entry.date, '2026-01-05');
});

test('computeCriticCoverage flags review-looking articles we do not have', () => {
  const reviews = [
    { criticName: 'Sara Holdren', url: 'https://www.vulture.com/article/already-have-review.html' },
  ];
  const external = [
    { url: 'https://www.vulture.com/article/already-have-review.html', title: 'Already Have: Review', date: '2026-01-01', source: 'vulture' },
    { url: 'https://www.vulture.com/article/missing-show-review.html', title: 'Missing Show: A Review', date: '2026-02-01', source: 'vulture' },
    { url: 'https://www.vulture.com/article/best-theater-of-2026.html', title: 'Best Theater of 2026', date: '2026-02-01', source: 'vulture' },
  ];
  const result = computeCriticCoverage(reviews, 'Sara Holdren', external);
  assert.equal(result.externalCount, 3);
  assert.equal(result.ourCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.missing[0].url, 'https://www.vulture.com/article/missing-show-review.html');
});

test('computeCriticCoverage returns no gap when we already have every review-looking article', () => {
  const reviews = [
    { criticName: 'Jesse Green', url: 'https://www.nytimes.com/2026/01/01/theater/a-review.html' },
  ];
  const external = [
    { url: 'https://www.nytimes.com/2026/01/01/theater/a-review.html', title: 'A: Review', date: '2026-01-01', source: 'nyt' },
  ];
  const result = computeCriticCoverage(reviews, 'Jesse Green', external);
  assert.equal(result.missingCount, 0);
  assert.deepEqual(result.missing, []);
});
