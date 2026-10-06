import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNonReviewDemotedByFreshCV, explainExclusion, isIncludableForRebuild } = require('./review-guards.js');

// BRO-3415: CV can overrule automated flags, but must preserve manual flags.
const FRESH_REVIEW_CV = {
  isNonReview: true,
  classifiedAt: '2026-09-15T16:47:00Z',
  textFetchedAt: '2026-09-15T16:00:00Z',
  contentVerification: {
    articleType: 'review',
    confidence: 'high',
    isValid: true,
    verifiedAt: '2026-09-15T17:00:00Z',
  },
};

test('fresh CV still demotes an automated non-review flag', () => {
  assert.equal(isNonReviewDemotedByFreshCV(FRESH_REVIEW_CV), true);
});

for (const [label, provenance] of [
  ['reviewer only', { manualReviewedBy: 'monitor' }],
  ['reason only', { isNonReviewReason: 'manual (not a review): forum thread' }],
  ['both markers', {
    manualReviewedBy: 'monitor',
    isNonReviewReason: 'manual (not a review): forum thread',
  }],
]) {
  test(`fresh CV preserves manual non-review flag with ${label}`, () => {
    const data = { ...FRESH_REVIEW_CV, ...provenance };
    assert.equal(isNonReviewDemotedByFreshCV(data), false);
    assert.equal(explainExclusion(data), 'nonReview');
    assert.equal(isIncludableForRebuild(data), false);
  });
}

test('empty manual provenance does not block automated demotion', () => {
  assert.equal(isNonReviewDemotedByFreshCV({
    ...FRESH_REVIEW_CV, manualReviewedBy: '', isNonReviewReason: null,
  }), true);
});

