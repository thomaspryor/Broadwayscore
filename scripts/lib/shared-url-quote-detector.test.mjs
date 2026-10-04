// Tests for shared-url-quote-detector.js (BRO-4594).
// Run: node --test scripts/lib/shared-url-quote-detector.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findSharedQuoteGroups, articleKey } = require('./shared-url-quote-detector.js');

const U = 'https://www.bloomberg.com/news/2011-04-26/stiller-sings-in-leaves-arianda-steals-yesterday-review.html';
const Q = 'So go for Kanin’s savvy script and for one truly inspired comic performance.';

test('flags the Bloomberg two-show case (same url, same quote)', () => {
  const g = findSharedQuoteGroups([
    { showId: 'born-yesterday-2011', url: U, llmPullQuote: Q },
    { showId: 'the-house-of-blue-leaves-2011', url: U, llmPullQuote: Q },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].records.length, 2);
});

test('different quotes per show is the healthy split, not flagged', () => {
  const g = findSharedQuoteGroups([
    { showId: 'a', url: U, llmPullQuote: Q },
    { showId: 'b', url: U, llmPullQuote: 'Edie Falco will steal your heart as Bananas.' },
  ]);
  assert.equal(g.length, 0);
});

test('a human score override on a record means it was judged per show, skipped', () => {
  const g = findSharedQuoteGroups([
    { showId: 'a', url: U, llmPullQuote: Q, humanReviewScore: 62 },
    { showId: 'b', url: U, llmPullQuote: Q },
  ]);
  assert.equal(g.length, 0);
});

test('homepage and junk urls are ignored', () => {
  assert.equal(articleKey('http://www.lightingandsoundamerica.com/'), null);
  assert.equal(articleKey('not a url'), null);
  const g = findSharedQuoteGroups([
    { showId: 'a', url: 'http://x.com/', llmPullQuote: Q },
    { showId: 'b', url: 'http://x.com/', llmPullQuote: Q },
  ]);
  assert.equal(g.length, 0);
});

test('different runs of one title are not a two-show column', () => {
  const g = findSharedQuoteGroups([
    { showId: 'a-christmas-carol-1991', url: U, llmPullQuote: Q },
    { showId: 'a-christmas-carol-2019', url: U, llmPullQuote: Q },
    { showId: '700-sundays-off-broadway-2004', url: U + 'x', llmPullQuote: Q },
    { showId: '700-sundays-2013', url: U + 'x', llmPullQuote: Q },
  ]);
  assert.equal(g.length, 0);
});

test('same show twice (two files, one url) is not a cross-show case', () => {
  const g = findSharedQuoteGroups([
    { showId: 'a', url: U, llmPullQuote: Q },
    { showId: 'a', url: U, llmPullQuote: Q },
  ]);
  assert.equal(g.length, 0);
});
