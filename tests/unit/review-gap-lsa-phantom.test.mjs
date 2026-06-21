/**
 * Unit tests for isReviewUrl / normalizeReviewUrl in scripts/audit-show-review-gap.js
 *
 * Regression for the LSA bare-URL phantom (2026-06-21): Show Score links the
 * Lighting & Sound America news index (http://www.lightingandsoundamerica.com/
 * news/story.asp, no ?ID=) as a generic promo on many show pages. The gap audit
 * stripped the query string from every aggregator URL, collapsing real LSA
 * reviews (story.asp?ID=…) to the same bare URL AND letting the promo through —
 * so the identical bare URL surfaced as an "uncaptured" gap in every audited
 * show. Cousin of the LSA article-extractor fix (article-extractor.js).
 *
 * Run: node --test tests/unit/review-gap-lsa-phantom.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isReviewUrl, normalizeReviewUrl } = require('../../scripts/audit-show-review-gap.js');

describe('isReviewUrl — LSA bare-index phantom', () => {
  it('REJECTS the bare LSA news index (no ?ID=) — the phantom gap', () => {
    assert.strictEqual(isReviewUrl('http://www.lightingandsoundamerica.com/news/story.asp'), false);
    assert.strictEqual(isReviewUrl('https://www.lightingandsoundamerica.com/news/story.asp'), false);
  });

  it('ACCEPTS a real LSA review (story.asp?ID=…)', () => {
    assert.ok(isReviewUrl('http://www.lightingandsoundamerica.com/news/story.asp?ID=A1234'));
  });

  it('still accepts an ordinary outlet review URL', () => {
    assert.ok(isReviewUrl('https://www.theaterscene.net/plays/broadway-plays/joe-turners-come-and-gone/victor-gluck/'));
  });
});

describe('normalizeReviewUrl — preserve LSA identity, strip everything else', () => {
  it('keeps ?ID= for LSA so the review stays distinct and ingestable', () => {
    assert.strictEqual(
      normalizeReviewUrl('http://www.lightingandsoundamerica.com/news/story.asp?ID=A1234&utm=x'),
      'http://www.lightingandsoundamerica.com/news/story.asp?ID=A1234'
    );
  });

  it('strips tracking query + fragment from a normal review URL', () => {
    assert.strictEqual(
      normalizeReviewUrl('https://variety.com/2026/legit/reviews/proof-review-123/?utm_source=x#top'),
      'https://variety.com/2026/legit/reviews/proof-review-123/'
    );
  });

  it('two distinct LSA reviews do NOT collapse to the same URL', () => {
    const a = normalizeReviewUrl('http://www.lightingandsoundamerica.com/news/story.asp?ID=A1');
    const b = normalizeReviewUrl('http://www.lightingandsoundamerica.com/news/story.asp?ID=B2');
    assert.notStrictEqual(a, b);
  });
});
