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
const { extractReviewUrls, looksLikeSpotlightPage, evaluateScrape, mergePicks, MAX_NEW_PER_RUN } = require('./refresh-nyt-critics-picks.js');

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


test('spotlight page is recognized; a theater section page with /theater/ links is not', () => {
  const link = '<a href="/2026/09/23/theater/the-holes-review.html">x</a>';
  assert.equal(looksLikeSpotlightPage(`<title>Theater Critic’s Picks</title>${link}`), true);
  assert.equal(looksLikeSpotlightPage(`<link rel="canonical" href="https://www.nytimes.com/spotlight/theater-critics-picks">${link}`), true);
  // Redirected to the Theater section: review links, but no spotlight marker.
  assert.equal(looksLikeSpotlightPage(`<title>Theater - The New York Times</title>${link}`), false);
  // Marker but no links (blocked/empty shell).
  assert.equal(looksLikeSpotlightPage('<title>Critic’s Picks</title>'), false);
});

test('refuses to write when page 1 errors (the 403 incident)', () => {
  const v = evaluateScrape({ urls: [], existingUrls: ['a'], firstPageError: 'HTTP 403' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /403/);
});

test('refuses to write 0 URLs even when the file is already empty', () => {
  assert.equal(evaluateScrape({ urls: [], existingUrls: [] }).ok, false);
});

test('accepts a partial scrape: merge only adds, so short is harmless (the 10-URL run)', () => {
  const existing = Array.from({ length: 100 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls: existing.slice(0, 10), existingUrls: existing }).ok, true);
});

test('refuses an implausible burst of new URLs (wrong page)', () => {
  const existing = Array.from({ length: 100 }, (_, i) => `u${i}`);
  const burst = Array.from({ length: MAX_NEW_PER_RUN + 1 }, (_, i) => `new${i}`);
  const v = evaluateScrape({ urls: burst, existingUrls: existing });
  assert.equal(v.ok, false);
  assert.match(v.reason, /new URLs/);
  // A normal week: a couple of new picks on top of the known window.
  assert.equal(evaluateScrape({ urls: [...existing.slice(2), 'new0', 'new1'], existingUrls: existing }).ok, true);
});

test('first-ever run (empty file) is not capped', () => {
  const urls = Array.from({ length: 100 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls, existingUrls: [] }).ok, true);
});

test('merge keeps picks that scrolled off the spotlight window', () => {
  const existing = ['https://www.nytimes.com/2024/04/19/theater/stereophonic-review.html', 'b'];
  const scraped = ['b', 'https://www.nytimes.com/2026/09/23/theater/the-holes-review.html'];
  const { urls, added } = mergePicks(existing, scraped);
  assert.ok(urls.includes('https://www.nytimes.com/2024/04/19/theater/stereophonic-review.html'));
  assert.deepEqual(added, ['https://www.nytimes.com/2026/09/23/theater/the-holes-review.html']);
  assert.equal(urls.length, 3);
});

test('parseMaxPages: default is the full cap, --max-pages=1 limits to page 1, junk falls back', () => {
  const { parseMaxPages, MAX_PAGES } = require('./refresh-nyt-critics-picks.js');
  assert.equal(parseMaxPages([]), MAX_PAGES);
  assert.equal(parseMaxPages(['--max-pages=1']), 1);
  assert.equal(parseMaxPages(['--max-pages=0']), MAX_PAGES);
  assert.equal(parseMaxPages(['--max-pages=abc']), MAX_PAGES);
  assert.equal(parseMaxPages(['--max-pages=999']), MAX_PAGES);
});
