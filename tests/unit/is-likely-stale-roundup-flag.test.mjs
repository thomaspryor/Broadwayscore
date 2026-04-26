/**
 * Unit tests for review-guards.js — isLikelyStaleRoundupFlag
 *
 * Regression for Notion 34e637c5-416f-817b: a stale isRoundupArticle=true flag
 * was silently dropping legitimate individual reviews from the LLM rescore and
 * the rebuild. The flag had been set by older code paths (URL-pattern matching,
 * known-roundup-outlet auto-tag) but the file actually contained a substantial
 * individual critic review with an URL on the outlet's own per-post path.
 *
 * The helper identifies these stale flags so gate predicates can override them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isLikelyStaleRoundupFlag } = require('../../scripts/lib/review-guards.js');
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const { passesFlagFilters } = require('../../scripts/lib/review-text-scoreable.js');

const longReviewText = 'A real critic review with substance. '.repeat(40); // ~1480 chars

describe('isLikelyStaleRoundupFlag', () => {
  test('JP Stuart King regression — long fullText + isFullReview + LBO individual URL', () => {
    const data = {
      isRoundupArticle: true,
      roundupArticleReason: 'LBO review roundup — aggregates other critics scores, not an original review',
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.londonboxoffice.co.uk/news/post/royal-court-john-proctor-review',
      lboRoundupExcerpt: 'borrowed Paddington content from cross-show contamination',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), true,
      'real review with poisoned excerpt must be detected as stale flag');
  });

  test('Clyde Fitch individual review — known-roundup-outlet but per-post URL', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'http://www.clydefitchreport.com/2015/07/amazing-grace-gospel-hymn-broadway/',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), true,
      'individual blog post on known-roundup-outlet domain must override flag');
  });

  test('flag is correct on actual LBO roundup page URL — must not be cleared', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.londonboxoffice.co.uk/news/post/some-show-review-roundup',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false,
      'genuine LBO roundup-page URL must retain the flag');
  });

  test('flag is correct on BWW Review-Roundup page — must not be cleared', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.broadwayworld.com/article/Review-Roundup-John-Proctor-Opens-on-Broadway-20260415',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false,
      'BWW Review-Roundup article URL must retain the flag');
  });

  test('flag is correct on The Stage round-ups page — must not be cleared', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.thestage.co.uk/review-round-ups/john-proctor-is-the-villain',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false);
  });

  test('short fullText — flag may be legitimate, do not override', () => {
    const data = {
      isRoundupArticle: true,
      fullText: 'Brief excerpt only, less than 800 chars',
      isFullReview: true,
      url: 'https://www.londonboxoffice.co.uk/news/post/some-show-review',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false);
  });

  test('Playbill critics-think-of roundup URL — must not be cleared', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.playbill.com/article/reviews-what-do-the-critics-think-of-broadways-death-of-a-salesman',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false,
      'Playbill multi-critic roundup URL must not pass the whitelist');
  });

  test('outlet not on individual-review whitelist — not cleared even with long text', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.nytimes.com/2026/02/19/theater/dinosaurs-blackout-songs-reservoir-anonymous.html',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false,
      'NYT URL not on whitelist — flag stays even though URL is not on isRoundupUrl list');
  });

  test('isFullReview=false — flag may be legitimate, do not override', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: false,
      url: 'https://www.londonboxoffice.co.uk/news/post/some-show-review',
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false);
  });

  test('no URL — cannot verify individual-review pattern, do not override', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: null,
    };
    assert.strictEqual(isLikelyStaleRoundupFlag(data), false);
  });

  test('isRoundupArticle is not true — predicate is false trivially', () => {
    assert.strictEqual(isLikelyStaleRoundupFlag({ isRoundupArticle: false }), false);
    assert.strictEqual(isLikelyStaleRoundupFlag({}), false);
    assert.strictEqual(isLikelyStaleRoundupFlag(null), false);
  });
});

describe('isScoreable — stale roundup flag override', () => {
  test('JP Stuart King regression — file is scoreable despite stale flag', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.londonboxoffice.co.uk/news/post/royal-court-john-proctor-review',
      contentTier: 'complete',
    };
    assert.strictEqual(isScoreable(data), true,
      'LLM rescore must NOT skip this file');
  });

  test('genuine roundup page is still excluded', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.thestage.co.uk/review-round-ups/spring-2026-roundup',
      contentTier: 'complete',
    };
    assert.strictEqual(isScoreable(data), false);
  });
});

describe('passesFlagFilters — stale roundup flag override', () => {
  test('JP Stuart King regression — file passes flag filters', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://www.londonboxoffice.co.uk/news/post/royal-court-john-proctor-review',
      contentTier: 'complete',
    };
    assert.strictEqual(passesFlagFilters(data), true);
  });

  test('genuine roundup page still excluded by passesFlagFilters', () => {
    const data = {
      isRoundupArticle: true,
      fullText: longReviewText,
      isFullReview: true,
      url: 'https://westendtheatre.com/some-show/reviews/',
      contentTier: 'complete',
    };
    assert.strictEqual(passesFlagFilters(data), false);
  });
});
