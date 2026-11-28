/**
 * Unit tests for isReviewTypeWrongShowGap (BRO-3862).
 *
 * Logic is require()'d from scripts/lib/nonreview-contenttype-wrongshow.js —
 * never copied (CLAUDE.md §15).
 *
 * Fixtures are the pre-fix shape of real corpus instances found 2026-09-20
 * (see that module's header comment for the full investigation).
 *
 * Run: node --test tests/unit/nonreview-contenttype-wrongshow.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isReviewTypeWrongShowGap } = require('../../scripts/lib/nonreview-contenttype-wrongshow');

const BASE = {
  isNonReview: true,
  nonReviewType: 'review',
  nonReviewClassifiedBy: 'gemini',
};

describe('isReviewTypeWrongShowGap — confirmed real-corpus gaps match', () => {
  it('wicked-2003/nytimes--ben-brantley.json (Omnium Gatherum misattribution) matches', () => {
    const fixture = { ...BASE, url: 'http://www.nytimes.com/2003/10/31/movies/theater-review-there-s-trouble-in-emerald-city.html', llmScore: { score: 79 } };
    assert.equal(isReviewTypeWrongShowGap(fixture), true);
  });

  it('a Variety film review filed under a Broadway show matches', () => {
    const fixture = { ...BASE, url: 'https://variety.com/2010/film/reviews/the-recipe-1117943877/', assignedScore: 74 };
    assert.equal(isReviewTypeWrongShowGap(fixture), true);
  });
});

describe('isReviewTypeWrongShowGap — already-handled files do not match', () => {
  it('isNonReview:false is not a candidate at all', () => {
    assert.equal(isReviewTypeWrongShowGap({ ...BASE, isNonReview: false }), false);
  });

  it('nonReviewType other than review is not a candidate', () => {
    assert.equal(isReviewTypeWrongShowGap({ ...BASE, nonReviewType: 'preview' }), false);
  });

  it('already wrongShow:true (promoted via a separate CV pass) is skipped', () => {
    assert.equal(isReviewTypeWrongShowGap({ ...BASE, wrongShow: true }), false);
  });

  it('already wrongProduction:true is skipped — same exclusion bar as audit-cross-show-url.js', () => {
    // hamilton-west-end-2021/whatsonstage--rachel-agyekum.json shape: caught by
    // a different audit via wrongProduction, fullText already cleared to null.
    const fixture = { ...BASE, url: null, fullText: null, wrongProduction: true, wrongShowReason: 'Marie and Rosetta review incorrectly assigned by SERP' };
    assert.equal(isReviewTypeWrongShowGap(fixture), false);
  });

  it('human-cleared via wrongShowManualClear is skipped', () => {
    assert.equal(isReviewTypeWrongShowGap({ ...BASE, wrongShowManualClear: true }), false);
  });

  it('a garbage_text rejectionReason (extraction failure, not cross-show content) is skipped', () => {
    // la-cage-aux-folles-2010/broadwayworld--michael-dale.json shape: fullText
    // is BWW site chrome, not review prose of ANY show. The classifier's
    // 'review' contentType label here is itself the false signal.
    const fixture = { ...BASE, url: 'https://www.broadwayworld.com/showtime/viewblog.cfm?blogid=2750', rejectionReason: 'garbage_text', contentTier: 'complete' };
    assert.equal(isReviewTypeWrongShowGap(fixture), false);
  });

  it('a high-confidence contentVerification.wrongArticle is skipped (already caught by a different pass)', () => {
    const fixture = { ...BASE, contentVerification: { wrongArticle: true, confidence: 'high' } };
    assert.equal(isReviewTypeWrongShowGap(fixture), false);
  });

  it('missing data does not throw', () => {
    assert.equal(isReviewTypeWrongShowGap(null), false);
    assert.equal(isReviewTypeWrongShowGap(undefined), false);
  });
});
