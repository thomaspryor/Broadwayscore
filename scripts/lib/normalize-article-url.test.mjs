import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeArticleUrl } = require('./combined-review-utils.js');

test('BRO-6682: LSA story.asp?ID=N keeps its id so different stories never share a key', () => {
  const a = normalizeArticleUrl('https://www.lightingandsoundamerica.com/news/story.asp?ID=1111');
  const b = normalizeArticleUrl('https://www.lightingandsoundamerica.com/news/story.asp?ID=2222');
  assert.notEqual(a, b);
  assert.equal(a, 'lightingandsoundamerica.com/news/story.asp?id=1111');
});

test('same story with tracking params, fragment, www and trailing slash still collapses', () => {
  const k = normalizeArticleUrl('https://www.nytimes.com/2026/10/29/theater/the-heart-review.html');
  assert.equal(normalizeArticleUrl('http://nytimes.com/2026/10/29/theater/the-heart-review.html/?utm_source=x&smid=y#comments'), k);
  assert.equal(normalizeArticleUrl('https://lightingandsoundamerica.com/news/story.asp?utm_source=a&ID=7#x'), 'lightingandsoundamerica.com/news/story.asp?id=7');
});

test('empty input', () => { assert.equal(normalizeArticleUrl(''), null); assert.equal(normalizeArticleUrl(null), null); });

test('BRO-6682: a ~400-show combinedWith is flagged bogus, a real pair is not', async () => {
  const { isBogusCombinedFlag } = require('./combined-review-utils.js');
  assert.equal(isBogusCombinedFlag({ isCombinedReview: true, combinedWith: Array.from({ length: 400 }, (_, i) => `s${i}`) }), true);
  assert.equal(isBogusCombinedFlag({ isCombinedReview: true, combinedWith: ['lost-boys', 'schmigadoon'] }), false);
  assert.equal(isBogusCombinedFlag({ isCombinedReview: false, combinedWith: Array(50).fill('x') }), false);
});

test('affiliate-style aid param is dropped', () => {
  assert.equal(normalizeArticleUrl('https://x.com/a/review?aid=99'), 'x.com/a/review');
});
