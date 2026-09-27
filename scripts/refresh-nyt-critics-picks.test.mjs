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
const { extractReviewUrls, evaluateScrape, mergePicks, baselineFromFile } = require('./refresh-nyt-critics-picks.js');

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
  const v = evaluateScrape({ urls: [], baselineCount: 100, firstPageError: 'HTTP 403' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /403/);
});

test('refuses to write 0 URLs even when the file is already empty', () => {
  assert.equal(evaluateScrape({ urls: [], baselineCount: 0 }).ok, false);
});

test('refuses a scrape that shrinks the list by more than half (the 10-URL run)', () => {
  const urls = Array.from({ length: 10 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls, baselineCount: 100 }).ok, false);
});

test('accepts a normal rolling-window refresh', () => {
  const urls = Array.from({ length: 98 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls, baselineCount: 100 }).ok, true);
  assert.equal(evaluateScrape({ urls, baselineCount: 0 }).ok, true);
});

test('merge keeps picks that scrolled off the spotlight window', () => {
  const existing = ['https://www.nytimes.com/2024/04/19/theater/stereophonic-review.html', 'b'];
  const scraped = ['b', 'https://www.nytimes.com/2026/09/23/theater/the-holes-review.html'];
  const { urls, added } = mergePicks(existing, scraped);
  assert.ok(urls.includes('https://www.nytimes.com/2024/04/19/theater/stereophonic-review.html'));
  assert.deepEqual(added, ['https://www.nytimes.com/2026/09/23/theater/the-holes-review.html']);
  assert.equal(urls.length, 3);
});

test('shrink baseline is the last scrape, not the accumulated list', () => {
  const many = Array.from({ length: 300 }, (_, i) => `u${i}`);
  assert.equal(baselineFromFile({ _meta: { lastScrapeCount: 100 }, urls: many }), 100);
  // Legacy file without lastScrapeCount: cap at the 100-item window.
  assert.equal(baselineFromFile({ _meta: {}, urls: many }), 100);
  assert.equal(baselineFromFile({ urls: ['a', 'b'] }), 2);
  assert.equal(baselineFromFile(null), 0);
});
