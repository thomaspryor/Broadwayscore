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

  it('a wrongProduction:true file with a manual clear is NOT bucketed already-excluded (matches isEffectivelyWrongProductionOrShow, which the rebuild actually includes)', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'review',
      wrongProduction: true,
      wrongProductionManualClear: true,
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    // Lands in 'unaudited', not 'wrong-show-suspect': isReviewTypeWrongShowGap
    // (nonreview-contenttype-wrongshow.js) has its OWN raw `wrongProduction
    // === true` check, unaware of wrongProductionManualClear — a separate,
    // pre-existing predicate this ticket doesn't touch. 'unaudited' is the
    // honest outcome: neither existing bucket confidently classifies it, so
    // it surfaces for human review rather than being silently miscategorized
    // as already-handled.
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'unaudited');
  });

  it('a high-confidence contentVerification.wrongArticle:true file is bucketed already-excluded', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'feature',
      contentVerification: { wrongArticle: true, confidence: 'high' },
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('a LOW-confidence wrongArticle:true file is NOT bucketed already-excluded (matches isRejectedNonReview/isIncludableForRebuild, which only gate on high confidence)', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'feature',
      contentVerification: { wrongArticle: true, confidence: 'low' },
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'unaudited');
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

  it('a garbage_text rejection WITH a structural (markup) star score is NOT bucketed already-excluded (matches isRejectedNonReview\'s hasStructuralStarScore carve-out)', () => {
    const fixture = {
      isNonReview: true,
      nonReviewType: 'none',
      rejectionReason: 'garbage_text',
      scoreSource: 'wos-star-images',
      originalScoreNormalized: 80,
      url: 'https://example.com/theatre-review-some-show',
      fullText: LONG_TEXT,
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'unaudited');
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

  it('a parked-domain chrome dump (no substantial review content) is bucketed already-excluded', () => {
    // No theater keywords, so hasSubstantialReviewContent stays false and the
    // real isGarbageContent() gate (content-quality.js) is free to fire on the
    // buried parked-domain marker — mirrors the real theaternewsonline.com
    // corpus hits, which are pure sale-page boilerplate with zero review prose.
    const fixture = {
      isNonReview: true,
      nonReviewType: 'news',
      url: 'https://example.com/theatre-review-some-show',
      // Marker near the front, matching the real corpus shape (parking-page
      // sites lead with the sale pitch) — isGarbageContent's trailing-junk
      // exception deliberately does NOT fire on a buried/leading marker, only
      // on a marker in the trailing footer of an otherwise-real page.
      fullText: 'The domain name theaternewsonline.com is for sale! Premium Verified Domain. Get a price in less than 24 hours. '
        + 'This page has moved to a new location. Please update your bookmarks accordingly. '.repeat(40),
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'already-excluded');
  });

  it('a genuine review whose FOOTER mentions cookies is NOT bucketed already-excluded (isGarbageContent requires no substantial review content)', () => {
    // Same marker family as STRONG_CHROME_DUMP_PATTERNS, but this text has
    // real theater-keyword-dense review prose ahead of the trailing footer —
    // isGarbageContent() must not condemn it. Regression for the ship-check
    // finding: detectStrongChromeDumpAnywhere() alone (no substantial-content
    // gate) would have wrongly flagged this.
    const fixture = {
      isNonReview: true,
      nonReviewType: 'feature',
      url: 'https://example.com/theatre-review-some-show',
      fullText: 'This production, this performance, this show, this play, this musical, this theater, this drama, this stage direction and this cast deliver a genuinely gripping night of theater. '.repeat(30)
        + ' Please manage cookie preferences before continuing to browse this site.',
    };
    assert.equal(bucketSlugCoverageHit(fixture, 'x'), 'unaudited');
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
