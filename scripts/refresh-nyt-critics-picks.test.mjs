/**
 * Unit tests for scripts/refresh-nyt-critics-picks.js.
 *
 * Run: node --test scripts/refresh-nyt-critics-picks.test.mjs
 *
 * Regression: 2026-09-16 onward NYT 403'd the runner and the script wrote an
 * empty picks list, removing every Critic's Pick badge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractReviewUrls, evaluateScrape } = require('./refresh-nyt-critics-picks.js');

test('extracts relative hrefs from raw HTML', () => {
  const html = '<a href="/2026/09/23/theater/the-holes-review-max-wolf-friedlich.html">x</a>'
    + '<a href="/2026/09/23/theater/the-holes-review-max-wolf-friedlich.html">dup</a>';
  assert.deepEqual(extractReviewUrls(html), [
    'https://www.nytimes.com/2026/09/23/theater/the-holes-review-max-wolf-friedlich.html',
  ]);
});

test('extracts absolute links from proxy markdown without trailing junk', () => {
  const md = '[The Holes](https://www.nytimes.com/2026/09/23/theater/the-holes-review.html) and '
    + '[Bug](https://www.nytimes.com/2026/01/08/theater/bug-review-carrie-coon.html?smid=x)';
  assert.deepEqual(extractReviewUrls(md), [
    'https://www.nytimes.com/2026/09/23/theater/the-holes-review.html',
    'https://www.nytimes.com/2026/01/08/theater/bug-review-carrie-coon.html',
  ]);
});

test('empty or blocked page yields no URLs', () => {
  assert.deepEqual(extractReviewUrls(''), []);
  assert.deepEqual(extractReviewUrls('<html>Access Denied</html>'), []);
});

test('refuses to write when page 1 errors (the 403 incident)', () => {
  const v = evaluateScrape({ urls: [], previousCount: 100, firstPageError: 'HTTP 403' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /403/);
});

test('refuses to write 0 URLs even when the file is already empty', () => {
  assert.equal(evaluateScrape({ urls: [], previousCount: 0 }).ok, false);
});

test('refuses a scrape that shrinks the list by more than half (the 10-URL run)', () => {
  const urls = Array.from({ length: 10 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls, previousCount: 100 }).ok, false);
});

test('accepts a normal rolling-window refresh', () => {
  const urls = Array.from({ length: 98 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls, previousCount: 100 }).ok, true);
  assert.equal(evaluateScrape({ urls, previousCount: 0 }).ok, true);
});
