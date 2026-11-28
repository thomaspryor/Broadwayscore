/**
 * Regression tests for the Unknown-critic stub triage classification (2026-06-21).
 *
 * The original triage deleted real scored reviews because: (a) aggregator-URL
 * mismatch force-deleted files regardless of value, (b) EXCERPT_FIELDS was
 * missing showScoreExcerpt/stagedoorExcerpt/lboRoundupExcerpt, and (c) the
 * non-review-URL regex matched real review slugs (closing/announce//news/). These
 * tests lock in the corrected, value-first behavior.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const T = require('../../scripts/triage-unknown-critic-stubs.js');
const { isContentless, isNonReviewUrl, hasExcerpt, isUnknownCritic, EXCERPT_FIELDS } = T;

describe('isContentless — value-first (never lose a scored review)', () => {
  test('any score signal → NOT contentless', () => {
    assert.equal(isContentless({ originalScore: '5/5 stars' }), false);
    assert.equal(isContentless({ assignedScore: 77 }), false);
    assert.equal(isContentless({ llmScore: { score: 80 } }), false);
    assert.equal(isContentless({ aggregatorStars: '4/5' }), false);
    assert.equal(isContentless({ dtliThumb: 'Up' }), false);
  });

  test('aggregator-specific excerpts count as content (the missing-field bug)', () => {
    const long = 'x'.repeat(60);
    assert.equal(isContentless({ showScoreExcerpt: long }), false);
    assert.equal(isContentless({ stagedoorExcerpt: long }), false);
    assert.equal(isContentless({ lboRoundupExcerpt: long }), false);
    assert.equal(isContentless({ dtliExcerpt: long }), false);
  });

  test('EXCERPT_FIELDS includes the previously-missing aggregator excerpt fields', () => {
    for (const f of ['showScoreExcerpt', 'stagedoorExcerpt', 'lboRoundupExcerpt']) {
      assert.ok(EXCERPT_FIELDS.includes(f), `missing ${f}`);
    }
  });

  test('real review body → NOT contentless', () => {
    assert.equal(isContentless({ fullText: 'A'.repeat(300) }), false);
  });

  test('genuinely empty husk → contentless', () => {
    assert.equal(isContentless({ url: 'https://example.com/x' }), true);
    assert.equal(isContentless({}), true);
  });
});

describe('isNonReviewUrl — only social/video hosts, never review slugs', () => {
  test('social/video hosts → true', () => {
    assert.equal(isNonReviewUrl('https://www.facebook.com/Playbill/posts/123'), true);
    assert.equal(isNonReviewUrl('https://youtube.com/watch?v=x'), true);
    assert.equal(isNonReviewUrl('https://x.com/foo/status/1'), true);
  });

  test('real review URLs with scary slug words → false (no over-match)', () => {
    assert.equal(isNonReviewUrl('https://www.whatsonstage.com/news/review-of-hamlet_123'), false);
    assert.equal(isNonReviewUrl('https://www.theguardian.com/stage/2026/the-closing-doors-review'), false);
    assert.equal(isNonReviewUrl('https://example.com/first-look-review'), false);
    assert.equal(isNonReviewUrl('https://example.com/announce-winner-review'), false);
  });

  test('unparseable / empty → false', () => {
    assert.equal(isNonReviewUrl(''), false);
    assert.equal(isNonReviewUrl(null), false);
    assert.equal(isNonReviewUrl('not a url'), false);
  });
});

describe('isUnknownCritic', () => {
  test('blank/Unknown/Unnamed → true; real name → false', () => {
    assert.equal(isUnknownCritic({ criticName: 'Unknown' }), true);
    assert.equal(isUnknownCritic({ criticName: '' }), true);
    assert.equal(isUnknownCritic({}), true);
    assert.equal(isUnknownCritic({ criticName: 'Unnamed' }), true);
    assert.equal(isUnknownCritic({ criticName: 'Ben Brantley' }), false);
  });
});
