/**
 * BRO-7272 class guard: every review the BWW roundup JSON-LD path (Method 1)
 * extracts must carry the roundup's own date, marked provisional, never null.
 * The Visitors / New York Theatre Guide shipped undated because Method 1 pushed
 * entries with no publishDate (only the Method 2 supplement stamped one).
 * Fails when the roundupEntryDateFields spread is removed from Method 1.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractBWWRoundupReviews } = require('../gather-reviews.js');

const URL_ = 'https://www.broadwayworld.com/article/Review-Roundup-THE-VISITORS-20261109';

function html(ld) {
  return `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
}

test('live-blog entries inherit the roundup datePublished as a provisional date', () => {
  const reviews = extractBWWRoundupReviews(html({
    '@type': 'LiveBlogPosting',
    datePublished: '2026-11-10T15:00:00-05:00',
    liveBlogUpdate: [{
      '@type': 'BlogPosting',
      author: { '@type': 'Person', name: 'New York Theatre Guide - Allison Considine' },
      headline: 'New York Theatre Guide - The Visitors review',
      articleBody: 'Its humor and heart speak to the complexity of belonging to a family.',
    }],
  }), 'the-visitors-off-broadway-2026', URL_);
  assert.strictEqual(reviews.length, 1);
  assert.ok(reviews[0].publishDate, 'Method 1 entry must not have a null publishDate');
  assert.strictEqual(reviews[0].dateSource, 'roundup-article');
});

test('standalone BlogPosting entries use their own datePublished', () => {
  const reviews = extractBWWRoundupReviews(html({
    '@type': 'BlogPosting',
    datePublished: '2026-11-09T21:00:00-05:00',
    author: { '@type': 'Person', name: 'TheaterMania - Zachary Stewart' },
    headline: 'TheaterMania - The Visitors review',
    articleBody: 'A dark comedy about siblings.',
  }), 'the-visitors-off-broadway-2026', URL_);
  assert.strictEqual(reviews.length, 1);
  assert.match(reviews[0].publishDate, /^2026-11-(09|10)/);
});
