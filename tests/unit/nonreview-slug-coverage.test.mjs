/**
 * Unit tests for the isNonReview + 400w + review-URL-slug coverage bucketing
 * (BRO-3862). Logic is require()'d from scripts/lib/nonreview-slug-coverage.js
 * — never copied (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/nonreview-slug-coverage.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  hasReviewUrlSlug,
  isSlugCoverageCandidate,
  bucketSlugCoverageHit,
} = require('../../scripts/lib/nonreview-slug-coverage');

const LONG_TEXT = 'This production runs long and has plenty of words in it to satisfy the corpus threshold. '.repeat(50);

describe('hasReviewUrlSlug', () => {
  it('matches a URL with "review" in the path', () => {
    assert.equal(hasReviewUrlSlug('https://www.dailymail.co.uk/home/event/article-1/PATRICK-MARMION-reviews-Man-Man-Royal-Court-Theatre.html'), true);
  });

  it('does not match a domain that merely contains "review" in its name', () => {
    assert.equal(hasReviewUrlSlug('https://nystagereview.com/2026/08/11/an-american-daughter/'), false);
  });

  it('does not match the bare /reviews/ index page (the ticket-named false positive)', () => {
    assert.equal(hasReviewUrlSlug('https://www.broadwayworld.com/reviews/'), false);
  });

  it('does not match a roundup-hub page even if the path says review', () => {
    assert.equal(hasReviewUrlSlug('https://www.broadwayworld.com/article/BWW-Review-Roundup-SOME-SHOW-20260101'), false);
  });

  it('returns false for a missing/malformed url', () => {
    assert.equal(hasReviewUrlSlug(null), false);
    assert.equal(hasReviewUrlSlug(''), false);
    assert.equal(hasReviewUrlSlug('not a url'), false);
  });
});

describe('isSlugCoverageCandidate', () => {
  const base = { isNonReview: true, url: 'https://example.com/theatre-review-some-show', fullText: LONG_TEXT };

  it('matches isNonReview:true + 400w + review slug', () => {
    assert.equal(isSlugCoverageCandidate(base), true);
  });

  it('excludes isNonReview:false', () => {
    assert.equal(isSlugCoverageCandidate({ ...base, isNonReview: false }), false);
  });

  it('excludes short text', () => {
    assert.equal(isSlugCoverageCandidate({ ...base, fullText: 'Too short.' }), false);
  });

  it('excludes a non-review-shaped URL', () => {
    assert.equal(isSlugCoverageCandidate({ ...base, url: 'https://example.com/news/some-show-cast-announced' }), false);
  });
});

describe('bucketSlugCoverageHit', () => {
  it('returns null for a non-candidate', () => {
    assert.equal(bucketSlugCoverageHit({ isNonReview: false }, 'x'), null);
  });

  it('buckets a nonReviewType=review file as wrong-show-suspect', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'review',
      url: 'https://variety.com/2010/film/reviews/the-recipe-1117943877/',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'bloody-bloody-andrew-jackson-2010'), 'wrong-show-suspect');
  });

  it('an already-promoted wrongShow file is bucketed already-excluded, not re-flagged', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'review',
      wrongShow: true,
      url: 'https://variety.com/2010/film/reviews/the-recipe-1117943877/',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('a wrongProduction:true file is bucketed already-excluded, not unaudited', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'review',
      wrongProduction: true,
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('a contentVerification.wrongArticle:true file is bucketed already-excluded', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'feature',
      contentVerification: { wrongArticle: true },
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('a garbage_text rejectionReason file is bucketed already-excluded', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'none',
      rejectionReason: 'garbage_text',
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('an invalid contentTier file is bucketed already-excluded', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'none',
      contentTier: 'invalid',
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('a parked-domain chrome dump is bucketed already-excluded', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'news',
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT + ' The domain name theaternewsonline.com is for sale. ',
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('buckets a confirmed essay-intro false positive as essay-intro-fp', () => {
    const bioIntro = 'Dolly Rebecca Parton is an American singer, songwriter, musician, actress, and philanthropist. '.repeat(3);
    const body = 'ABOUT THE MUSICAL Directed by Tony Award winner Bartlett Sher, DOLLY: A True Original Musical premiered at the Fisher Center for the Performing Arts at Belmont University in Nashville. '
      + 'The cast delivers performances that remain faithful to the essence of each character. '.repeat(30)
      + 'A production filled with music, emotion, and talent that no theater lover should miss.';
    const fixture = {
      showTitle: 'Dolly: A True Original Musical',
      venue: 'Fisher Center for the Performing Arts, Nashville, TN',
      isNonReview: true,
      nonReviewType: 'preview',
      url: 'https://example.com/theatre-review-dolly',
      fullText: bioIntro + body,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'dolly-a-true-original-musical-regional-2025'), 'essay-intro-fp');
  });

  it('an unrecognized nonReviewType with no matching predicate buckets as unaudited', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'feature',
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'unaudited');
  });
});
