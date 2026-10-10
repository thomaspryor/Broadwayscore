import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Notion 34e637c5-416f-817b: the LLM scoring path used to blanket-block any
// file with isRoundupArticle=true, even when the flag was stale on a file
// that's actually an individual review (URL pattern + substantial fullText).
// This caused silent skips on Stuart King's John Proctor file after the
// contaminated lboRoundupExcerpt got auto-classified as a roundup.
//
// The fix: scripts/llm-scoring/is-scoreable.ts now exempts via
// isLikelyStaleRoundupFlag(). This test pins both branches.

const { isScoreable } = require('../../scripts/llm-scoring/is-scoreable.ts');

const baseLBOIndividual = {
  outlet: 'London Box Office',
  url: 'https://www.londonboxoffice.co.uk/news/post/royal-court-john-proctor-review',
  fullText: 'A'.repeat(3500),
  isFullReview: true,
  contentTier: 'complete',
};

describe('LLM is-scoreable + stale isRoundupArticle exemption', () => {
  test('without isRoundupArticle: scoreable', () => {
    assert.strictEqual(isScoreable({ ...baseLBOIndividual }), true);
  });

  test('isRoundupArticle=true on individual LBO review URL: stale flag, still scoreable', () => {
    const data = { ...baseLBOIndividual, isRoundupArticle: true };
    assert.strictEqual(isScoreable(data), true,
      'scorer must respect the stale-flag exemption');
  });

  test('isRoundupArticle=true on actual roundup URL (The Stage): NOT stale, blocked', () => {
    // The Stage's /review-round-ups/ pattern is explicitly listed in isRoundupUrl
    // — should be blocked even with substantial fullText.
    const data = {
      outlet: 'The Stage',
      url: 'https://www.thestage.co.uk/review-round-ups/some-show-review-round-up',
      fullText: 'A'.repeat(3500),
      isFullReview: true,
      contentTier: 'complete',
      isRoundupArticle: true,
    };
    assert.strictEqual(isScoreable(data), false);
  });

  test('isRoundupArticle=true with no fullText: blocked (cannot be a real review)', () => {
    const data = {
      outlet: 'London Box Office',
      url: 'https://www.londonboxoffice.co.uk/news/post/some-review',
      fullText: '',
      isRoundupArticle: true,
    };
    assert.strictEqual(isScoreable(data), false);
  });

  test('isRoundupArticle=true on Clyde Fitch Report individual post: scoreable', () => {
    const data = {
      outlet: 'The Clyde Fitch Report',
      url: 'https://www.clydefitchreport.com/2024/03/some-review-slug/',
      fullText: 'A'.repeat(2000),
      isFullReview: true,
      contentTier: 'complete',
      isRoundupArticle: true,
    };
    assert.strictEqual(isScoreable(data), true);
  });

  test('hard blockers still win over stale-flag exemption (wrongShow)', () => {
    const data = {
      ...baseLBOIndividual,
      isRoundupArticle: true,
      wrongShow: true,
    };
    assert.strictEqual(isScoreable(data), false,
      'wrongShow blocks even stale-flag-exempt files');
  });
});
